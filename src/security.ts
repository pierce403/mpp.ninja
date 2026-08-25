import type { DnsEvidence } from "./model";

export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_DISCOVERY_BYTES = 1024 * 1024;
export const MAX_REDIRECTS = 3;
export const PROBE_TIMEOUT_MS = 8_000;

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-payment",
  "x-payment-intent",
  "x-mpp-payment",
  "payment-signature",
  "payment-credential",
  "payment-receipt",
  "payment-response",
  "x-payment-response",
]);

// Retain only response metadata consumed by the index or conservative
// implementation fingerprinting. All other header values are attacker
// controlled and add disclosure risk without improving the observation.
const SAFE_RESPONSE_METADATA_HEADERS = new Set([
  "content-type",
  "server",
  "x-mpp-proxy",
]);

export class ScanSafetyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ScanSafetyError";
  }
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  return nums.every((part) => part >= 0 && part <= 255) ? nums : null;
}

function expandIpv6(value: string): number[] | null {
  const zoneFree = value.toLowerCase().split("%")[0];
  if (!zoneFree.includes(":")) return null;
  const ipv4Tail = zoneFree.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  let normalized = zoneFree;
  if (ipv4Tail) {
    const bytes = parseIpv4(ipv4Tail);
    if (!bytes) return null;
    normalized = normalized.slice(0, -ipv4Tail.length) + `${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const split = normalized.split("::");
  if (split.length > 2) return null;
  const left = split[0] ? split[0].split(":") : [];
  const right = split[1] ? split[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((split.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

// Fail closed against IANA's current IPv6 Global Unicast Address Space
// registry. New allocations must be reviewed and added deliberately rather
// than inheriting scanner reachability merely because they fall in 2000::/3.
const PUBLIC_IPV6_PREFIXES: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0x2001,0x0200],23], [[0x2001,0x0400],23], [[0x2001,0x0600],23],
  [[0x2001,0x0800],22], [[0x2001,0x0c00],23], [[0x2001,0x0e00],23],
  [[0x2001,0x1200],23], [[0x2001,0x1400],22], [[0x2001,0x1800],23],
  [[0x2001,0x1a00],23], [[0x2001,0x1c00],22], [[0x2001,0x2000],19],
  [[0x2001,0x4000],23], [[0x2001,0x4200],23], [[0x2001,0x4400],23],
  [[0x2001,0x4600],23], [[0x2001,0x4800],23], [[0x2001,0x4a00],23],
  [[0x2001,0x4c00],23], [[0x2001,0x5000],20], [[0x2001,0x8000],19],
  [[0x2001,0xa000],20], [[0x2001,0xb000],20], [[0x2003],18],
  [[0x2400],12], [[0x2410],12], [[0x2600],12], [[0x2610],23],
  [[0x2620],23], [[0x2630],12], [[0x2800],12], [[0x2a00],12],
  [[0x2a10],12], [[0x2c00],12],
];

function matchesIpv6Prefix(address:number[],prefix:readonly number[],bits:number):boolean{
  let remaining=bits;
  for(let index=0;remaining>0;index+=1){
    const width=Math.min(16,remaining);
    const mask=width===16?0xffff:(0xffff<<(16-width))&0xffff;
    if((address[index]&mask)!==((prefix[index]??0)&mask))return false;
    remaining-=width;
  }
  return true;
}

export function isPrivateOrReservedIp(value: string): boolean {
  const ipv4 = parseIpv4(value);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  const ipv6 = expandIpv6(value.replace(/^\[|\]$/g, ""));
  if (!ipv6) return true;
  // Documentation space is nested inside an older APNIC aggregate.
  if(matchesIpv6Prefix(ipv6,[0x2001,0x0db8],32))return true;
  return !PUBLIC_IPV6_PREFIXES.some(([prefix,bits])=>matchesIpv6Prefix(ipv6,prefix,bits));
}

export function normalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ScanSafetyError("invalid-url", "URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ScanSafetyError("unsafe-scheme", "Only HTTP and HTTPS are allowed");
  if (url.username || url.password) throw new ScanSafetyError("credentials-in-url", "Embedded URL credentials are not allowed");
  if (url.port && !["80", "443"].includes(url.port)) throw new ScanSafetyError("unsafe-port", "Only ports 80 and 443 are allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/,"");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")) {
    throw new ScanSafetyError("private-host", "Local and internal hostnames are blocked");
  }
  if (parseIpv4(hostname) || hostname.includes(":")) {
    if (isPrivateOrReservedIp(hostname)) throw new ScanSafetyError("private-ip", "Private or reserved IP targets are blocked");
  }
  url.hostname = hostname;
  url.hash = "";
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  return url.toString();
}

/**
 * Normalizes an advertised discovery URL without retaining query credentials.
 * Public catalogs and OpenAPI documents are untrusted; their query strings are
 * neither required for passive discovery nor safe to persist or replay.
 */
export function normalizeDiscoveryUrl(input: string): string {
  const url = new URL(normalizeUrl(input));
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function redactHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  const safe: Record<string, string> = {};
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (name === "www-authenticate") {
      // Normalized Payment fields are stored separately. Keeping the raw
      // challenge adds credential-leak risk without adding useful evidence.
      safe[name] = /\bPayment\s+/i.test(value) ? "Payment [parsed-and-redacted]" : "[redacted]";
      continue;
    }
    if(name==="location"||name==="content-location"){safe[name]=sanitizeLocationHeader(value);continue;}
    if (SENSITIVE_HEADERS.has(name) || /token|secret|credential|session|password|passwd|passphrase|auth|signature/i.test(name)) {
      safe[name] = "[redacted]";
      continue;
    }
    safe[name] = SAFE_RESPONSE_METADATA_HEADERS.has(name) ? redactText(value.slice(0, 4096)) : "[redacted]";
  }
  return safe;
}

export function redactUrlForStorage(value:string):string{
  try{
    const url=new URL(value);url.username="";url.password="";url.search="";url.hash="";
    const segments=url.pathname.split("/");let redactNext=false;
    url.pathname=segments.map((segment)=>{
      if(!segment)return segment;
      let decoded=segment;try{decoded=decodeURIComponent(segment);}catch{ /* retain encoded form */ }
      const jwt=/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(decoded);
      const explicit=/(?:^|[-_.])(bearer|jwt|secret|credential|session|signature|api[-_]?key)(?:$|[-_.=])/i.test(decoded);
      const highEntropy=decoded.length>=48&&/^[A-Za-z0-9_-]+$/.test(decoded);
      const redact=redactNext||jwt||explicit||highEntropy;
      redactNext=/^(?:reset|recover|recovery|verify|verification|oauth|authorize|authentication)$/i.test(decoded);
      return redact?"[redacted]":segment;
    }).join("/");
    return url.toString();
  }catch{return"[redacted-invalid-url]";}
}

function sanitizeLocationHeader(value:string):string{try{const relativeBase="https://redaction.invalid";const url=new URL(value,relativeBase);if(!["http:","https:"].includes(url.protocol))return"[redacted-unsafe-location]";const sanitized=new URL(redactUrlForStorage(url.toString()));return sanitized.origin===relativeBase?sanitized.pathname:sanitized.toString();}catch{return"[redacted-invalid-location]";}}

const SENSITIVE_KEY = /cookie|token|secret|credential|password|passwd|passphrase|api.?key|access.?key|private.?key|client.?key|jwt|proof|signature|payment.?(?:receipt|response)/i;
const PUBLIC_AUTHORIZATION_METADATA_KEY = /^(?:max)?authorization(?:window|limit|limits|amount|exposure|duration|ttl)$/;

function isSensitiveJsonKey(key:string):boolean{
  const compact=key.toLowerCase().replace(/[^a-z0-9]/g,"");
  if(PUBLIC_AUTHORIZATION_METADATA_KEY.test(compact))return SENSITIVE_KEY.test(key);
  return compact.includes("authorization")||SENSITIVE_KEY.test(key);
}

/** Redacts secret-shaped keys and bounds attacker-controlled JSON before storage or API use. */
export function redactJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[max-depth]";
  if (typeof value === "string") return redactText(value.slice(0, 16_384));
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => redactJsonValue(item, depth + 1));
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 256);
  const publicKeys=new Set(entries.filter(([key])=>!isSensitiveJsonKey(key)).map(([key])=>key.slice(0,256)));
  const redacted:Record<string,unknown>={};let sensitiveOrdinal=0;
  for(const [rawKey,item] of entries){
    if(!isSensitiveJsonKey(rawKey)){redacted[rawKey.slice(0,256)]=redactJsonValue(item,depth+1);continue;}
    let placeholder:string;
    do{placeholder=`[redacted-sensitive-key-${sensitiveOrdinal++}]`;}while(publicKeys.has(placeholder)||Object.hasOwn(redacted,placeholder));
    redacted[placeholder]="[redacted]";
  }
  return redacted;
}

export function redactText(value: string): string {
  return value
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,"[redacted-jwt]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/((?:authorization|proxy-authorization|cookie|set-cookie|token|secret|credential|password|passwd|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|signature|payment[_-]?(?:credential|signature|receipt|response))\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1"[redacted]"');
}

export async function readBoundedBody(response: Response, limit = MAX_RESPONSE_BYTES): Promise<{ text: string; bytes: number }> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) throw new ScanSafetyError("response-too-large", `Response exceeds ${limit} bytes`);
  if (!response.body) return { text: "", bytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new ScanSafetyError("response-too-large", `Response exceeds ${limit} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(joined), bytes: total };
}

interface DnsJsonAnswer { type?: number; data?: string }
interface DnsJsonResponse { Status?: number; Answer?: DnsJsonAnswer[] }

export type DnsResolver = (hostname: string, type: "A" | "AAAA") => Promise<string[]>;

async function doh(hostname: string, type: "A" | "AAAA"): Promise<string[]> {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
    headers: { Accept: "application/dns-json", "User-Agent": "mpp.ninja-observatory/1.0" },
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new ScanSafetyError("dns-failed", `DNS lookup failed with ${response.status}`);
  const data = await response.json<DnsJsonResponse>();
  if (data.Status !== 0) return [];
  const expected = type === "A" ? 1 : 28;
  return (data.Answer ?? []).filter((answer) => answer.type === expected && typeof answer.data === "string").map((answer) => answer.data as string);
}

export async function resolvePublicHostname(hostname: string, resolver: DnsResolver = doh): Promise<DnsEvidence> {
  if (parseIpv4(hostname) || hostname.includes(":")) {
    if (isPrivateOrReservedIp(hostname)) throw new ScanSafetyError("private-ip", "Private or reserved IP targets are blocked");
    return { hostname, addresses: [hostname], stable: true };
  }
  const resolveOnce = async () => {const [ipv4,ipv6]=await Promise.all([resolver(hostname,"A"),resolver(hostname,"AAAA")]);return[...new Set([...ipv4,...ipv6])].sort();};
  const first = await resolveOnce();
  const second = await resolveOnce();
  if (first.length === 0 || second.length === 0) throw new ScanSafetyError("dns-empty", "Target has no public A or AAAA records");
  for (const address of [...first, ...second]) {
    if (isPrivateOrReservedIp(address)) throw new ScanSafetyError("private-dns-answer", "DNS resolved to a private or reserved address");
  }
  if (first.join(",") !== second.join(",")) throw new ScanSafetyError("dns-rebinding", "DNS answers changed during validation");
  return { hostname, addresses: first, stable: true };
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u2028\u2029]/g, "");
}
