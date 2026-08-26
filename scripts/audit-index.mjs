#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const DEFAULT_BASE_URL = "https://mpp.ninja";
const MAX_PAGES = 1_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export function analyzeEndpoints(endpoints, source = "index input") {
  const findings = [];
  let offers = 0;
  let tempoSessionOffers = 0;
  let truncatedEndpoints = 0;

  for (const endpoint of Array.isArray(endpoints) ? endpoints : []) {
    const endpointOffers = Array.isArray(endpoint?.offers) ? endpoint.offers : [];
    offers += endpointOffers.length;
    if (endpoint?.offerPagination?.truncated) truncatedEndpoints += 1;

    for (const offer of endpointOffers) {
      if (lower(offer?.method) !== "tempo" || lower(offer?.intent) !== "session") continue;
      tempoSessionOffers += 1;
      const target = targetFrom(endpoint, offer);
      findings.push({
        class: "C-010",
        status: "client-risk-surface",
        severity: "review",
        ...target,
        evidence: [
          "An active indexed offer advertises the Tempo session intent.",
          "C-010 locally demonstrated that affected clients can sign server-requested cumulative authorization up to their configured channel limit before application delivery.",
        ],
        missingProof: [
          "The endpoint has not requested authorization above delivered value.",
          "No affected client version or uncapped client configuration is established.",
          "No paid interaction, enforceable voucher, settlement, or loss was observed.",
        ],
      });

      if (lower(endpoint?.implementation) === "mpp-rs") {
        for (const item of [
          ["C-011", "concurrent-voucher-candidate", "Concurrent verification has not shown more than one protected response for one accepted increment."],
          ["C-012", "unit-price-debit-candidate", "A sub-price voucher increment has not shown delivery of the advertised response."],
        ]) {
          findings.push({
            class: item[0],
            status: item[1],
            severity: "review",
            ...target,
            evidence: [
              "The service has an indexed mpp-rs fingerprint and an active Tempo session offer.",
              "The matching flaw was reproduced locally in the reviewed mpp-rs source and bundled multi-fetch integration pattern.",
            ],
            missingProof: [
              "The exact deployed mpp-rs version and application integration are not established.",
              item[2],
              "No signed credential, concurrent request, payment, or remote state change was attempted.",
            ],
          });
        }
      }
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source,
    boundary: "Normalized mpp.ninja index evidence only; no indexed service was contacted by this audit.",
    summary: {
      endpoints: Array.isArray(endpoints) ? endpoints.length : 0,
      offersInspected: offers,
      tempoSessionOffers,
      reviewCandidates: findings.length,
      confirmedVulnerabilities: 0,
      truncatedEndpoints,
    },
    findings,
    conclusion: findings.length
      ? "Candidate risk surfaces exist, but the index evidence does not confirm that an endpoint is vulnerable."
      : "No indexed endpoint matched the observable preconditions for C-010, C-011, or C-012; this is not proof that every endpoint is secure.",
  };
}

export async function fetchEndpointIndex(baseUrl, fetcher = fetch) {
  const base = normalizeBaseUrl(baseUrl);
  const endpoints = [];
  let cursor = null;
  const seen = new Set();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL("/api/endpoints", base);
    url.searchParams.set("limit", "50");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetcher(url, {
      headers: { Accept: "application/json", "User-Agent": "mpp.ninja-index-audit/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Index API returned HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Index API response exceeded 10 MiB");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("Index API response exceeded 10 MiB");
    const document = JSON.parse(text);
    if (!document || !Array.isArray(document.data)) throw new Error("Index API returned an unexpected document shape");
    endpoints.push(...document.data);
    const next = document.pagination?.nextCursor;
    if (!next) return endpoints;
    if (typeof next !== "string" || seen.has(next)) throw new Error("Index API pagination cursor repeated or was invalid");
    seen.add(next);
    cursor = next;
  }
  throw new Error(`Index API exceeded ${MAX_PAGES} pages`);
}

function targetFrom(endpoint, offer) {
  return {
    serviceId: string(endpoint?.service_id ?? endpoint?.serviceId),
    serviceName: string(endpoint?.service_name ?? endpoint?.serviceName),
    endpointId: string(endpoint?.id),
    url: string(endpoint?.url),
    implementation: string(endpoint?.implementation) || "unknown",
    implementationConfidence: numberOrNull(endpoint?.implementation_confidence ?? endpoint?.implementationConfidence),
    offer: {
      method: string(offer?.method),
      intent: string(offer?.intent),
      amount: stringOrNull(offer?.amount),
      currency: stringOrNull(offer?.currency),
      chainId: stringOrNull(offer?.chainId ?? offer?.chain_id),
      unitType: stringOrNull(offer?.unitType ?? offer?.unit_type),
      sourceType: stringOrNull(offer?.sourceType ?? offer?.source_type),
    },
  };
}

function normalizeBaseUrl(value) {
  const url = new URL(value || DEFAULT_BASE_URL);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
    throw new Error("Base URL must use HTTPS (or HTTP on loopback for local development)");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Base URL cannot contain credentials, a query, or a fragment");
  url.pathname = "/";
  return url;
}

function lower(value) { return string(value).toLowerCase(); }
function string(value) { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function stringOrNull(value) { const result = string(value); return result || null; }
function numberOrNull(value) { const result = Number(value); return value === null || value === undefined || value === "" || !Number.isFinite(result) ? null : result; }

function formatText(report) {
  const lines = [
    "MPP index audit",
    `Source: ${report.source}`,
    `Endpoints: ${report.summary.endpoints}`,
    `Offers inspected: ${report.summary.offersInspected}`,
    `Tempo session offers: ${report.summary.tempoSessionOffers}`,
    `Review candidates: ${report.summary.reviewCandidates}`,
    `Confirmed vulnerabilities: ${report.summary.confirmedVulnerabilities}`,
    "",
    report.conclusion,
  ];
  for (const finding of report.findings) {
    lines.push("", `${finding.class} ${finding.status}: ${finding.serviceName || finding.serviceId || "unknown service"}`, `  ${finding.url || "unknown endpoint"}`);
    for (const missing of finding.missingProof) lines.push(`  Missing proof: ${missing}`);
  }
  if (report.summary.truncatedEndpoints) lines.push("", `Warning: ${report.summary.truncatedEndpoints} endpoints had truncated offer lists.`);
  return `${lines.join("\n")}\n`;
}

function parseArguments(argv) {
  const result = { baseUrl: DEFAULT_BASE_URL, input: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") result.json = true;
    else if (arg === "--input") result.input = argv[++index] ?? null;
    else if (arg === "--base-url") result.baseUrl = argv[++index] ?? "";
    else if (arg === "--help" || arg === "-h") return { help: true };
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: npm run audit:index -- [--json] [--base-url https://mpp.ninja] [--input endpoints.json]\n\nThe command reads only the mpp.ninja index API (or a local JSON export). It never contacts indexed services.\n");
    return;
  }
  let endpoints;
  let source;
  if (options.input) {
    const document = JSON.parse(await readFile(options.input, "utf8"));
    endpoints = Array.isArray(document) ? document : document.data;
    if (!Array.isArray(endpoints)) throw new Error("Input must be an endpoint array or an API document with a data array");
    source = options.input;
  } else {
    endpoints = await fetchEndpointIndex(options.baseUrl);
    source = new URL("/api/endpoints", normalizeBaseUrl(options.baseUrl)).toString();
  }
  const report = analyzeEndpoints(endpoints, source);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatText(report));
  if (report.summary.truncatedEndpoints) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`audit:index: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
