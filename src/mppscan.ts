import { enqueueTarget, sendBoundedQueueMessages } from "./catalog";
import { recordMppScanRunService, upsertDiscoveredServiceUrl } from "./db";
import type { UrlDiscoveryMessage } from "./model";
import { MAX_DISCOVERY_BYTES, PROBE_TIMEOUT_MS, ScanSafetyError, normalizeUrl, readBoundedBody, redactText, sha256 } from "./security";

export const MPPSCAN_HOMEPAGE_URL = "https://mppscan.com/";

const MAX_EMBEDDED_ARRAYS = 8;
const MAX_EMBEDDED_ARRAY_BYTES = 512 * 1024;
const MAX_ORIGIN_URLS = 1_000;
const MAX_ORIGIN_URL_LENGTH = 2_048;
const HOMEPAGE_JITTER_SECONDS = 15 * 60;
const OPENAPI_JITTER_SECONDS = 30 * 60;

interface EmbeddedMarker {
  value: string;
  escaped: boolean;
}

const ORIGIN_URL_MARKERS: EmbeddedMarker[] = [
  { value: '\\"originUrls\\":', escaped: true },
  { value: '"originUrls":', escaped: false },
];

/**
 * Extracts the small public origin list embedded in MPPScan's anonymous HTML.
 *
 * The list currently lives inside a JSON-escaped Next.js hydration string, not
 * a documented API. Treating only exact `originUrls` arrays as input avoids
 * turning arbitrary links in the page into crawl targets. Invalid, credentialed,
 * private-literal, query-bearing, and non-HTTP(S) URLs are discarded by the
 * shared scanner URL policy.
 */
export function parseMppScanOriginUrls(html: string): string[] {
  if (new TextEncoder().encode(html).byteLength > MAX_DISCOVERY_BYTES) {
    throw new ScanSafetyError("mppscan-html-too-large", `MPPScan HTML exceeds ${MAX_DISCOVERY_BYTES} bytes`);
  }

  const candidates: string[] = [];
  let arraysSeen = 0;

  for (const marker of ORIGIN_URL_MARKERS) {
    let cursor = 0;
    while (arraysSeen < MAX_EMBEDDED_ARRAYS) {
      const markerAt = html.indexOf(marker.value, cursor);
      if (markerAt < 0) break;
      cursor = markerAt + marker.value.length;
      arraysSeen += 1;

      let arrayAt = cursor;
      while (arrayAt < html.length && /\s/.test(html[arrayAt])) arrayAt += 1;
      if (html[arrayAt] !== "[") continue;

      const values = parseStringArrayAt(html, arrayAt, marker.escaped);
      if (values) candidates.push(...values);
    }
  }

  return normalizeOriginUrls(candidates);
}

/** Fetches only MPPScan's public homepage, without cookies or credentials. */
export async function fetchMppScanOriginUrls(fetcher: typeof fetch = fetch): Promise<string[]> {
  const response = await fetcher(MPPSCAN_HOMEPAGE_URL, {
    method: "GET",
    redirect: "manual",
    headers: {
      Accept: "text/html, application/xhtml+xml;q=0.9",
      "User-Agent": "mpp.ninja-observatory/1.0 (+https://mpp.ninja/methodology)",
    },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });

  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new ScanSafetyError("mppscan-http-status", `MPPScan homepage returned ${response.status}`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    await response.body?.cancel().catch(() => undefined);
    throw new ScanSafetyError("mppscan-content-type", "MPPScan homepage did not return HTML");
  }

  const { text } = await readBoundedBody(response, MAX_DISCOVERY_BYTES);
  const origins=parseMppScanOriginUrls(text);
  // The HTML integration is deliberately fail-closed. A missing, malformed,
  // or unexpectedly empty hydration array is source unavailability, not
  // authoritative evidence that every previously listed origin disappeared.
  if(origins.length===0)throw new ScanSafetyError("mppscan-no-origin-list","MPPScan homepage contained no valid origin list");
  return origins;
}

/**
 * Schedules one bounded GET candidate probe and one bounded GET /openapi.json probe for
 * every validated base URL. Queue-level URL dedupe and deterministic jitter are
 * provided by the shared catalog enqueue path.
 */
export async function queueMppScanDiscovery(env: Env, originUrls: readonly string[], observedAt:string,discoveryRunId:string): Promise<{ origins: number; queued: number }> {
  const normalized = normalizeOriginUrls(originUrls);
  if(normalized.length===0)throw new ScanSafetyError("mppscan-no-origin-list","MPPScan homepage contained no valid origin list");
  const messages:UrlDiscoveryMessage[]=normalized.map((url)=>({type:"url-discovery",url,source:"mppscan",sourceUrl:MPPSCAN_HOMEPAGE_URL,observedAt,discoveryRunId}));
  const activated=await env.DB.prepare("UPDATE discovery_runs SET status='processing',expected_services=?,discovered_services=?,error_detail=NULL WHERE id=? AND source_kind='mppscan-html' AND source_url=? AND started_at=? AND status='running' RETURNING id").bind(normalized.length,normalized.length,discoveryRunId,MPPSCAN_HOMEPAGE_URL,observedAt).first<{id:string}>();
  if(!activated)throw new ScanSafetyError("invalid-mppscan-run","MPPScan discovery run could not enter its processing barrier");
  await sendBoundedQueueMessages(env.CRAWL_QUEUE,messages);
  return { origins: normalized.length, queued:messages.length };
}

export async function processMppScanCandidate(env:Env,message:UrlDiscoveryMessage):Promise<void>{
  const run=await env.DB.prepare("SELECT source_url,started_at,status FROM discovery_runs WHERE id=? AND source_kind='mppscan-html'").bind(message.discoveryRunId).first<{source_url:string;started_at:string;status:string}>();
  if(!run||run.source_url!==message.sourceUrl||run.started_at!==message.observedAt)throw new ScanSafetyError("invalid-mppscan-run","MPPScan Queue message does not match an active discovery run");
  if(run.status!=="processing")return;
  const serviceId=await upsertDiscoveredServiceUrl(env.DB,message.url,message.source,message.sourceUrl,message.observedAt);
  const provenance={sourceType:"mppscan" as const,sourceRef:message.sourceUrl,observedAt:message.observedAt};
  await enqueueTarget(env,{type:"probe",url:message.url,serviceId,kind:"endpoint",source:"mppscan"},HOMEPAGE_JITTER_SECONDS,false,provenance);
  await enqueueTarget(env,{type:"probe",url:openApiUrl(message.url),serviceId,kind:"openapi",source:"mppscan"},OPENAPI_JITTER_SECONDS,false,provenance);
  await enqueueTarget(env,{type:"probe",url:new URL("/.well-known/api-catalog",message.url).toString(),serviceId,kind:"api-catalog",source:"mppscan"},OPENAPI_JITTER_SECONDS,false,provenance);
  // Close the race in which a newer run completes between this older
  // message's initial status check and its target writes. If the newer run
  // included this service, its provenance has a newer observed_at and is left
  // active; if it omitted the service, these delayed writes are retired.
  await env.DB.prepare(`UPDATE crawl_target_sources
    SET active=0,observed_at=(
      SELECT MAX(newer.started_at) FROM discovery_runs newer
      WHERE newer.source_kind='mppscan-html' AND newer.source_url=?
        AND newer.started_at>? AND newer.status='complete'
    )
    WHERE source_type='mppscan' AND source_ref=? AND active=1 AND observed_at<=?
      AND target_id IN (SELECT id FROM crawl_targets WHERE service_id=?)
      AND EXISTS (
        SELECT 1 FROM discovery_runs newer
        WHERE newer.source_kind='mppscan-html' AND newer.source_url=?
          AND newer.started_at>? AND newer.status='complete'
      )`).bind(message.sourceUrl,message.observedAt,message.sourceUrl,message.observedAt,serviceId,message.sourceUrl,message.observedAt).run();
  await recordMppScanRunService(env.DB,message.discoveryRunId,serviceId,message.observedAt);
}

/** Fetches the anonymous HTML source and schedules its safe discovery probes. */
export async function importMppScan(env: Env, fetcher: typeof fetch = fetch,now=new Date().toISOString()): Promise<{ origins: number; queued: number }> {
  const runId=await sha256(`mppscan|${now}`);
  await env.DB.prepare("INSERT INTO discovery_runs (id,source_kind,source_url,started_at,status) VALUES (?,?,?,?,'running')").bind(runId,"mppscan-html",MPPSCAN_HOMEPAGE_URL,now).run();
  try{
    return await queueMppScanDiscovery(env,await fetchMppScanOriginUrls(fetcher),now,runId);
  }catch(error){
    await env.DB.prepare("UPDATE discovery_runs SET finished_at=?,status='failed',error_detail=? WHERE id=? AND status IN ('running','processing')").bind(new Date().toISOString(),error instanceof Error?redactText(error.message).slice(0,500):"unknown",runId).run();
    throw error;
  }
}

function parseStringArrayAt(source: string, start: number, escaped: boolean): string[] | null {
  const limit = Math.min(source.length, start + MAX_EMBEDDED_ARRAY_BYTES);
  let closeAt = start;

  // Trying successive closing brackets is both bounded and resilient to a `]`
  // inside an encoded URL: incomplete candidates fail JSON parsing, while the
  // complete array succeeds. The expected value is a flat string array.
  for (let attempts = 0; attempts < 64; attempts += 1) {
    closeAt = source.indexOf("]", closeAt + 1);
    if (closeAt < 0 || closeAt >= limit) return null;
    const fragment = source.slice(start, closeAt + 1);

    try {
      if (escaped && /[\u0000-\u001f]/.test(fragment)) return null;
      const decoded = escaped ? JSON.parse(`"${fragment}"`) : fragment;
      if (typeof decoded !== "string") return null;
      const parsed: unknown = JSON.parse(decoded);
      if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) continue;
      return parsed;
    } catch {
      // A bracket may belong to a URL string. Continue to the next bounded one.
    }
  }

  return null;
}

function normalizeOriginUrls(values: readonly string[]): string[] {
  const normalized = new Set<string>();

  for (const value of values) {
    if (value.length === 0 || value.length > MAX_ORIGIN_URL_LENGTH) continue;
    try {
      const supplied = new URL(value.trim());
      if (supplied.search || supplied.hash) continue;
      const url = new URL(normalizeUrl(value));
      normalized.add(url.toString());
      if (normalized.size > MAX_ORIGIN_URLS) {
        throw new ScanSafetyError("mppscan-too-many-origins", `MPPScan supplied more than ${MAX_ORIGIN_URLS} origins`);
      }
    } catch (error) {
      if (error instanceof ScanSafetyError && error.code === "mppscan-too-many-origins") throw error;
      // A public feed is untrusted input; one invalid candidate must not abort it.
    }
  }

  return Array.from(normalized);
}

function openApiUrl(originUrl: string): string {
  const base = new URL(originUrl);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return normalizeUrl(new URL("openapi.json", base).toString());
}
