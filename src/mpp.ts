import type { Fingerprint, IngestedOperation, OpenApiOffer, ParsedChallenge, PaymentOffer, ProbeResult } from "./model";
import { MAX_API_CATALOG_LINKS_PER_DOCUMENT, MAX_OPENAPI_OFFERS_PER_DOCUMENT, MAX_OPENAPI_OPERATIONS_PER_DOCUMENT } from "./budgets";
import { normalizeDiscoveryUrl, redactJsonValue, redactText, safeJson } from "./security";

function decodeBase64UrlJson(value: string): Record<string, unknown> | null {
  try {
    if(!/^[A-Za-z0-9_-]+$/.test(value))return null;
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const MAX_AUTH_HEADER_CHARACTERS=32_768;
const MAX_CHALLENGE_CHARACTERS=8_192;
const AUTH_TOKEN=/^[!#$%&'*+\-.^_`|~0-9A-Za-z]$/;

function splitChallenges(header: string): string[] {
  const starts:Array<{index:number;scheme:string}>=[];
  let quoted = false;
  let escaped = false;

  const recordStart=(candidate:number):void=>{
    let index=candidate;
    while(index<header.length&&/[\t ]/.test(header[index]))index+=1;
    const start=index;
    while(index<header.length&&AUTH_TOKEN.test(header[index]))index+=1;
    if(index===start)return;
    const scheme=header.slice(start,index);
    const tokenEnd=index;
    while(index<header.length&&/[\t ]/.test(header[index]))index+=1;
    // `name = value` after a comma is an auth-param continuation, while a
    // token followed by whitespace, another comma, or EOF begins a challenge.
    if(index<header.length&&header[index]==="=")return;
    if(tokenEnd<header.length&&!/[\t ,]/.test(header[tokenEnd]))return;
    starts.push({index:start,scheme});
  };

  recordStart(0);
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quoted) { escaped = true; continue; }
    if (char === '"') {quoted = !quoted;continue;}
    if(quoted)continue;
    if(char===",")recordStart(index+1);
  }
  const payment:string[]=[];
  for(let index=0;index<starts.length&&payment.length<8;index+=1){
    if(starts[index].scheme.toLowerCase()!=="payment")continue;
    payment.push(header.slice(starts[index].index,starts[index+1]?.index??header.length).replace(/^\s*,\s*|\s*,\s*$/g,""));
  }
  return payment;
}

function parseAuthParams(value: string): {params:Record<string,string>;syntaxError:boolean} {
  const params: Record<string, string> = {};
  const input = value.replace(/^Payment[\t ]+/i, "");
  let index=0;let count=0;let first=true;
  const whitespace=()=>{while(index<input.length&&/[\t ]/.test(input[index]))index+=1;};
  while(index<input.length){
    whitespace();if(index>=input.length)break;
    if(!first){if(input[index]!==",")return{params,syntaxError:true};index+=1;whitespace();}
    first=false;
    const nameStart=index;if(!AUTH_TOKEN.test(input[index]??""))return{params,syntaxError:true};
    index+=1;while(index<input.length&&AUTH_TOKEN.test(input[index]))index+=1;
    const name=input.slice(nameStart,index).toLowerCase();whitespace();if(input[index]!=="="||Object.hasOwn(params,name))return{params,syntaxError:true};index+=1;whitespace();
    let parsed="";
    if(input[index]==='"'){
      index+=1;let closed=false;
      while(index<input.length){const char=input[index++];if(char==='"'){closed=true;break;}if(char==="\\"){if(index>=input.length)return{params,syntaxError:true};parsed+=input[index++];}else parsed+=char;}
      if(!closed)return{params,syntaxError:true};
    }else{
      const valueStart=index;while(index<input.length&&AUTH_TOKEN.test(input[index]))index+=1;if(index===valueStart)return{params,syntaxError:true};parsed=input.slice(valueStart,index);
    }
    params[name]=parsed;count+=1;if(count>32)return{params,syntaxError:true};whitespace();if(index<input.length&&input[index]!==",")return{params,syntaxError:true};
  }
  return{params,syntaxError:false};
}

function invalidChallenge(error:string):ParsedChallenge{return{method:"unknown",intent:"unknown",realm:null,description:null,expires:null,idPresent:false,opaquePresent:false,opaqueMppxScope:false,request:null,parseError:error};}

export function parsePaymentChallenges(header: string | null): ParsedChallenge[] {
  if (!header) return [];
  if(header.length>MAX_AUTH_HEADER_CHARACTERS)return[invalidChallenge("header-too-large")];
  return splitChallenges(header).slice(0,8).map((part) => {
    if(part.length>MAX_CHALLENGE_CHARACTERS)return invalidChallenge("challenge-too-large");
    const parsedParams = parseAuthParams(part);const params=parsedParams.params;
    const decodedRequest = params.request ? decodeBase64UrlJson(params.request) : null;
    const request = decodedRequest ? redactJsonValue(decodedRequest) as Record<string, unknown> : null;
    const decodedOpaque=params.opaque?decodeBase64UrlJson(params.opaque):null;
    const required = ["id", "realm", "method", "intent", "request"];
    const missing = required.filter((name) => !params[name]);
    const invalid=[
      ...(parsedParams.syntaxError?["syntax"]:[]),
      ...(params.method&&!/^[a-z]+$/.test(params.method)?["method"]:[]),
      ...(params.intent&&!/^[A-Za-z0-9-]+$/.test(params.intent)?["intent"]:[]),
      ...(params.request&&!request?["request"]:[]),
      ...(params.opaque&&(!decodedOpaque||Object.values(decodedOpaque).some((value)=>typeof value!=="string"))?["opaque"]:[]),
    ];
    return {
      method: (params.method ?? "unknown").slice(0,40),
      intent: (params.intent ?? "unknown").slice(0,40),
      realm: params.realm ? redactText(params.realm.slice(0,500)) : null,
      description: params.description ? redactText(params.description.slice(0,1_000)) : null,
      expires: params.expires ? redactText(params.expires.slice(0,100)) : null,
      idPresent: Boolean(params.id),
      opaquePresent: Boolean(params.opaque),
      opaqueMppxScope: Boolean(decodedOpaque&&Object.hasOwn(decodedOpaque,"_mppx_scope")),
      request,
      ...(missing.length > 0 || invalid.length>0 ? { parseError: parsedParams.syntaxError ? "invalid:syntax" : missing.length > 0 ? `missing:${missing.join(",")}` : `invalid:${invalid.join(",")}` } : {}),
    };
  });
}

export function isValidPaymentChallenge(challenge:ParsedChallenge):boolean{return !challenge.parseError&&challenge.idPresent&&Boolean(challenge.realm)&&Boolean(challenge.request)&&/^[a-z]+$/.test(challenge.method)&&/^[A-Za-z0-9-]+$/.test(challenge.intent);}

export function challengeToOffer(challenge: ParsedChallenge): PaymentOffer {
  const request = challenge.request ?? {};
  const details = request.methodDetails && typeof request.methodDetails === "object" ? request.methodDetails as Record<string, unknown> : {};
  const known = new Set(["amount", "currency", "recipient", "unitType", "methodDetails"]);
  const session = Object.fromEntries(Object.entries(request).filter(([key]) => !known.has(key)));
  const extraDetails = Object.fromEntries(Object.entries(details).filter(([key]) => !["chainId", "decimals"].includes(key)));
  if (Object.keys(extraDetails).length > 0) session.methodDetails = extraDetails;
  return {
    method: challenge.method,
    intent: challenge.intent,
    amount: typeof request.amount === "string" ? request.amount : null,
    currency: typeof request.currency === "string" ? request.currency : null,
    recipient: typeof request.recipient === "string" ? request.recipient : null,
    chainId: typeof details.chainId === "number" || typeof details.chainId === "string" ? String(details.chainId) : null,
    decimals: typeof details.decimals === "number" ? details.decimals : null,
    unitType: typeof request.unitType === "string" ? request.unitType : null,
    session: Object.keys(session).length > 0 ? session : null,
    sourceType: "challenge",
  };
}

function offersFromPaymentInfo(value: unknown): OpenApiOffer[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const info = value as Record<string, unknown>;
  if (Array.isArray(info.offers)) return info.offers.slice(0,8).filter((offer): offer is OpenApiOffer => Boolean(offer && typeof offer === "object" && !Array.isArray(offer))).map(boundOpenApiOffer);
  if (Array.isArray(info.protocols)) {
    return info.protocols.slice(0,8).flatMap((protocol) => {
      const base = typeof protocol === "string" ? { method: protocol } : protocol && typeof protocol === "object" && !Array.isArray(protocol) ? protocol as Record<string, unknown> : null;
      if (!base) return [];
      const price = info.price;
      const priceFields = price && typeof price === "object" && !Array.isArray(price) ? price as Record<string, unknown> : {};
      return [boundOpenApiOffer({ ...priceFields, ...base, amount: base.amount ?? priceFields.amount ?? (typeof price === "string" || typeof price === "number" ? String(price) : undefined) } as OpenApiOffer)];
    });
  }
  return [boundOpenApiOffer(info)];
}

function boundOpenApiOffer(value: OpenApiOffer): OpenApiOffer {
  const redacted = redactJsonValue(value) as OpenApiOffer;
  if (safeJson(redacted).length <= 4 * 1_024) return redacted;
  const clipped = (item: unknown, max: number): string | undefined => typeof item === "string" || typeof item === "number" ? String(item).slice(0,max) : undefined;
  return {
    method: clipped(redacted.method,40), intent: clipped(redacted.intent,40),
    amount: clipped(redacted.amount,100), currency: clipped(redacted.currency,200),
    recipient: clipped(redacted.recipient,500), decimals: typeof redacted.decimals === "number" ? redacted.decimals : undefined,
    unitType: clipped(redacted.unitType,80),
    ...(clipped(redacted.chainId,100)?{chainId:clipped(redacted.chainId,100)}:{}),
    truncated: true,
  };
}

export function ingestOpenApi(document: unknown): IngestedOperation[] {
  if (!isSupportedOpenApiDocument(document)) return [];
  const root = document as Record<string, unknown>;
  const operations: IngestedOperation[] = [];
  for (const [path, pathValue] of Object.entries(root.paths as Record<string, unknown>)) {
    if (!path.startsWith("/") || path.length > 2_048 || path.includes("?") || path.includes("#") || !pathValue || typeof pathValue !== "object" || Array.isArray(pathValue)) continue;
    for (const [method, operationValue] of Object.entries(pathValue as Record<string, unknown>)) {
      if (operations.length >= MAX_OPENAPI_OPERATIONS_PER_DOCUMENT) break;
      if (!/^(get|head|post|put|patch|delete|options|trace)$/i.test(method) || !operationValue || typeof operationValue !== "object" || Array.isArray(operationValue)) continue;
      const operation = operationValue as Record<string, unknown>;
      const offers = offersFromPaymentInfo(operation["x-payment-info"]).slice(0,8);
      if (offers.length === 0) continue;
      operations.push({
        method: method.toUpperCase(),
        path,
        description: redactText((typeof operation.summary === "string" ? operation.summary : typeof operation.description === "string" ? operation.description : "").slice(0,2_000)),
        offers,
      });
    }
  }
  return operations.sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`));
}

export function isSupportedOpenApiDocument(document:unknown):boolean{
  if(!document||typeof document!=="object"||Array.isArray(document))return false;
  const root=document as Record<string,unknown>;if(typeof root.openapi!=="string"||!root.openapi.startsWith("3.")||!root.paths||typeof root.paths!=="object"||Array.isArray(root.paths))return false;
  let operations=0;let offers=0;
  const methods=/^(get|head|post|put|patch|delete|options|trace)$/i;const nonOperations=new Set(["$ref","summary","description","parameters","servers"]);
  for(const [path,pathValue] of Object.entries(root.paths as Record<string,unknown>)){
    if(path.startsWith("x-")||path.startsWith("$"))continue;
    if(!path.startsWith("/")||path.length>2_048||/[?#]/.test(path)||!pathValue||typeof pathValue!=="object"||Array.isArray(pathValue))return false;
    for(const [key,value] of Object.entries(pathValue as Record<string,unknown>)){
      if(key.startsWith("x-")||nonOperations.has(key))continue;if(!methods.test(key)||!value||typeof value!=="object"||Array.isArray(value))return false;
      const payment=(value as Record<string,unknown>)["x-payment-info"];if(payment===undefined)continue;if(!payment||typeof payment!=="object"||Array.isArray(payment))return false;
      const normalized=offersFromPaymentInfo(payment).slice(0,8);operations+=1;offers+=normalized.length;if(operations>MAX_OPENAPI_OPERATIONS_PER_DOCUMENT||offers>MAX_OPENAPI_OFFERS_PER_DOCUMENT)return false;
    }
  }
  return true;
}

export function ingestApiCatalog(document:unknown,catalogUrl:string):string[]{
  if(!isSupportedApiCatalogDocument(document))return[];
  const linksets=(document as Record<string,unknown>).linkset;
  if(!Array.isArray(linksets))return[];
  const results=new Set<string>();
  for(const entry of linksets.slice(0,MAX_API_CATALOG_LINKS_PER_DOCUMENT)){
    if(!entry||typeof entry!=="object"||Array.isArray(entry))continue;
    const row=entry as Record<string,unknown>;
    for(const relation of ["service-desc","service-doc"]){
      const links=row[relation];if(!Array.isArray(links))continue;
      for(const link of links.slice(0,MAX_API_CATALOG_LINKS_PER_DOCUMENT)){
        if(!link||typeof link!=="object"||Array.isArray(link))continue;
        const record=link as Record<string,unknown>;if(typeof record.href!=="string"||record.href.length>2_048)continue;
        const media=typeof record.type==="string"?record.type.toLowerCase():"";
        if(media&&!/openapi|json/.test(media))continue;
        try{results.add(normalizeDiscoveryUrl(new URL(record.href,catalogUrl).toString()));}catch{ /* malformed advertised link */ }
        if(results.size>=MAX_API_CATALOG_LINKS_PER_DOCUMENT)return[...results];
      }
    }
  }
  return[...results];
}

export function isSupportedApiCatalogDocument(document:unknown):boolean{if(!document||typeof document!=="object"||Array.isArray(document))return false;const linksets=(document as Record<string,unknown>).linkset;if(!Array.isArray(linksets)||linksets.length>MAX_API_CATALOG_LINKS_PER_DOCUMENT)return false;let totalLinks=0;for(const entry of linksets){if(!entry||typeof entry!=="object"||Array.isArray(entry))return false;const row=entry as Record<string,unknown>;for(const relation of ["service-desc","service-doc"]){const links=row[relation];if(links===undefined)continue;if(!Array.isArray(links)||links.length>MAX_API_CATALOG_LINKS_PER_DOCUMENT)return false;totalLinks+=links.length;if(totalLinks>MAX_API_CATALOG_LINKS_PER_DOCUMENT)return false;for(const link of links){if(!link||typeof link!=="object"||Array.isArray(link))return false;const record=link as Record<string,unknown>;if(typeof record.href!=="string"||record.href.length>2_048||(record.type!==undefined&&typeof record.type!=="string"))return false;}}}return true;}

export function fingerprintImplementation(input: Pick<ProbeResult, "status" | "headers" | "challenges" | "bodyText" | "finalUrl">, openApi?: unknown): Fingerprint {
  const evidence: string[] = [];
  const validChallenges = input.status===402 ? input.challenges.filter(isValidPaymentChallenge) : [];
  const challengeRequests = validChallenges.map((challenge) => challenge.request ?? {});
  if (validChallenges.some((challenge) => challenge.opaqueMppxScope) || challengeRequests.some((request)=>hasNamedKey(request,"_mppx_scope"))) evidence.push("mppx scope marker observed in a valid 402 challenge");
  const declaredProducts=explicitOpenApiProducts(openApi);
  if (input.headers["x-mpp-proxy"]?.toLowerCase() === "true"||declaredProducts.has("mpp-proxy")) evidence.push("mpp-proxy product marker observed");
  if (/(?:^|[\s,;(])mpp-rs(?:$|[\s/,;)])/i.test(input.headers.server ?? "")||declaredProducts.has("mpp-rs")) evidence.push("mpp-rs product marker observed");
  if (evidence.some((item) => item.includes("mpp-proxy"))) return { implementation: "mpp-proxy", confidence: 0.95, evidence };
  if (evidence.some((item) => item.includes("mpp-rs"))) return { implementation: "mpp-rs", confidence: 0.9, evidence };
  if (evidence.some((item) => item.includes("mppx"))) return { implementation: "mppx", confidence: 0.85, evidence };
  if (validChallenges.length>0) return { implementation: "custom", confidence: 0.35, evidence: ["valid 402 Payment challenge observed without implementation-specific marker"] };
  return { implementation: "unknown", confidence: 0, evidence: ["no conservative implementation marker observed"] };
}

function hasNamedKey(value:unknown,key:string,depth=0):boolean{
  if(depth>12||!value||typeof value!=="object")return false;
  if(Array.isArray(value))return value.some((item)=>hasNamedKey(item,key,depth+1));
  return Object.entries(value as Record<string,unknown>).some(([name,item])=>name===key||hasNamedKey(item,key,depth+1));
}

function explicitOpenApiProducts(document:unknown):Set<"mpp-proxy"|"mpp-rs">{
  const products=new Set<"mpp-proxy"|"mpp-rs">();
  if(!document||typeof document!=="object"||Array.isArray(document))return products;
  const root=document as Record<string,unknown>;
  const info=root.info&&typeof root.info==="object"&&!Array.isArray(root.info)?root.info as Record<string,unknown>:{};
  for(const container of [root,info]){
    for(const field of ["x-mpp-implementation","x-mpp-generator"]){
      const raw=container[field];
      const value=typeof raw==="string"?raw:raw&&typeof raw==="object"&&!Array.isArray(raw)&&typeof (raw as Record<string,unknown>).name==="string"?(raw as Record<string,unknown>).name as string:null;
      if(!value||value.length>200)continue;
      const normalized=value.trim().toLowerCase();
      if(/^mpp-proxy(?:$|[/@\s-]v?\d)/.test(normalized)||/^cloudflare[ /-]+mpp-proxy(?:$|[/@\s-]v?\d)/.test(normalized)){products.add("mpp-proxy");continue;}
      if(/^mpp-rs(?:$|[/@\s-]v?\d)/.test(normalized))products.add("mpp-rs");
    }
  }
  return products;
}

export function economicRiskMetadata(offer: PaymentOffer): Record<string, number | string | null> {
  const session = offer.session ?? {};
  const deposit = numeric(session.suggestedDeposit ?? session.deposit ?? session.depositAmount);
  const window = numeric(session.authorizationWindow ?? session.maxAmount ?? session.windowAmount ?? session.window);
  const unitPrice = numeric(offer.amount);
  const units = numeric(session.maxUnits ?? session.units);
  return {
    deposit,
    authorizationWindow: window,
    depositWindowRatio: deposit !== null && window !== null && window > 0 ? deposit / window : null,
    observableAuthorizationExposure: window !== null && unitPrice !== null && units !== null ? Math.max(0, window - unitPrice * units) : null,
    note: deposit === null && window === null ? "unknown: session authorization inputs not observable" : "derived only from advertised or challenged values",
  };
}

function numeric(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const raw=String(value).trim();
  if(!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw))return null;
  // Derivations are omitted rather than rounded when an advertised integer or
  // decimal exceeds JavaScript's reliable significant-digit range.
  const significant=raw.replace(/^0+|\.|0+$/g,"");
  if(significant.length>15)return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed<=Number.MAX_SAFE_INTEGER ? parsed : null;
}
