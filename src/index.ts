import { enqueueDueTargets, enqueueTarget, importMppCatalog, processCatalogService, processDueTarget } from "./catalog";
import { MAX_CATALOG_ENDPOINTS_PER_SERVICE } from "./budgets";
import { processApiCatalogLink, processCrawlMessage, processOpenApiOperation, RetryableCrawlError } from "./crawler";
import { failSourceSnapshot, failStaleSourceSnapshots, getService, getStats, listChanges, listEndpoints, listImplementations, listServices, parseDetailPage, parsePage, sourceSnapshotStatus, upsertDiscoveredServiceUrl } from "./db";
import type { ApiCatalogLinkMessage, CatalogIngestMessage, CrawlMessage, DueTargetMessage, ObservatoryQueueMessage, OpenApiOperationMessage, UrlDiscoveryMessage } from "./model";
import { importMppScan, processMppScanCandidate } from "./mppscan";
import { pruneRetainedData } from "./retention";
import { ScanSafetyError, normalizeUrl, readBoundedBody, redactJsonValue, redactText, redactUrlForStorage, resolvePublicHostname, safeJson } from "./security";
import { attachManualSubmissionService, consumeSubmissionBudget, expireManualCandidates, reserveManualSubmission } from "./submissions";
import { renderChanges, renderDashboard, renderImplementations, renderMethodology, renderNotFound, renderServiceDetail, renderServices, renderSubmissionForm } from "./ui";

const APP_VERSION="0.1.0";
const TERMINAL_QUEUE_ATTEMPT=6;

const SECURITY_HEADERS: Record<string,string> = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function response(body:BodyInit|null,init:ResponseInit={},api=false):Response{
  const headers=new Headers(init.headers);
  for(const [name,value] of Object.entries(SECURITY_HEADERS))headers.set(name,value);
  if(api){headers.set("Access-Control-Allow-Origin","*");headers.set("Cross-Origin-Resource-Policy","cross-origin");headers.set("Cache-Control","public, max-age=30, s-maxage=60");}
  return new Response(body,{...init,headers});
}

function html(body:string,status=200,head=false):Response{return response(head?null:body,{status,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=15, s-maxage=30"}});}
function json(value:unknown,status=200,head=false):Response{return response(head?null:safeJson(redactJsonValue(value)),{status,headers:{"Content-Type":"application/json; charset=utf-8"}},true);}
function errorJson(status:number,code:string,message:string,head=false):Response{const result=json({error:{code,message}},status,head);result.headers.set("Cache-Control","no-store");return result;}

async function handleGet(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
  const url=new URL(request.url);
  const head=request.method==="HEAD";
  if(url.pathname==="/api/services")return json(await listServices(env.DB,parsePage(url)),200,head);
  const apiService=url.pathname.match(/^\/api\/services\/([^/]+)$/);
  if(apiService){const id=safeDecodePath(apiService[1]);if(id===null)return errorJson(404,"not-found","Service not found",head);const item=await getService(env.DB,id,parseDetailPage(url));return item?json(item,200,head):errorJson(404,"not-found","Service not found",head);}
  if(url.pathname==="/api/endpoints")return json(await listEndpoints(env.DB,url),200,head);
  if(url.pathname==="/api/implementations")return json(await listImplementations(env.DB),200,head);
  if(url.pathname==="/api/changes")return json(await listChanges(env.DB,url),200,head);
  if(url.pathname==="/api/stats"){
    const stats=await getStats(env.DB);
    return json({...stats,appVersion:APP_VERSION,deployment:{id:env.VERSION.id,tag:env.VERSION.tag,timestamp:env.VERSION.timestamp},scanner:{mode:"harmless-unauthenticated",payments:false,credentials:false}},200,head);
  }

  if(url.pathname==="/"){
    const [stats,services,changes]=await Promise.all([getStats(env.DB),listServices(env.DB,{limit:8,offset:0}),listChanges(env.DB,new URL("https://mpp.ninja/api/changes?limit=8"))]);
    if(url.searchParams.get("bootstrap")==="1"&&Number(stats.services??0)===0&&await acquireBootstrapLease(env.DB))ctx.waitUntil(runScheduled(env));
    return html(renderDashboard(stats,services,changes),200,head);
  }
  if(url.pathname==="/services")return html(renderServices(await listServices(env.DB,parsePage(url)),url),200,head);
  const servicePath=url.pathname.match(/^\/services\/([^/]+)$/);
  if(servicePath){const id=safeDecodePath(servicePath[1]);if(id===null)return html(renderNotFound(),404,head);const item=await getService(env.DB,id,parseDetailPage(url));return item?html(renderServiceDetail(item),200,head):html(renderNotFound(),404,head);}
  if(url.pathname==="/implementations")return html(renderImplementations(await listImplementations(env.DB)),200,head);
  if(url.pathname==="/changes")return html(renderChanges(await listChanges(env.DB,new URL(`${url.origin}/api/changes${url.search}`))),200,head);
  if(url.pathname==="/methodology")return html(renderMethodology(),200,head);
  if(url.pathname==="/submit"){
    const status=url.searchParams.get("status");
    const normalizedUrl=url.searchParams.get("url")??undefined;
    const result=status?{tone:status==="queued"?"success" as const:status==="duplicate"?"info" as const:"error" as const,title:status==="queued"?"Submission queued":status==="duplicate"?"Already scheduled":"Submission rejected",message:status==="queued"?"The URL passed validation and harmless discovery was scheduled.":status==="duplicate"?"This URL is already in the discovery schedule; no duplicate work was created.":"The URL could not be safely scheduled.",normalizedUrl}:undefined;
    const page=html(renderSubmissionForm(result),200,head);page.headers.set("Cache-Control","no-store");return page;
  }
  return url.pathname.startsWith("/api/")?errorJson(404,"not-found","API route not found",head):html(renderNotFound(),404,head);
}

async function handleSubmission(request:Request,env:Env):Promise<Response>{
  const requestOrigin=request.headers.get("origin");
  if(requestOrigin&&requestOrigin!==new URL(request.url).origin)return errorJson(403,"cross-origin","Cross-origin submissions are not accepted");
  const declared=Number(request.headers.get("content-length")??"0");
  if(Number.isFinite(declared)&&declared>8_192)return errorJson(413,"request-too-large","Submission exceeds 8 KiB");
  let rawUrl:string|undefined;
  let sourceNote="";
  try{
    const contentType=(request.headers.get("content-type")??"").toLowerCase();
    if(!contentType.includes("application/json")&&!contentType.includes("application/x-www-form-urlencoded"))return errorJson(415,"unsupported-media-type","Use JSON or URL-encoded form data");
    const {text}=await readBoundedBody(new Response(request.body,{headers:request.headers}),8_192);
    if(contentType.includes("application/json")){const value=JSON.parse(text) as Record<string,unknown>;rawUrl=typeof value.url==="string"?value.url:undefined;sourceNote=typeof value.sourceNote==="string"?value.sourceNote:"";}
    else{const form=new URLSearchParams(text);rawUrl=form.get("url")??undefined;sourceNote=form.get("sourceNote")??"";}
  }catch(error){return error instanceof ScanSafetyError&&error.code==="response-too-large"?errorJson(413,"request-too-large","Submission exceeds 8 KiB"):errorJson(400,"invalid-body","Expected JSON or form data");}
  if(!rawUrl||rawUrl.length>2_048)return errorJson(400,"invalid-url","A URL of at most 2,048 characters is required");
  let normalized:string;
  try{normalized=normalizeUrl(rawUrl);}catch(error){
    const message=error instanceof Error?error.message:"URL failed safety validation";
    return submissionResult(request,"rejected",undefined,message,400);
  }
  if(new URL(normalized).search)return submissionResult(request,"rejected",undefined,"Query-bearing submission URLs are not accepted; submit the public service base instead",400);
  if(redactUrlForStorage(normalized)!==normalized)return submissionResult(request,"rejected",undefined,"Credential-shaped URL paths are not accepted; submit the public service base instead",400);
  const existing=await env.DB.prepare("SELECT status FROM submissions WHERE normalized_url=?").bind(normalized).first<{status:string}>();
  if(existing)return submissionResult(request,"duplicate",normalized,"Already scheduled",200);
  if(!await consumeSubmissionBudget(env.DB,request)){const limited=errorJson(429,"rate-limited","Submission capacity is temporarily exhausted; retry shortly");limited.headers.set("Retry-After","300");return limited;}
  try{await resolvePublicHostname(new URL(normalized).hostname);}catch(error){const message=error instanceof Error?error.message:"URL failed safety validation";return submissionResult(request,"rejected",undefined,message,400);}
  const note=redactText(sourceNote).slice(0,500);
  const now=new Date().toISOString();
  const reservation=await reserveManualSubmission(env.DB,{normalizedUrl:normalized,origin:new URL(normalized).origin,submittedAt:now,sourceNote:note||null});
  if(reservation==="duplicate")return submissionResult(request,"duplicate",normalized,"Already scheduled",200);
  if(reservation==="capacity"){const limited=errorJson(429,"candidate-capacity","Unconfirmed candidate retention is at capacity; retry after existing candidates are confirmed or retired");limited.headers.set("Retry-After","86400");return limited;}
  try{
    const serviceId=await upsertDiscoveredServiceUrl(env.DB,normalized,"manual","https://mpp.ninja/submit",now);
    await attachManualSubmissionService(env.DB,normalized,serviceId);
    const provenance={sourceType:"manual" as const,sourceRef:"https://mpp.ninja/submit",observedAt:now};
    await enqueueTarget(env,{type:"probe",url:normalized,serviceId,kind:"endpoint",source:"manual"},30,false,provenance);
    const openapi=new URL("openapi.json",normalized.endsWith("/")?normalized:`${normalized}/`).toString();
    if(openapi!==normalized)await enqueueTarget(env,{type:"probe",url:openapi,serviceId,kind:"openapi",source:"manual"},60,false,provenance);
    await enqueueTarget(env,{type:"probe",url:new URL("/.well-known/api-catalog",normalized).toString(),serviceId,kind:"api-catalog",source:"manual"},60,false,provenance);
  }catch(error){
    await env.DB.prepare("UPDATE submissions SET status='retry',last_error='scheduling-failed' WHERE normalized_url=?").bind(normalized).run().catch(()=>undefined);
    throw error;
  }
  return submissionResult(request,"queued",normalized,"Harmless discovery scheduled",202);
}

async function acquireBootstrapLease(db:D1Database):Promise<boolean>{const now=new Date();const next=new Date(now.getTime()+10*60*1_000).toISOString();const result=await db.prepare("INSERT INTO origin_rate_limits (origin,next_allowed_at,updated_at) VALUES ('internal:bootstrap',?,?) ON CONFLICT(origin) DO UPDATE SET next_allowed_at=excluded.next_allowed_at,updated_at=excluded.updated_at WHERE origin_rate_limits.next_allowed_at<=?").bind(next,now.toISOString(),now.toISOString()).run();return Number(result.meta.changes??0)>0;}

function submissionResult(request:Request,status:"queued"|"duplicate"|"rejected",url:string|undefined,message:string,code:number):Response{
  const acceptsJson=(request.headers.get("accept")??"").includes("application/json")||(request.headers.get("content-type")??"").includes("application/json");
  if(acceptsJson)return json({status,url,message},code);
  const location=new URL("/submit",request.url);location.searchParams.set("status",status);if(url)location.searchParams.set("url",url);
  return response(null,{status:303,headers:{Location:location.toString(),"Cache-Control":"no-store"}});
}

function safeDecodePath(value:string):string|null{try{return decodeURIComponent(value);}catch{return null;}}

async function handleFetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
  try{
    if(request.method==="GET"||request.method==="HEAD")return await handleGet(request,env,ctx);
    if(request.method==="POST"&&new URL(request.url).pathname==="/api/submissions"){const result=await handleSubmission(request,env);result.headers.set("Cache-Control","no-store");return result;}
    const api=new URL(request.url).pathname.startsWith("/api/");
    const result=api?errorJson(405,"method-not-allowed","Method not allowed"):response("Method Not Allowed\n",{status:405,headers:{"Content-Type":"text/plain; charset=utf-8"}});
    result.headers.set("Allow",new URL(request.url).pathname==="/api/submissions"?"POST":"GET, HEAD");return result;
  }catch(error){
    console.error("request-failed",error);
    return errorJson(500,"internal-error","The observatory could not complete this request");
  }
}

function isRecord(value:unknown):value is Record<string,unknown>{return Boolean(value&&typeof value==="object"&&!Array.isArray(value));}
function boundedString(value:unknown,max:number):value is string{return typeof value==="string"&&value.length>0&&value.length<=max;}
function isCatalogMessage(value:unknown):value is CatalogIngestMessage{if(!isRecord(value)||value.type!=="catalog-service"||!isRecord(value.service))return false;const service=value.service;return boundedString(value.sourceUrl,2_048)&&boundedString(value.observedAt,64)&&boundedString(value.discoveryRunId,128)&&boundedString(value.snapshotId,200)&&boundedString(value.itemId,500)&&Number.isSafeInteger(value.expectedItems)&&Number(value.expectedItems)>=1&&Number(value.expectedItems)<=MAX_CATALOG_ENDPOINTS_PER_SERVICE&&boundedString(service.id,500)&&boundedString(service.name,500)&&boundedString(service.serviceUrl,2_048)&&(!service.endpoints||(Array.isArray(service.endpoints)&&service.endpoints.length<=1));}
function isUrlDiscoveryMessage(value:unknown):value is UrlDiscoveryMessage{return isRecord(value)&&value.type==="url-discovery"&&value.source==="mppscan"&&boundedString(value.url,2_048)&&boundedString(value.sourceUrl,2_048)&&boundedString(value.observedAt,64)&&boundedString(value.discoveryRunId,128);}
function isApiCatalogLinkMessage(value:unknown):value is ApiCatalogLinkMessage{return isRecord(value)&&value.type==="api-catalog-link"&&boundedString(value.url,2_048)&&boundedString(value.serviceId,120)&&boundedString(value.sourceRef,2_048)&&boundedString(value.observedAt,64)&&boundedString(value.snapshotId,200)&&boundedString(value.itemId,500);}
function isDueTargetMessage(value:unknown):value is DueTargetMessage{return isRecord(value)&&value.type==="due-target"&&boundedString(value.url,2_048)&&["endpoint","openapi","api-catalog","homepage"].includes(String(value.kind))&&(!value.serviceId||boundedString(value.serviceId,120))&&(!value.endpointId||boundedString(value.endpointId,120));}
function isOpenApiOperationMessage(value:unknown):value is OpenApiOperationMessage{if(!isRecord(value)||value.type!=="openapi-operation"||!isRecord(value.operation))return false;const operation=value.operation;return boundedString(value.serviceId,120)&&boundedString(value.baseUrl,2_048)&&boundedString(value.sourceRef,2_048)&&boundedString(value.snapshotId,200)&&boundedString(value.itemId,500)&&boundedString(value.observedAt,64)&&Number.isSafeInteger(value.offerOffset)&&Number(value.offerOffset)>=0&&Number(value.offerOffset)<=31&&boundedString(operation.method,12)&&boundedString(operation.path,2_048)&&typeof operation.description==="string"&&operation.description.length<=2_000&&Array.isArray(operation.offers)&&operation.offers.length===1&&isRecord(operation.offers[0]);}
function isCrawlMessage(value:unknown):value is CrawlMessage{return isRecord(value)&&(value.type===undefined||value.type==="probe")&&boundedString(value.url,2_048)&&(!value.runId||boundedString(value.runId,128))&&["endpoint","openapi","api-catalog","homepage"].includes(String(value.kind))&&["catalog","mppscan","openapi","manual","scheduled"].includes(String(value.source))&&(!value.serviceId||boundedString(value.serviceId,120))&&(!value.endpointId||boundedString(value.endpointId,120));}

async function handleQueue(batch:MessageBatch<ObservatoryQueueMessage>,env:Env):Promise<void>{
  for(const message of batch.messages){
    const snapshotMessage=isCatalogMessage(message.body)||isApiCatalogLinkMessage(message.body)||isOpenApiOperationMessage(message.body)?message.body:null;
    try{
      if(snapshotMessage&&await sourceSnapshotStatus(env.DB,snapshotMessage.snapshotId)==="failed"){
        await failSourceSnapshot(env.DB,snapshotMessage.snapshotId,"late-item-after-snapshot-failure");
        message.ack();
        continue;
      }
      if(isCatalogMessage(message.body))await processCatalogService(env,message.body);
      else if(isUrlDiscoveryMessage(message.body))await processMppScanCandidate(env,message.body);
      else if(isApiCatalogLinkMessage(message.body))await processApiCatalogLink(env,message.body);
      else if(isDueTargetMessage(message.body))await processDueTarget(env,message.body);
      else if(isOpenApiOperationMessage(message.body))await processOpenApiOperation(env,message.body);
      else if(isCrawlMessage(message.body))await processCrawlMessage(env,message.body);
      else throw new ScanSafetyError("invalid-message","Queue message shape is invalid");
      message.ack();
    }catch(error){
      const terminal=error instanceof ScanSafetyError||message.attempts>=TERMINAL_QUEUE_ATTEMPT;
      const detail=error instanceof Error?redactText(error.message).slice(0,500):"snapshot-item-failed";
      if(snapshotMessage&&terminal)await failSourceSnapshot(env.DB,snapshotMessage.snapshotId,detail);
      if(isCatalogMessage(message.body)&&terminal){
        await env.DB.prepare("UPDATE discovery_runs SET status='failed',finished_at=?,error_detail=? WHERE id=? AND status='processing'").bind(new Date().toISOString(),detail,message.body.discoveryRunId).run().catch(()=>undefined);
      }
      if(isUrlDiscoveryMessage(message.body)&&terminal){
        await env.DB.prepare("UPDATE discovery_runs SET status='failed',finished_at=?,error_detail=? WHERE id=? AND status='processing'").bind(new Date().toISOString(),detail,message.body.discoveryRunId).run().catch(()=>undefined);
      }
      if(error instanceof ScanSafetyError){console.warn("queue-rejected",error.code,error.message);message.ack();continue;}
      const attempt=Math.max(1,message.attempts);
      const delay=error instanceof RetryableCrawlError&&error.code==="origin-rate-limited"?Math.min(900,30*attempt):Math.min(3600,30*(2**Math.min(7,attempt-1)));
      console.error("queue-retry",error);message.retry({delaySeconds:delay});
    }
  }
}

async function runScheduled(env:Env):Promise<void>{
  const now=new Date().toISOString();
  await env.DB.prepare("DELETE FROM submission_rate_windows WHERE expires_at<?").bind(now).run();
  await expireManualCandidates(env.DB,now);
  await failStaleSourceSnapshots(env.DB,now);
  await pruneRetainedData(env.DB,new Date(now));
  const results=await Promise.allSettled([importMppCatalog(env),importMppScan(env),enqueueDueTargets(env,100)]);
  for(const result of results)if(result.status==="rejected")console.error("scheduled-task-failed",result.reason);
}

export default {
  fetch:handleFetch,
  queue:handleQueue,
  scheduled(_controller,env,ctx){ctx.waitUntil(runScheduled(env));},
} satisfies ExportedHandler<Env,ObservatoryQueueMessage>;
