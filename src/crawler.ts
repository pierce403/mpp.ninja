import { offerStatements, reconcileSourceSnapshot, recordSourceSnapshotItem, sourceSnapshotItemProcessed, stageOpenApiServiceInfo, startSourceSnapshot, upsertOpenApiOperation } from "./db";
import { crawlTargetId, enqueueCompletedSnapshotTargets, enqueueTarget, sendBoundedQueueMessages, serviceTargetMatchesHostname } from "./catalog";
import { MAX_UNCONFIRMED_MANUAL_ATTEMPTS } from "./budgets";
import { challengeToOffer, economicRiskMetadata, fingerprintImplementation, ingestApiCatalog, ingestOpenApi, isSupportedApiCatalogDocument, isSupportedOpenApiDocument, isValidPaymentChallenge, parsePaymentChallenges } from "./mpp";
import type { ApiCatalogLinkMessage, CrawlMessage, Fingerprint, IngestedOperation, OpenApiOperationMessage, ProbeResult, SecurityState } from "./model";
import { MAX_DISCOVERY_BYTES, MAX_REDIRECTS, MAX_RESPONSE_BYTES, PROBE_TIMEOUT_MS, ScanSafetyError, normalizeDiscoveryUrl, normalizeUrl, readBoundedBody, redactHeaders, redactJsonValue, redactUrlForStorage, resolvePublicHostname, safeJson, sha256, type DnsResolver } from "./security";
import { expireManualCandidates, hasUnconfirmedManualSubmission, isRestrictedManualCandidate, markManualServiceConfirmed, serviceAllowsDerivedDiscovery } from "./submissions";

const ORIGIN_COOLDOWN_MS = 30_000;
const OBSERVATORY_HOSTS = new Set(["mpp.ninja", "mpp-ninja.bcrt43.workers.dev"]);

export class RetryableCrawlError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "RetryableCrawlError"; }
}

type ProbeDependencies = typeof fetch | { fetcher?: typeof fetch; resolver?: DnsResolver; onOrigin?: (origin:string)=>Promise<void> };
type PublicServiceInfo={name?:string;description?:string;version?:string};
interface DiscoveryStage { state:"tested-pass"|"tested-fail"; evidence:string; sourceRef:string; finalUrl:string; authoritativeEmpty?:boolean; baseUrl?:string; operations?:IngestedOperation[]; serviceInfo?:PublicServiceInfo|null; urls?:string[]; urlsRedacted?:boolean }
interface ProbeStage {
  schemaVersion:2;
  id:string;
  runId:string;
  serviceId:string;
  endpointId:string|null;
  observedAt:string;
  result:Omit<ProbeResult,"bodyText">;
  bodySha256:string;
  fingerprint:Fingerprint;
  discovery?:DiscoveryStage;
}

export async function safeProbe(rawUrl: string, kind: CrawlMessage["kind"], dependencies: ProbeDependencies = {}): Promise<ProbeResult> {
  const fetcher = typeof dependencies === "function" ? dependencies : dependencies.fetcher ?? fetch;
  const resolver = typeof dependencies === "function" ? undefined : dependencies.resolver;
  const onOrigin = typeof dependencies === "function" ? undefined : dependencies.onOrigin;
  let current = normalizeDiscoveryUrl(rawUrl);
  const initialUrl = new URL(current);
  const initialProtocol = initialUrl.protocol;
  const initialHostname = initialUrl.hostname;
  const method: "GET" | "HEAD" = kind === "homepage" ? "HEAD" : "GET";
  const dns: ProbeResult["dns"] = [];
  const redirects: string[] = [];
  let response: Response | null = null;
  const leasedOrigins = new Set<string>();
  const visitedUrls = new Set<string>();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = new URL(current);
    if (OBSERVATORY_HOSTS.has(url.hostname)||url.hostname.endsWith(".mpp.ninja")) throw new ScanSafetyError("self-target", "The observatory cannot scan itself");
    if (visitedUrls.has(current)) throw new ScanSafetyError("redirect-loop", "Redirects may not revisit a URL in one probe");
    visitedUrls.add(current);
    // A lease governs the whole bounded redirect chain for an origin. This
    // permits ordinary canonical redirects without starting a second crawl.
    if (!leasedOrigins.has(url.origin)) {
      if (onOrigin) await onOrigin(url.origin);
      leasedOrigins.add(url.origin);
    }
    dns.push(await resolvePublicHostname(url.hostname, resolver));
    response = await fetcher(current, {
      method,
      redirect: "manual",
      headers: {
        Accept: kind === "openapi" || kind === "api-catalog" ? "application/json, application/linkset+json;q=0.9, */*;q=0.1" : "application/json, text/plain;q=0.8, text/html;q=0.5, */*;q=0.1",
        "User-Agent": "mpp.ninja-observatory/1.0 (+https://mpp.ninja/methodology)",
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) throw new ScanSafetyError("redirect-without-location", "Redirect omitted Location");
    if (hop === MAX_REDIRECTS) throw new ScanSafetyError("too-many-redirects", `More than ${MAX_REDIRECTS} redirects`);
    const next = normalizeDiscoveryUrl(new URL(location, current).toString());
    if (initialProtocol === "https:" && new URL(next).protocol !== "https:") throw new ScanSafetyError("https-downgrade", "HTTPS to HTTP redirects are blocked");
    if(new URL(next).hostname!==initialHostname)throw new ScanSafetyError("cross-host-redirect","Redirects to a different hostname are recorded as blocked, not followed");
    redirects.push(next);
    await response.body?.cancel().catch(() => undefined);
    current = next;
  }

  if (!response) throw new ScanSafetyError("no-response", "Probe produced no response");
  const limit = kind === "openapi" || kind === "api-catalog" ? MAX_DISCOVERY_BYTES : MAX_RESPONSE_BYTES;
  const { text, bytes } = method === "HEAD" ? { text: "", bytes: 0 } : await readBoundedBody(response, limit);
  const headers = redactHeaders(response.headers);
  const challenges = parsePaymentChallenges(response.headers.get("www-authenticate"));
  const cf = response.cf as IncomingRequestCfProperties | undefined;
  return {
    requestedUrl: normalizeDiscoveryUrl(rawUrl),
    finalUrl: current,
    method,
    status: response.status,
    headers,
    bodyText: text,
    responseBytes: bytes,
    redirects,
    dns,
    challenges,
    observedAt: new Date().toISOString(),
    tls: {
      state: new URL(current).protocol === "https:" ? "tested-pass" : "tested-fail",
      httpProtocol: typeof cf?.httpProtocol === "string" ? cf.httpProtocol : null,
      note: new URL(current).protocol === "https:" ? "HTTPS fetch completed with platform certificate validation" : "Final response used cleartext HTTP",
    },
  };
}

export async function processCrawlMessage(env: Env, message: CrawlMessage): Promise<void> {
  const target = normalizeDiscoveryUrl(message.url);
  const targetId=await crawlTargetId(message,target);
  if(!message.serviceId||!await serviceTargetMatchesHostname(env.DB,message.serviceId,target)){
    await env.DB.prepare("UPDATE crawl_targets SET status='retired',next_due_at=NULL,processing_token=NULL,processing_expires_at=NULL,last_error='cross-host-or-missing-service',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(targetId).run();
    return;
  }
  const startedAt=new Date().toISOString();
  // An already-enqueued due message may outlive the source label that created
  // it. Enforce the manual 24-hour gate from current DB authority instead.
  if(message.serviceId&&await isRestrictedManualCandidate(env.DB,message.serviceId)&&await env.DB.prepare("SELECT 1 AS expired FROM submissions WHERE service_id=? AND confirmed_at IS NULL AND candidate_expires_at<=? LIMIT 1").bind(message.serviceId,startedAt).first()){
    await expireManualCandidates(env.DB,startedAt);
    return;
  }
  if(message.runId){const retired=await env.DB.prepare("UPDATE crawl_targets SET status='retired',next_due_at=NULL,processing_token=NULL,processing_expires_at=NULL,last_error='source-withdrawn',updated_at=CURRENT_TIMESTAMP WHERE id=? AND run_id=? AND service_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crawl_target_sources cts WHERE cts.target_id=crawl_targets.id AND cts.active=1) RETURNING id").bind(targetId,message.runId).first();if(retired)return;}
  const attemptStartedAt=startedAt;
  const stableQueuedRun=Boolean(message.runId);
  const processingToken=stableQueuedRun?crypto.randomUUID():null;
  let runId=message.runId;
  let observedAt=attemptStartedAt;
  if(runId){
    const processingExpiresAt=new Date(Date.now()+120_000).toISOString();
    const reserved=await env.DB.prepare("UPDATE crawl_targets SET status='processing',processing_token=?,processing_expires_at=?,run_observed_at=COALESCE(run_observed_at,?) WHERE id=? AND run_id=? AND (service_id IS NULL OR EXISTS (SELECT 1 FROM crawl_target_sources source WHERE source.target_id=crawl_targets.id AND source.active=1)) AND (status IN ('queued','retry','enqueueing') OR (status='processing' AND processing_expires_at<=?)) RETURNING run_observed_at").bind(processingToken,processingExpiresAt,attemptStartedAt,targetId,runId,attemptStartedAt).first<{run_observed_at:string}>();
    if(!reserved){
      const current=await env.DB.prepare("SELECT status,run_id,processing_expires_at FROM crawl_targets WHERE id=?").bind(targetId).first<{status:string;run_id:string|null;processing_expires_at:string|null}>();
      if(current?.run_id===runId&&current.status==="processing")throw new RetryableCrawlError("run-in-progress","Another delivery owns this crawl run");
      return;
    }
    observedAt=reserved.run_observed_at;
  }else{
    const targetState=await env.DB.prepare("SELECT status,run_id,run_observed_at FROM crawl_targets WHERE id=?").bind(targetId).first<{status:string;run_id:string|null;run_observed_at:string|null}>();
    if(targetState?.status==="complete"||targetState?.status==="rejected")return;
    runId=targetState?.run_id??await sha256(safeJson([targetId,"legacy"]));
    observedAt=targetState?.run_observed_at??attemptStartedAt;
  }
  const observationId=await sha256(`${runId}|observation`);
  if(stableQueuedRun&&await env.DB.prepare("SELECT id FROM observations WHERE id=?").bind(observationId).first()){
    const restrictedManual=Boolean(message.serviceId&&await isRestrictedManualCandidate(env.DB,message.serviceId));
    if(restrictedManual)await env.DB.prepare("UPDATE submissions SET status='unconfirmed',last_error=NULL WHERE (normalized_url=? OR service_id=?) AND confirmed_at IS NULL").bind(target,message.serviceId).run();
    await env.DB.prepare("UPDATE crawl_targets SET status=?,attempt_count=attempt_count+1,last_attempt_at=?,last_error=NULL,next_due_at=?,processing_token=NULL,processing_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND run_id=? AND processing_token=?").bind(restrictedManual?"retired":"complete",observedAt,restrictedManual?null:nextObservationDue(observedAt),targetId,runId,processingToken).run();
    if(restrictedManual)await retireUnconfirmedManualTarget(env.DB,targetId,message.serviceId!,target);
    return;
  }
  const targetUrl = new URL(target);
  let serviceId = message.serviceId ?? `manual-${(await sha256(target)).slice(0, 24)}`;
  serviceId = await ensureManualService(env.DB, serviceId, targetUrl, message.source,Boolean(message.serviceId),observedAt);
  const wasUnconfirmedManual=await hasUnconfirmedManualSubmission(env.DB,serviceId);
  const r2Key=`observations/${observedAt.slice(0,10).replace(/-/g,"/")}/${serviceId}/${observationId}.json`;
  try {
    let stage=await loadProbeStage(env.OBSERVATIONS,r2Key,observationId,runId);
    if(!stage){
      const result=await safeProbe(target,message.kind,{onOrigin:(origin)=>acquireOriginLease(env.DB,origin)});
      let openApiDocument:unknown;
      let discovery:DiscoveryStage|undefined;
      if(message.kind==="openapi"&&result.status>=200&&result.status<300){
        try{const document:unknown=JSON.parse(result.bodyText);if(!isSupportedOpenApiDocument(document))discovery={state:"tested-fail",evidence:"Response was JSON but not a bounded supported OpenAPI 3 document",sourceRef:result.requestedUrl,finalUrl:result.finalUrl,authoritativeEmpty:true};else{openApiDocument=document;const operations=ingestOpenApi(document);discovery={state:"tested-pass",evidence:`${operations.reduce((sum,operation)=>sum+operation.offers.length,0)} payment offer(s) accepted`,sourceRef:result.requestedUrl,finalUrl:result.finalUrl,baseUrl:openApiServerBase(document,result.finalUrl),operations,serviceInfo:publicServiceInfo(document)};}}
        catch{discovery={state:"tested-fail",evidence:"OpenAPI response was not valid JSON",sourceRef:result.requestedUrl,finalUrl:result.finalUrl,authoritativeEmpty:true};}
      }else if(message.kind==="openapi"&&(result.status===404||result.status===410)){
        discovery={state:"tested-fail",evidence:`OpenAPI source returned HTTP ${result.status}; prior advertised operations were withdrawn`,sourceRef:result.requestedUrl,finalUrl:result.finalUrl,authoritativeEmpty:true};
      }else if(message.kind==="api-catalog"&&result.status>=200&&result.status<300){
        try{const document:unknown=JSON.parse(result.bodyText);if(!isSupportedApiCatalogDocument(document))discovery={state:"tested-fail",evidence:"Response was JSON but not a bounded RFC 9727 linkset",sourceRef:result.requestedUrl,finalUrl:result.finalUrl,authoritativeEmpty:true};else{const urls=ingestApiCatalog(document,result.finalUrl);discovery={state:"tested-pass",evidence:`${urls.length} OpenAPI link(s) accepted`,sourceRef:result.requestedUrl,finalUrl:result.finalUrl,urls};}}
        catch{discovery={state:"tested-fail",evidence:"API catalog response was not valid JSON",sourceRef:result.requestedUrl,finalUrl:result.finalUrl,authoritativeEmpty:true};}
      }else if(message.kind==="api-catalog"&&(result.status===404||result.status===410)){
        discovery={state:"tested-fail",evidence:`API catalog source returned HTTP ${result.status}; prior advertised links were withdrawn`,sourceRef:result.requestedUrl,finalUrl:result.finalUrl,authoritativeEmpty:true};
      }
      const endpointId=message.endpointId??(message.kind==="endpoint"?await sha256(`${serviceId}|${result.method}|${result.requestedUrl}`):null);
      const {bodyText,...rawStoredResult}=result;
      const storedResult={...rawStoredResult,requestedUrl:redactUrlForStorage(rawStoredResult.requestedUrl),finalUrl:redactUrlForStorage(rawStoredResult.finalUrl),redirects:rawStoredResult.redirects.map(redactUrlForStorage)};
      stage={schemaVersion:2,id:observationId,runId,serviceId,endpointId,observedAt,result:storedResult,bodySha256:await sha256(bodyText),fingerprint:fingerprintImplementation(result,openApiDocument),...(discovery?{discovery:discoveryForStorage(discovery)}:{})};
      await env.OBSERVATIONS.put(r2Key,safeJson(stage),{httpMetadata:{contentType:"application/json"},customMetadata:{schema:"2",serviceId,observationId,runId}});
    }
    if(stableQueuedRun){
      const authority=await refreshCrawlAuthority(env.DB,targetId,runId!,processingToken);
      if(authority==="retired")return;
    }
    const result:ProbeResult={...stage.result,bodyText:""};
    if(stage.discovery&&message.kind==="openapi"){
      await setSecurity(env.DB,serviceId,message.endpointId??null,"openapi_parse",stage.discovery.state,stage.discovery.evidence,"harmless discovery response",null,observedAt);
      if(stage.discovery.state==="tested-pass"||stage.discovery.authoritativeEmpty){
        const sourceRef=stage.discovery.sourceRef;
        if(stage.discovery.state==="tested-pass"){
          await recordOpenApiSource(env.DB,serviceId,sourceRef,stage.discovery.finalUrl,stage.discovery.serviceInfo??null,observedAt);
        }
        const operations=stage.discovery.operations??[];const baseUrl=stage.discovery.baseUrl??new URL(stage.discovery.finalUrl).origin;const snapshotId=await sha256(safeJson(["openapi",serviceId,sourceRef,observedAt]));const operationMessages=openApiQueueMessages(serviceId,baseUrl,operations,observedAt,sourceRef,snapshotId);
        await startSourceSnapshot(env.DB,{id:snapshotId,serviceId,sourceType:"openapi",sourceRef,observedAt,expectedItems:operationMessages.length});await stageOpenApiServiceInfo(env.DB,snapshotId,serviceId,stage.discovery.serviceInfo??null);await sendBoundedQueueMessages(env.CRAWL_QUEUE,operationMessages);if(operationMessages.length===0)await reconcileSourceSnapshot(env.DB,snapshotId);
      }
    }
    if(stage.discovery&&message.kind==="api-catalog"){
      await setSecurity(env.DB,serviceId,message.endpointId??null,"api_catalog_parse",stage.discovery.state,stage.discovery.evidence,"RFC 9727 discovery response",null,observedAt);
      if(stage.discovery.state==="tested-pass"||stage.discovery.authoritativeEmpty){
        const urls=stage.discovery.urls??[];const sourceRef=stage.discovery.sourceRef;if(stage.discovery.state==="tested-pass")await recordApiCatalogSource(env.DB,serviceId,sourceRef,stage.discovery.finalUrl,urls.length,observedAt);
        const snapshotId=await sha256(safeJson(["api-catalog",serviceId,sourceRef,observedAt]));const linkMessages=urls.map((url,index):ApiCatalogLinkMessage=>({type:"api-catalog-link",url,serviceId,sourceRef,observedAt,snapshotId,itemId:`${snapshotId}:${index}`}));
        await startSourceSnapshot(env.DB,{id:snapshotId,serviceId,sourceType:"api-catalog",sourceRef,observedAt,expectedItems:linkMessages.length});await sendBoundedQueueMessages(env.CRAWL_QUEUE,linkMessages);if(linkMessages.length===0)await reconcileSourceSnapshot(env.DB,snapshotId);
      }
    }
    if(stableQueuedRun&&await refreshCrawlAuthority(env.DB,targetId,runId!,processingToken)==="retired")return;
    await recordFingerprint(env.DB,serviceId,stage.fingerprint,observedAt);
    let endpointId=stage.endpointId;
    if(endpointId&&message.kind==="endpoint")endpointId=await ensureEndpoint(env.DB,serviceId,result.requestedUrl,result.method,observedAt);
    const validChallenges=result.status===402?result.challenges.filter(isValidPaymentChallenge):[];
    if (endpointId) {
      for (const [sourceOrdinal,challenge] of validChallenges.entries()){const statements=await offerStatements(env.DB, serviceId, endpointId, challengeToOffer(challenge), observedAt,result.requestedUrl,sourceOrdinal);if(statements.length)await env.DB.batch(statements);}
      await recordEndpointProbe(env.DB, serviceId, endpointId, result, observedAt);
    }

    const validMpp=validChallenges.length>0;
    await env.DB.prepare("UPDATE services SET last_probe_at=CASE WHEN last_probe_at IS NULL OR last_probe_at<=? THEN ? ELSE last_probe_at END,last_seen=CASE WHEN last_seen<=? THEN ? ELSE last_seen END,status=CASE WHEN ?=1 AND status IN ('candidate','pending','unconfirmed') THEN 'observed-mpp' ELSE status END,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(observedAt,observedAt,observedAt,observedAt,validMpp?1:0,serviceId).run();
    await writeSecurityProperties(env.DB,serviceId,endpointId,result,observedAt);
    if(validMpp){await markManualServiceConfirmed(env.DB,serviceId,observedAt);if(wasUnconfirmedManual)await requeuePromotedManualDiscovery(env,serviceId,observedAt);}
    else if(wasUnconfirmedManual)await env.DB.prepare("UPDATE submissions SET status='unconfirmed',last_error=NULL WHERE (normalized_url=? OR service_id=?) AND confirmed_at IS NULL").bind(target,serviceId).run();
    await env.DB.prepare("INSERT INTO observations (id,service_id,endpoint_id,observed_at,request_method,requested_url,final_url,status,headers_json,challenge_json,dns_json,tls_json,redirect_count,response_bytes,body_sha256,raw_r2_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET endpoint_id=excluded.endpoint_id,observed_at=excluded.observed_at,request_method=excluded.request_method,requested_url=excluded.requested_url,final_url=excluded.final_url,status=excluded.status,headers_json=excluded.headers_json,challenge_json=excluded.challenge_json,dns_json=excluded.dns_json,tls_json=excluded.tls_json,redirect_count=excluded.redirect_count,response_bytes=excluded.response_bytes,body_sha256=excluded.body_sha256,raw_r2_key=excluded.raw_r2_key").bind(observationId,serviceId,endpointId,observedAt,result.method,redactUrlForStorage(result.requestedUrl),redactUrlForStorage(result.finalUrl),result.status,safeJson(result.headers),safeJson(result.challenges),safeJson(result.dns),safeJson(result.tls),result.redirects.length,result.responseBytes,stage.bodySha256,r2Key).run();
    const oneShotUnconfirmed=!validMpp&&await isRestrictedManualCandidate(env.DB,serviceId);
    const completion=stableQueuedRun?await env.DB.prepare("UPDATE crawl_targets SET status=?,attempt_count=attempt_count+1,last_attempt_at=?,last_error=NULL,next_due_at=?,processing_token=NULL,processing_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND run_id=? AND status='processing' AND processing_token=?").bind(oneShotUnconfirmed?"retired":"complete",observedAt,oneShotUnconfirmed?null:nextObservationDue(observedAt),targetId,runId,processingToken).run():await env.DB.prepare("UPDATE crawl_targets SET status=?,attempt_count=attempt_count+1,last_attempt_at=?,last_error=NULL,next_due_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(oneShotUnconfirmed?"retired":"complete",observedAt,oneShotUnconfirmed?null:nextObservationDue(observedAt),targetId).run();
    if(stableQueuedRun&&Number(completion.meta.changes??0)===0)throw new RetryableCrawlError("run-lease-lost","Crawl run ownership changed during commit");
    if(oneShotUnconfirmed)await retireUnconfirmedManualTarget(env.DB,targetId,serviceId,target);
  } catch (error) {
    const code = error instanceof ScanSafetyError || error instanceof RetryableCrawlError ? error.code : error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "probe-error";
    const detail = error instanceof Error ? error.message.slice(0,500) : "unknown";
    const restrictedManual=await isRestrictedManualCandidate(env.DB,serviceId);
    const manualRetry=restrictedManual&&!(error instanceof ScanSafetyError);
    const fallbackStatus=error instanceof ScanSafetyError?"rejected":"retry";
    const retryAt=new Date(Date.now()+ORIGIN_COOLDOWN_MS).toISOString();
    const failed=stableQueuedRun?await env.DB.prepare("UPDATE crawl_targets SET status=CASE WHEN ?=1 AND attempt_count>=? THEN 'retired' ELSE ? END,attempt_count=attempt_count+1,last_attempt_at=?,last_error=?,next_due_at=CASE WHEN ?=1 AND attempt_count>=? THEN NULL ELSE ? END,processing_token=NULL,processing_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND run_id=? AND status='processing' AND processing_token=? RETURNING status").bind(manualRetry?1:0,MAX_UNCONFIRMED_MANUAL_ATTEMPTS-1,fallbackStatus,observedAt,`${code}:${detail}`,manualRetry?1:0,MAX_UNCONFIRMED_MANUAL_ATTEMPTS-1,retryAt,targetId,runId,processingToken).first<{status:string}>():await env.DB.prepare("UPDATE crawl_targets SET status=CASE WHEN ?=1 AND attempt_count>=? THEN 'retired' ELSE ? END,attempt_count=attempt_count+1,last_attempt_at=?,last_error=?,next_due_at=CASE WHEN ?=1 AND attempt_count>=? THEN NULL ELSE ? END,updated_at=CURRENT_TIMESTAMP WHERE id=? RETURNING status").bind(manualRetry?1:0,MAX_UNCONFIRMED_MANUAL_ATTEMPTS-1,fallbackStatus,observedAt,`${code}:${detail}`,manualRetry?1:0,MAX_UNCONFIRMED_MANUAL_ATTEMPTS-1,retryAt,targetId).first<{status:string}>();
    if(!stableQueuedRun||failed){await env.DB.prepare("UPDATE submissions SET status=?,last_error=? WHERE normalized_url=? OR service_id=?").bind(failed?.status==="retired"?"rejected":fallbackStatus,`${code}:${detail}`,target,serviceId).run();if(error instanceof ScanSafetyError)await setSecurity(env.DB,serviceId,message.endpointId??null,"probe_safety","tested-fail",detail,"scanner execution",null,observedAt);}
    if(restrictedManual&&(failed?.status==="retired"||failed?.status==="rejected"))await retireUnconfirmedManualTarget(env.DB,targetId,serviceId,target);
    if(manualRetry&&failed?.status==="retired")return;
    throw error;
  }
}

function nextObservationDue(observedAt:string):string{const value=new Date(observedAt).getTime();return new Date((Number.isFinite(value)?value:Date.now())+6*60*60*1_000).toISOString();}
async function refreshCrawlAuthority(db:D1Database,targetId:string,runId:string,processingToken:string|null):Promise<"active"|"retired">{
  const owned=await db.prepare(`UPDATE crawl_targets SET processing_expires_at=?
    WHERE id=? AND run_id=? AND status='processing' AND processing_token=?
      AND (crawl_targets.service_id IS NULL
        OR EXISTS (SELECT 1 FROM crawl_target_sources active_source WHERE active_source.target_id=crawl_targets.id AND active_source.active=1))`)
    .bind(new Date(Date.now()+120_000).toISOString(),targetId,runId,processingToken).run();
  if(Number(owned.meta.changes??0)>0)return"active";
  const current=await db.prepare("SELECT status FROM crawl_targets WHERE id=? AND run_id=?").bind(targetId,runId).first<{status:string}>();
  if(current?.status==="retired")return"retired";
  throw new RetryableCrawlError("run-lease-lost","Crawl run ownership or source authority changed before commit");
}
function discoveryForStorage(discovery:DiscoveryStage):DiscoveryStage{
  const sourceRef=redactUrlForStorage(discovery.sourceRef);
  const finalUrl=redactUrlForStorage(discovery.finalUrl);
  const baseUrl=discovery.baseUrl?redactUrlForStorage(discovery.baseUrl):undefined;
  const safeUrls=discovery.urls?.filter((url)=>redactUrlForStorage(url)===url);
  const sourceUnsafe=sourceRef!==discovery.sourceRef;
  const baseUnsafe=Boolean(discovery.baseUrl&&baseUrl!==discovery.baseUrl);
  const urlsRedacted=Boolean(discovery.urlsRedacted||sourceUnsafe||finalUrl!==discovery.finalUrl||baseUnsafe||safeUrls?.length!==discovery.urls?.length);
  if(sourceUnsafe||baseUnsafe)return{...discovery,state:"tested-fail",evidence:"Credential-shaped discovery URL was excluded from indexing and fan-out",sourceRef,finalUrl,authoritativeEmpty:false,operations:[],urls:[],urlsRedacted:true,baseUrl:undefined};
  return{...discovery,sourceRef,finalUrl,...(baseUrl?{baseUrl}:{}),...(safeUrls?{urls:safeUrls}:{}),...(urlsRedacted?{urlsRedacted:true}:{})};
}
async function loadProbeStage(bucket:R2Bucket,key:string,id:string,runId:string):Promise<ProbeStage|null>{
  try{const object=await bucket.get(key);if(!object)return null;const value:unknown=JSON.parse(await object.text());if(!value||typeof value!=="object"||Array.isArray(value))return null;const stage=value as Partial<ProbeStage>;return stage.schemaVersion===2&&stage.id===id&&stage.runId===runId&&stage.result&&typeof stage.result==="object"?stage as ProbeStage:null;}catch{return null;}
}

export async function processApiCatalogLink(env:Env,message:ApiCatalogLinkMessage):Promise<void>{
  if(await sourceSnapshotItemProcessed(env.DB,message.snapshotId,message.itemId)){await reconcileSourceSnapshot(env.DB,message.snapshotId);await enqueueCompletedSnapshotTargets(env,message.snapshotId);return;}
  if(await serviceAllowsDerivedCrawl(env.DB,message.serviceId))await enqueueTarget(env,{type:"probe",url:message.url,serviceId:message.serviceId,kind:"openapi",source:"openapi"},300,false,{sourceType:"api-catalog",sourceRef:message.sourceRef,observedAt:message.observedAt});
  await recordSourceSnapshotItem(env.DB,message.snapshotId,message.itemId,message.observedAt);
  await enqueueCompletedSnapshotTargets(env,message.snapshotId);
}

export async function processOpenApiOperation(env:Env,message:OpenApiOperationMessage):Promise<void>{
  if(await sourceSnapshotItemProcessed(env.DB,message.snapshotId,message.itemId)){await reconcileSourceSnapshot(env.DB,message.snapshotId);await enqueueCompletedSnapshotTargets(env,message.snapshotId);return;}
  let discoveredEndpointId:string;
  try{discoveredEndpointId=await upsertOpenApiOperation(env.DB,message.serviceId,message.baseUrl,message.operation,message.observedAt,message.sourceRef,message.offerOffset,true,message.snapshotId);}
  catch(error){if(error instanceof ScanSafetyError){await recordSourceSnapshotItem(env.DB,message.snapshotId,message.itemId,message.observedAt);await enqueueCompletedSnapshotTargets(env,message.snapshotId);return;}throw error;}
  if(await serviceAllowsDerivedCrawl(env.DB,message.serviceId)&&["GET","HEAD"].includes(message.operation.method)&&!/[{}]/.test(message.operation.path)){
    const endpointUrl=openApiOperationUrl(message.baseUrl,message.operation.path);
    await enqueueTarget(env,{type:"probe",url:endpointUrl,serviceId:message.serviceId,endpointId:discoveredEndpointId,kind:message.operation.method==="HEAD"?"homepage":"endpoint",source:"openapi"},600,false,{sourceType:"openapi",sourceRef:message.sourceRef,observedAt:message.observedAt});
  }
  await recordSourceSnapshotItem(env.DB,message.snapshotId,message.itemId,message.observedAt);
  await enqueueCompletedSnapshotTargets(env,message.snapshotId);
}

export function openApiQueueMessages(serviceId:string,baseUrl:string,operations:IngestedOperation[],observedAt:string,sourceRef=baseUrl,snapshotId=`openapi:${serviceId}:${observedAt}`):OpenApiOperationMessage[]{const messages=operations.flatMap((operation)=>operation.offers.map((offer,offerOffset)=>({type:"openapi-operation" as const,serviceId,baseUrl,operation:{...operation,offers:[offer]},offerOffset,observedAt,sourceRef,snapshotId,itemId:""})));return messages.map((message,index)=>({...message,itemId:`${snapshotId}:${index}`}));}

async function serviceAllowsDerivedCrawl(db:D1Database,serviceId:string):Promise<boolean>{
  return serviceAllowsDerivedDiscovery(db,serviceId);
}

async function retireUnconfirmedManualTarget(db:D1Database,targetId:string,serviceId:string,sourceRef:string):Promise<void>{
  const now=new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE crawl_target_sources SET active=0,observed_at=? WHERE target_id=? AND source_type='manual' AND active=1").bind(now,targetId),
    db.prepare("UPDATE crawl_target_sources SET active=0,observed_at=? WHERE active=1 AND source_type IN ('openapi','api-catalog') AND source_ref=? AND target_id IN (SELECT id FROM crawl_targets WHERE service_id=?)").bind(now,sourceRef,serviceId),
    db.prepare(`UPDATE services SET status='unconfirmed',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('candidate','pending')
      AND NOT EXISTS (
        SELECT 1 FROM crawl_targets trusted_target JOIN crawl_target_sources trusted_authority ON trusted_authority.target_id=trusted_target.id
        WHERE trusted_target.service_id=services.id AND trusted_authority.active=1 AND trusted_authority.source_type IN ('catalog','mppscan')
      )`).bind(serviceId),
  ]);
}

async function requeuePromotedManualDiscovery(env:Env,serviceId:string,observedAt:string):Promise<void>{
  const targets=await env.DB.prepare(`SELECT DISTINCT target.normalized_url,target.target_kind FROM crawl_targets target
    JOIN crawl_target_sources manual_source ON manual_source.target_id=target.id AND manual_source.source_type='manual'
    WHERE target.service_id=? AND target.target_kind IN ('openapi','api-catalog') AND target.status='retired'
    ORDER BY target.normalized_url LIMIT 2`).bind(serviceId).all<{normalized_url:string;target_kind:"openapi"|"api-catalog"}>();
  for(const target of targets.results)await enqueueTarget(env,{type:"probe",url:target.normalized_url,serviceId,kind:target.target_kind,source:"manual"},60,false,{sourceType:"manual",sourceRef:"https://mpp.ninja/submit",observedAt});
}

async function acquireOriginLease(db: D1Database, origin: string): Promise<void> {
  const now = new Date();
  const next = new Date(now.getTime()+ORIGIN_COOLDOWN_MS).toISOString();
  const result = await db.prepare("INSERT INTO origin_rate_limits (origin,next_allowed_at,updated_at) VALUES (?,?,?) ON CONFLICT(origin) DO UPDATE SET next_allowed_at=excluded.next_allowed_at,updated_at=excluded.updated_at WHERE origin_rate_limits.next_allowed_at<=?").bind(origin,next,now.toISOString(),now.toISOString()).run();
  if ((result.meta.changes??0)===0) throw new RetryableCrawlError("origin-rate-limited","Per-origin cooldown is active");
}

async function ensureManualService(db: D1Database, id: string, url: URL, source: CrawlMessage["source"],preferId:boolean,now:string): Promise<string> {
  const exact = normalizeUrl(url.toString());
  const known=preferId?await db.prepare("SELECT id FROM services WHERE id=?").bind(id).first<{id:string}>():null;
  const existing = known??await db.prepare("SELECT id FROM services WHERE service_url=?").bind(exact).first<{id:string}>();
  const actualId=existing?.id??id;
  await db.prepare("INSERT INTO services (id,name,homepage_url,service_url,origin,description,first_seen,last_seen,status) VALUES (?,?,?,?,?,'Submitted for safe discovery',?,?,'pending') ON CONFLICT(id) DO UPDATE SET published=1,last_seen=excluded.last_seen WHERE excluded.last_seen>=services.last_seen").bind(actualId,url.hostname,url.origin,exact,url.origin,now,now).run();
  if(!preferId){
    const provenance=source==="mppscan"?"https://mppscan.com/":source==="manual"?"https://mpp.ninja/submit":exact;
    const sourceId=await sha256(`${actualId}|${source}|${provenance}`);
    await db.prepare("INSERT INTO sources (id,service_id,source_kind,source_url,evidence_json,first_seen,last_seen) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen WHERE excluded.last_seen>=sources.last_seen").bind(sourceId,actualId,source,provenance,safeJson({ discoveredUrl:redactUrlForStorage(exact) }),now,now).run();
  }
  return actualId;
}

async function ensureEndpoint(db:D1Database,serviceId:string,url:string,method:string,now:string):Promise<string>{
  const id=await sha256(`${serviceId}|${method}|${url}`); const path=new URL(url).pathname;
  await db.prepare("INSERT INTO endpoints (id,service_id,url,http_method,path,kind,description,first_seen,last_seen) VALUES (?,?,?,?,?,'paid-api','Runtime challenge target',?,?) ON CONFLICT(id) DO UPDATE SET last_seen=CASE WHEN excluded.last_seen>endpoints.last_seen THEN excluded.last_seen ELSE endpoints.last_seen END").bind(id,serviceId,url,method,path,now,now).run(); return id;
}

async function recordFingerprint(db:D1Database,serviceId:string,fingerprint:{implementation:string;confidence:number;evidence:string[]},now:string):Promise<void>{
  if(fingerprint.confidence===0)return;
  const evidence=safeJson(fingerprint.evidence);
  await db.prepare(`UPDATE services SET implementation=?,implementation_confidence=?,fingerprint_evidence_json=?,fingerprint_observed_at=?,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND (implementation=? OR implementation='unknown' OR ?>=0.8)
      AND (fingerprint_observed_at IS NULL OR ?>fingerprint_observed_at OR (?=fingerprint_observed_at AND (?>implementation_confidence OR (?=implementation_confidence AND (?<implementation OR (?=implementation AND ?>fingerprint_evidence_json))))))`)
    .bind(fingerprint.implementation,fingerprint.confidence,evidence,now,serviceId,fingerprint.implementation,fingerprint.confidence,now,now,fingerprint.confidence,fingerprint.confidence,fingerprint.implementation,fingerprint.implementation,evidence).run();
}

async function writeSecurityProperties(db:D1Database,serviceId:string,endpointId:string|null,result:ProbeResult,now:string):Promise<void>{
  await setSecurity(db,serviceId,endpointId,"https_transport",result.tls.state,result.tls.note,"platform TLS validation",null,now);
  await setSecurity(db,serviceId,endpointId,"ssrf_target_validation","tested-pass",`${result.dns.length} hop(s) resolved twice to stable public addresses`,"scanner URL, DNS and redirect policy",null,now);
  await setSecurity(db,serviceId,endpointId,"redirect_policy","tested-pass",`${result.redirects.length} redirects; every hop passed URL and DNS validation`,"harmless scanner",null,now);
  await setSecurity(db,serviceId,endpointId,"bounded_response","tested-pass",`${result.responseBytes} bytes within scanner limit`,"harmless scanner",null,now);
  const challengeState:SecurityState=result.challenges.length===0?"unknown":result.status!==402||result.challenges.some((c)=>c.parseError)?"tested-fail":"tested-pass";
  await setSecurity(db,serviceId,endpointId,"challenge_parse",challengeState,result.challenges.length?`${result.challenges.length} Payment challenge(s) observed on HTTP ${result.status}`:"No MPP Payment challenge observed","unauthenticated HTTP response",null,now);
  await setSecurity(db,serviceId,endpointId,"credential_replay","not-tested","Scanner never sends credentials or payments","methodology","https://github.com/advisories/GHSA-fxc9-7j2w-vx54",now);
  await setSecurity(db,serviceId,endpointId,"authorization_delivery_settlement","not-tested","Requires paid or state-changing behavior outside scanner scope","Tempo Aug 24 research class","https://github.com/wevm/mppx/pull/510#discussion_r3377899233",now);
  await setSecurity(db,serviceId,endpointId,"price_debit_consistency","not-tested","Requires a completed paid interaction outside scanner scope","public economic-security prior art",null,now);
  await setSecurity(db,serviceId,endpointId,"concurrency_single_winner","not-tested","Concurrency and paid state changes are prohibited","public economic-security prior art",null,now);
  await setSecurity(db,serviceId,endpointId,"replay_idempotency_scope","not-tested","Scanner never replays signed credentials","public advisory and protocol prior art","https://github.com/advisories/GHSA-fxc9-7j2w-vx54",now);
  await setSecurity(db,serviceId,endpointId,"channel_lifecycle_binding","not-tested","Channel and settlement lifecycle require credentials or payments","public economic-security prior art",null,now);
  await setSecurity(db,serviceId,endpointId,"fee_payer_cosigner_binding","not-tested","Signature and fee-payer relationships are not observable unauthenticated","public economic-security prior art",null,now);
  await setSecurity(db,serviceId,endpointId,"method_fallback_policy","not-tested","Scanner does not select, downgrade, or execute payment methods","public economic-security prior art",null,now);
  if(result.challenges.length){
    const riskRows=result.challenges.map((challenge)=>({method:challenge.method,intent:challenge.intent,risk:economicRiskMetadata(challengeToOffer(challenge))}));
    const observable=riskRows.some(({risk})=>risk.deposit!==null||risk.authorizationWindow!==null||risk.depositWindowRatio!==null||risk.observableAuthorizationExposure!==null);
    await setSecurity(db,serviceId,endpointId,"economic_exposure_metadata",observable?"observed":"unknown",safeJson(riskRows.map(({method,intent,risk})=>({method,intent,...risk}))),"observable challenge values only",null,now);
  }else await setSecurity(db,serviceId,endpointId,"economic_exposure_metadata","unknown","No current Payment challenge exposes session or authorization inputs","observable challenge values only",null,now);
}

async function setSecurity(db:D1Database,serviceId:string,endpointId:string|null,key:string,state:SecurityState,evidence:string,basis:string,advisory:string|null,now:string):Promise<void>{
  const id=await sha256(`${serviceId}|${endpointId??"service"}|${key}`);
  const boundedEvidence=evidence.slice(0,2_000);const boundedBasis=basis.slice(0,500);
  await db.prepare("INSERT INTO security_properties (id,service_id,endpoint_id,property_key,state,evidence,basis,advisory_ref,observed_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,evidence=excluded.evidence,basis=excluded.basis,advisory_ref=excluded.advisory_ref,observed_at=excluded.observed_at WHERE excluded.observed_at>security_properties.observed_at OR (excluded.observed_at=security_properties.observed_at AND (excluded.state||char(0)||excluded.evidence||char(0)||excluded.basis)>(security_properties.state||char(0)||security_properties.evidence||char(0)||security_properties.basis))").bind(id,serviceId,endpointId,key,state,boundedEvidence,boundedBasis,advisory,now).run();
}

function openApiServerBase(document:unknown,documentUrl:string):string{if(document&&typeof document==="object"&&!Array.isArray(document)){const servers=(document as Record<string,unknown>).servers;if(Array.isArray(servers)){for(const item of servers.slice(0,8)){if(item&&typeof item==="object"&&!Array.isArray(item)){const value=(item as Record<string,unknown>).url;if(typeof value==="string"&&value&&!/[{}]/.test(value)){try{return normalizeDiscoveryUrl(new URL(value,documentUrl).toString());}catch{ /* fall through */ }}}}}}return new URL(documentUrl).origin;}
function openApiOperationUrl(baseUrl:string,path:string):string{const base=new URL(baseUrl);base.pathname=`${base.pathname.replace(/\/$/,"")}/${path.replace(/^\//,"")}`.replace(/\/{2,}/g,"/");base.search="";base.hash="";return normalizeUrl(base.toString());}
async function recordOpenApiSource(db:D1Database,serviceId:string,url:string,finalUrl:string,serviceInfo:PublicServiceInfo|null,now:string):Promise<void>{const sourceUrl=redactUrlForStorage(url);const id=await sha256(`${serviceId}|openapi|${sourceUrl}`);await db.prepare("INSERT INTO sources (id,service_id,source_kind,source_url,evidence_json,first_seen,last_seen) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,evidence_json=excluded.evidence_json WHERE excluded.last_seen>=sources.last_seen").bind(id,serviceId,"openapi",sourceUrl,safeJson({runtimeFetched:true,finalUrl:redactUrlForStorage(finalUrl),...(serviceInfo?{serviceInfo}:{} )}),now,now).run();}
async function recordApiCatalogSource(db:D1Database,serviceId:string,url:string,finalUrl:string,linkCount:number,now:string):Promise<void>{const sourceUrl=redactUrlForStorage(url);const id=await sha256(`${serviceId}|api-catalog|${sourceUrl}`);await db.prepare("INSERT INTO sources (id,service_id,source_kind,source_url,evidence_json,first_seen,last_seen) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,evidence_json=excluded.evidence_json WHERE excluded.last_seen>=sources.last_seen").bind(id,serviceId,"api-catalog",sourceUrl,safeJson({runtimeFetched:true,finalUrl:redactUrlForStorage(finalUrl),openApiLinks:linkCount}),now,now).run();}
function publicServiceInfo(document:unknown):PublicServiceInfo|null{if(!document||typeof document!=="object"||Array.isArray(document))return null;const root=document as Record<string,unknown>;const extension=root["x-service-info"]&&typeof root["x-service-info"]==="object"&&!Array.isArray(root["x-service-info"])?root["x-service-info"] as Record<string,unknown>:{};const info=root.info&&typeof root.info==="object"&&!Array.isArray(root.info)?root.info as Record<string,unknown>:{};const clean=(value:unknown,max:number)=>typeof value==="string"&&value.trim()?value.trim().slice(0,max):undefined;const result={name:clean(extension.name??extension.title??info.title,200),description:clean(extension.description??info.description,2_000),version:clean(extension.version??info.version,100)};return Object.values(result).some(Boolean)?redactJsonValue(result) as PublicServiceInfo:null;}

async function recordEndpointProbe(db:D1Database,serviceId:string,endpointId:string,result:ProbeResult,now:string):Promise<void>{
  const validMpp=result.status===402&&result.challenges.some(isValidPaymentChallenge);
  const next:Record<string,unknown>={ last_status:result.status,content_type:result.headers["content-type"]??null,tls_state:result.tls.state,redirect_count:result.redirects.length,challenge_format:validMpp?"mpp-payment-auth":null };
  const statements:D1PreparedStatement[]=[db.prepare("UPDATE endpoints SET last_probe_at=?,last_status=?,content_type=?,tls_state=?,redirect_count=?,challenge_format=?,last_seen=CASE WHEN last_seen<=? THEN ? ELSE last_seen END,updated_at=CURRENT_TIMESTAMP WHERE id=? AND (last_probe_at IS NULL OR last_probe_at<=?)").bind(now,next.last_status,next.content_type,next.tls_state,next.redirect_count,next.challenge_format,now,now,endpointId,now)];
  if(validMpp)statements.push(db.prepare("INSERT INTO endpoint_sources (endpoint_id,source_type,source_ref,first_seen,last_seen,observed_at,active) SELECT ?,'challenge',?,?,?,?,1 WHERE EXISTS (SELECT 1 FROM endpoints guard WHERE guard.id=? AND guard.last_probe_at<=?) ON CONFLICT(endpoint_id,source_type,source_ref) DO UPDATE SET last_seen=excluded.last_seen,observed_at=excluded.observed_at,active=1 WHERE excluded.observed_at>=endpoint_sources.observed_at").bind(endpointId,result.requestedUrl,now,now,now,endpointId,now));
  else statements.push(db.prepare("UPDATE endpoint_sources SET active=0,observed_at=? WHERE endpoint_id=? AND source_type='challenge' AND source_ref=? AND observed_at<=? AND EXISTS (SELECT 1 FROM endpoints guard WHERE guard.id=? AND guard.last_probe_at<=?)").bind(now,endpointId,result.requestedUrl,now,endpointId,now));
  statements.push(db.prepare("UPDATE payment_offers SET active=CASE WHEN last_seen>=? THEN 1 ELSE 0 END,observed_at=? WHERE endpoint_id=? AND source_type='challenge' AND source_ref=? AND observed_at<=? AND EXISTS (SELECT 1 FROM endpoints guard WHERE guard.id=? AND guard.last_probe_at<=?)").bind(now,now,endpointId,result.requestedUrl,now,endpointId,now));
  await db.batch(statements);
}
