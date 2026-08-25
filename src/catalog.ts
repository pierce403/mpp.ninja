import { reconcileSourceSnapshot, recordCatalogRunService, recordSourceSnapshotItem, sourceSnapshotItemProcessed, startSourceSnapshot, upsertCatalogService } from "./db";
import { MAX_ACTIVE_CRAWL_TARGETS_PER_SERVICE, MAX_CATALOG_ENDPOINTS_PER_SERVICE, MAX_RETAINED_CRAWL_TARGETS_PER_SERVICE } from "./budgets";
import type { CatalogDocument, CatalogIngestMessage, CrawlMessage, DueTargetMessage } from "./model";
import { MAX_DISCOVERY_BYTES, PROBE_TIMEOUT_MS, ScanSafetyError, normalizeDiscoveryUrl, readBoundedBody, redactJsonValue, redactText, redactUrlForStorage, safeJson, sha256 } from "./security";
import { isRestrictedManualCandidate } from "./submissions";

export const MPP_CATALOG_URL = "https://mpp.dev/api/services";
export const QUEUE_RUN_LIMITS={messages:5_000,expandedBytes:10*1_024*1_024,batches:50} as const;
export interface TargetProvenance { sourceType:"catalog"|"openapi"|"api-catalog"|"manual"|"mppscan";sourceRef:string;observedAt:string }
export async function importMppCatalog(env: Env, now = new Date().toISOString()): Promise<{ services: number; endpoints: number; queued: number }> {
  const runId = await sha256(`mpp.dev|${now}`);
  await env.DB.prepare("INSERT INTO discovery_runs (id,source_kind,source_url,started_at,status) VALUES (?,?,?,?,'running')").bind(runId,"mpp.dev-catalog",MPP_CATALOG_URL,now).run();
  try {
    const response = await fetch(MPP_CATALOG_URL, { redirect:"manual",headers: { Accept: "application/json", "User-Agent": "mpp.ninja-observatory/1.0 (+https://mpp.ninja/methodology)" }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`catalog-http-${response.status}`);
    const { text } = await readBoundedBody(response, MAX_DISCOVERY_BYTES);
    const parsed: unknown = JSON.parse(text);
    if (!validCatalog(parsed)) throw new Error("catalog-invalid-shape");
    const services = dedupeCatalogServices(parsed.services.map(sanitizeCatalogService));
    const prior=await env.DB.prepare("SELECT discovered_services FROM discovery_runs WHERE source_kind='mpp.dev-catalog' AND status='complete' AND id<>? ORDER BY finished_at DESC LIMIT 1").bind(runId).first<{discovered_services:number}>();
    if(Number(prior?.discovered_services??0)>=20&&services.length<Math.ceil(Number(prior?.discovered_services)*0.5))throw new ScanSafetyError("catalog-shrink-guard","Authoritative catalog shrank by more than 50%; absence reconciliation requires a later credible run");
    const plans:Array<{service:CatalogDocument["services"][number];snapshotId:string;expectedItems:number}>=[];
    for(const service of services)plans.push({service,snapshotId:await sha256(safeJson(["catalog",service.serviceUrl,MPP_CATALOG_URL,now])),expectedItems:Math.max(1,service.endpoints?.length??0)});
    const messages=()=>catalogQueueMessages(plans,runId,now);
    measureQueueMessages(messages());
    const endpoints=services.reduce((sum,service)=>sum+(service.endpoints?.length??0),0);
    const queued=plans.reduce((sum,plan)=>sum+plan.expectedItems,0);
    await env.DB.prepare("UPDATE discovery_runs SET status='processing',expected_services=?,discovered_services=?,discovered_endpoints=?,error_detail=NULL WHERE id=? AND status='running'").bind(services.length,services.length,endpoints,runId).run();
    await sendBoundedQueueMessages(env.CRAWL_QUEUE,messages(),true);
    return { services: services.length, endpoints, queued };
  } catch (error) {
    const detail=error instanceof SyntaxError?"catalog-invalid-json":error instanceof Error?redactText(error.message).slice(0,500):"unknown";
    await env.DB.prepare("UPDATE discovery_runs SET finished_at=?,status='failed',error_detail=? WHERE id=? AND status IN ('running','processing')").bind(new Date().toISOString(),detail,runId).run();
    throw error;
  }
}

export async function processCatalogService(env: Env, message: CatalogIngestMessage): Promise<{ endpoints:number;queued:number }>{
  if(await sourceSnapshotItemProcessed(env.DB,message.snapshotId,message.itemId)){
    await reconcileSourceSnapshot(env.DB,message.snapshotId);
    const snapshot=await env.DB.prepare("SELECT service_id FROM source_snapshots WHERE id=?").bind(message.snapshotId).first<{service_id:string}>();
    if(snapshot)await recordCatalogRunService(env.DB,message.discoveryRunId,snapshot.service_id,message.snapshotId,message.observedAt);
    await enqueueCompletedSnapshotTargets(env,message.snapshotId);
    return{endpoints:0,queued:0};
  }
  const result=await upsertCatalogService(env.DB,message.service,message.sourceUrl,message.observedAt,true,message.snapshotId,message.expectedItems);
  await startSourceSnapshot(env.DB,{id:message.snapshotId,serviceId:result.serviceId,sourceType:"catalog",sourceRef:message.sourceUrl,observedAt:message.observedAt,expectedItems:message.expectedItems});
  let queued=0;
  if(message.itemId===`${message.snapshotId}:0`){
    const openApiCandidate=message.service.docs?.apiReference??new URL("openapi.json",ensureTrailingSlash(message.service.serviceUrl)).toString();
    queued+=await enqueueAdvertisedTarget(env,{type:"probe",url:openApiCandidate,serviceId:result.serviceId,kind:"openapi",source:"catalog"},300,{sourceType:"catalog",sourceRef:message.sourceUrl,observedAt:message.observedAt});
    queued+=await enqueueAdvertisedTarget(env,{type:"probe",url:new URL("/.well-known/api-catalog",message.service.serviceUrl).toString(),serviceId:result.serviceId,kind:"api-catalog",source:"catalog"},300,{sourceType:"catalog",sourceRef:message.sourceUrl,observedAt:message.observedAt});
    if((message.service.endpoints??[]).length===0)queued+=await enqueueAdvertisedTarget(env,{type:"probe",url:message.service.serviceUrl,serviceId:result.serviceId,kind:"endpoint",source:"catalog"},300,{sourceType:"catalog",sourceRef:message.sourceUrl,observedAt:message.observedAt});
  }
  for(let index=0;index<(message.service.endpoints??[]).length;index+=1){
    const endpoint=message.service.endpoints?.[index];
    if(!endpoint||!result.endpointIds[index]||!["GET","HEAD"].includes((endpoint.method??"GET").toUpperCase()))continue;
    queued+=await enqueueAdvertisedTarget(env,{type:"probe",url:catalogEndpointUrl(message.service.serviceUrl,endpoint.path),serviceId:result.serviceId,endpointId:result.endpointIds[index],kind:(endpoint.method??"GET").toUpperCase()==="HEAD"?"homepage":"endpoint",source:"catalog"},600,{sourceType:"catalog",sourceRef:message.sourceUrl,observedAt:message.observedAt});
  }
  await recordSourceSnapshotItem(env.DB,message.snapshotId,message.itemId,message.observedAt);
  await recordCatalogRunService(env.DB,message.discoveryRunId,result.serviceId,message.snapshotId,message.observedAt);
  queued+=await enqueueCompletedSnapshotTargets(env,message.snapshotId);
  return{endpoints:result.endpointIds.length,queued};
}

export async function enqueueTarget(env: Env, message: CrawlMessage, maxDelaySeconds: number, forceDue=false,provenance?:TargetProvenance): Promise<number> {
  const normalized = normalizeDiscoveryUrl(message.url);
  if(redactUrlForStorage(normalized)!==normalized)throw new ScanSafetyError("credential-shaped-target","Credential-shaped URL paths are not scheduled or probed");
  const targetId = await crawlTargetId(message,normalized);
  // Every network target must be tied to a normalized service and remain on
  // that service's exact hostname. Advertised cross-host metadata is retained,
  // but it cannot turn catalog/OpenAPI/RFC 9727 input into a blind proxy.
  if(!message.serviceId||!await serviceTargetMatchesHostname(env.DB,message.serviceId,normalized)){
    await env.DB.prepare("UPDATE crawl_targets SET status='retired',next_due_at=NULL,processing_token=NULL,processing_expires_at=NULL,last_error='cross-host-or-missing-service',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(targetId).run();
    return 0;
  }
  // Cron messages can race a manual candidate's first harmless result. Recheck
  // live authority before mutating the target or emitting a probe message.
  if(message.source==="scheduled"&&message.serviceId&&await isRestrictedManualCandidate(env.DB,message.serviceId))return 0;
  if(provenance){
    const snapshot=await env.DB.prepare(`SELECT id,status FROM source_snapshots
      WHERE service_id=? AND source_type=? AND source_ref=? AND observed_at=?
      ORDER BY id LIMIT 1`).bind(message.serviceId,provenance.sourceType,provenance.sourceRef.slice(0,2_048),provenance.observedAt).first<{id:string;status:string}>();
    if(snapshot?.status==="failed")return 0;
    if(snapshot?.status==="running")return stageSnapshotTarget(env.DB,snapshot.id,targetId,normalized,message,provenance);
  }
  let existing = await env.DB.prepare("SELECT status,next_due_at,updated_at,generation,run_id,updated_at<=datetime('now','-5 minutes') AS stale FROM crawl_targets WHERE id=?").bind(targetId).first<{ status:string;next_due_at:string|null;updated_at:string;generation:number;run_id:string|null;stale:number }>();
  let sourceReactivated=false;
  if(existing&&provenance){
    const before=await targetProvenanceState(env.DB,targetId,provenance);
    await recordTargetProvenance(env.DB,targetId,provenance);
    const after=await targetProvenanceState(env.DB,targetId,provenance);
    // Delayed discovery records that lost to a newer authoritative snapshot
    // must not create an otherwise usable open-proxy crawl target.
    if(!after||after.active!==1)return 0;
    sourceReactivated=before?.active===0;
    existing=await env.DB.prepare("SELECT status,next_due_at,updated_at,generation,run_id,updated_at<=datetime('now','-5 minutes') AS stale FROM crawl_targets WHERE id=?").bind(targetId).first<{ status:string;next_due_at:string|null;updated_at:string;generation:number;run_id:string|null;stale:number }>();
  }
  if(existing?.status==="complete"&&!sourceReactivated&&(!forceDue||!existing.next_due_at||existing.next_due_at>new Date().toISOString()))return 0;
  if(existing?.status==="queued"||existing?.status==="processing"||(existing?.status==="enqueueing"&&!Number(existing.stale)))return 0;
  const digest = await sha256(normalized);
  const delaySeconds = maxDelaySeconds > 0 ? Number.parseInt(digest.slice(0,8),16) % (maxDelaySeconds + 1) : 0;
  const now = new Date();
  const due = new Date(now.getTime()+delaySeconds*1000).toISOString();
  const completedGeneration=sourceReactivated||existing?.status==="complete"||existing?.status==="retired"||existing?.status==="rejected";
  const generation=completedGeneration?Number(existing?.generation??0)+1:Math.max(1,Number(existing?.generation??0));
  const runId=!completedGeneration&&existing?.run_id?existing.run_id:await sha256(safeJson([targetId,generation]));
  let reserved:{id:string}|null;
  try{
    reserved=await env.DB.prepare(`INSERT INTO crawl_targets (id,normalized_url,service_id,endpoint_id,target_kind,source_kind,status,generation,run_id,run_observed_at,next_due_at)
      SELECT ?,?,?,?,?,?,'enqueueing',?,?,NULL,?
      WHERE EXISTS (SELECT 1 FROM crawl_targets existing WHERE existing.id=?) OR ? IS NULL OR (
        (SELECT COUNT(*) FROM crawl_targets retained WHERE retained.service_id=?)<?
        AND (SELECT COUNT(*) FROM crawl_targets active_target WHERE active_target.service_id=?
          AND active_target.status NOT IN ('retired','rejected')
          AND (NOT EXISTS (SELECT 1 FROM crawl_target_sources any_source WHERE any_source.target_id=active_target.id)
            OR EXISTS (SELECT 1 FROM crawl_target_sources active_source WHERE active_source.target_id=active_target.id AND active_source.active=1)))<?
      )
      ON CONFLICT(id) DO UPDATE SET source_kind=CASE WHEN excluded.source_kind='scheduled' THEN crawl_targets.source_kind ELSE excluded.source_kind END,status='enqueueing',generation=excluded.generation,run_id=excluded.run_id,run_observed_at=CASE WHEN crawl_targets.run_id=excluded.run_id THEN crawl_targets.run_observed_at ELSE NULL END,processing_token=NULL,processing_expires_at=NULL,next_due_at=excluded.next_due_at,updated_at=CURRENT_TIMESTAMP
      RETURNING id`).bind(targetId,normalized,message.serviceId??null,message.endpointId??null,message.kind,message.source,generation,runId,due,targetId,message.serviceId??null,message.serviceId??null,MAX_RETAINED_CRAWL_TARGETS_PER_SERVICE,message.serviceId??null,MAX_ACTIVE_CRAWL_TARGETS_PER_SERVICE).first<{id:string}>();
  }catch(error){if(error instanceof Error&&/crawl target .*budget exceeded/i.test(error.message))return 0;throw error;}
  if(!reserved)return 0;
  if(!existing&&provenance){
    await recordTargetProvenance(env.DB,targetId,provenance);
    const source=await targetProvenanceState(env.DB,targetId,provenance);
    if(!source||source.active!==1){
      await env.DB.prepare("UPDATE crawl_targets SET status='retired',next_due_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND run_id=? AND status='enqueueing'").bind(targetId,runId).run();
      return 0;
    }
  }
  try{
    await env.CRAWL_QUEUE.send({...message,url:normalized,runId},{ delaySeconds });
    await env.DB.prepare("UPDATE crawl_targets SET status='queued',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND run_id=? AND status='enqueueing'").bind(targetId,runId).run();
  }catch(error){
    await env.DB.prepare("UPDATE crawl_targets SET status='retry',last_error='queue-send-failed',next_due_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND run_id=? AND status='enqueueing'").bind(targetId,runId).run();
    throw error;
  }
  return 1;
}

async function stageSnapshotTarget(db:D1Database,snapshotId:string,targetId:string,normalized:string,message:CrawlMessage,provenance:TargetProvenance):Promise<number>{
  const existing=await db.prepare("SELECT 1 AS present FROM crawl_targets WHERE id=?").bind(targetId).first();
  let introduced=0;
  try{
    if(!existing){
      const inserted=await db.prepare(`INSERT INTO crawl_targets
        (id,normalized_url,service_id,endpoint_id,target_kind,source_kind,status,generation,next_due_at)
        VALUES (?,?,?,?,?,?,'retired',0,NULL) ON CONFLICT(id) DO NOTHING RETURNING id`)
        .bind(targetId,normalized,message.serviceId??null,message.endpointId??null,message.kind,message.source).first();
      introduced=inserted?1:0;
    }
    await db.prepare(`INSERT INTO source_snapshot_target_stage
      (snapshot_id,target_id,normalized_url,service_id,endpoint_id,target_kind,source_kind,source_type,source_ref,observed_at,introduced)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(snapshot_id,target_id) DO UPDATE SET introduced=MAX(source_snapshot_target_stage.introduced,excluded.introduced)`)
      .bind(snapshotId,targetId,normalized,message.serviceId,message.endpointId??null,message.kind,message.source,provenance.sourceType,provenance.sourceRef.slice(0,2_048),provenance.observedAt,introduced).run();
  }catch(error){
    if(introduced)await db.prepare(`DELETE FROM crawl_targets WHERE id=? AND last_attempt_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM crawl_target_sources source WHERE source.target_id=crawl_targets.id)
      AND NOT EXISTS (SELECT 1 FROM source_snapshot_target_stage staged WHERE staged.target_id=crawl_targets.id)`).bind(targetId).run().catch(()=>undefined);
    if(error instanceof Error&&/crawl target (?:staging )?budget exceeded/i.test(error.message))return 0;
    throw error;
  }
  return 0;
}

/** Queue only target intents whose normalized source snapshot is complete. */
export async function enqueueCompletedSnapshotTargets(env:Env,snapshotId:string):Promise<number>{
  const snapshot=await env.DB.prepare("SELECT service_id,source_type,source_ref,observed_at,status FROM source_snapshots WHERE id=?").bind(snapshotId).first<{service_id:string;source_type:string;source_ref:string;observed_at:string;status:string}>();
  if(snapshot?.status!=="complete")return 0;
  const rows=await env.DB.prepare(`UPDATE crawl_targets SET status='due-queued',updated_at=CURRENT_TIMESTAMP WHERE id IN (
      SELECT target.id FROM crawl_targets target JOIN crawl_target_sources source ON source.target_id=target.id
      WHERE target.service_id=? AND target.status='retry' AND target.next_due_at<=CURRENT_TIMESTAMP
        AND source.source_type=? AND source.source_ref=? AND source.observed_at=? AND source.active=1
      ORDER BY target.id LIMIT ?
    ) RETURNING normalized_url,service_id,endpoint_id,target_kind`).bind(snapshot.service_id,snapshot.source_type,snapshot.source_ref,snapshot.observed_at,MAX_ACTIVE_CRAWL_TARGETS_PER_SERVICE)
    .all<{normalized_url:string;service_id:string;endpoint_id:string|null;target_kind:CrawlMessage["kind"]}>();
  const messages:DueTargetMessage[]=rows.results.map((row)=>({type:"due-target",url:row.normalized_url,serviceId:row.service_id,endpointId:row.endpoint_id??undefined,kind:row.target_kind}));
  try{await sendBoundedQueueMessages(env.CRAWL_QUEUE,messages);}catch(error){
    await env.DB.prepare(`UPDATE crawl_targets SET status='retry',updated_at=CURRENT_TIMESTAMP WHERE status='due-queued' AND service_id=?
      AND EXISTS (SELECT 1 FROM crawl_target_sources source WHERE source.target_id=crawl_targets.id AND source.source_type=? AND source.source_ref=? AND source.observed_at=? AND source.active=1)`)
      .bind(snapshot.service_id,snapshot.source_type,snapshot.source_ref,snapshot.observed_at).run();
    throw error;
  }
  return messages.length;
}

export async function enqueueDueTargets(env:Env,limit=100):Promise<number>{
  const now=new Date().toISOString();
  const rows=await env.DB.prepare(`SELECT normalized_url,service_id,endpoint_id,target_kind FROM crawl_targets ct
    WHERE ((status IN ('complete','retry') AND next_due_at<=?) OR (status IN ('enqueueing','due-queued') AND updated_at<=datetime('now','-5 minutes')))
      AND ct.service_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM crawl_target_sources cts WHERE cts.target_id=ct.id AND cts.active=1)
      AND NOT EXISTS (
        SELECT 1 FROM services candidate
        WHERE candidate.id=ct.service_id
          AND (
            EXISTS (SELECT 1 FROM submissions pending WHERE pending.service_id=ct.service_id AND pending.confirmed_at IS NULL)
            OR EXISTS (
              SELECT 1 FROM crawl_targets manual_target
              JOIN crawl_target_sources manual_authority ON manual_authority.target_id=manual_target.id
              WHERE manual_target.service_id=ct.service_id AND manual_authority.source_type='manual' AND manual_authority.active=1
            )
          )
          AND candidate.status<>'observed-mpp'
          AND NOT EXISTS (
            SELECT 1 FROM crawl_targets trusted_target
            JOIN crawl_target_sources trusted_authority ON trusted_authority.target_id=trusted_target.id
            WHERE trusted_target.service_id=ct.service_id AND trusted_authority.active=1
              AND trusted_authority.source_type IN ('catalog','mppscan')
          )
      )
    ORDER BY COALESCE(next_due_at,updated_at) LIMIT ?`).bind(now,Math.min(250,Math.max(1,limit))).all<{normalized_url:string;service_id:string|null;endpoint_id:string|null;target_kind:CrawlMessage["kind"]}>();
  const messages:DueTargetMessage[]=rows.results.map((row)=>({type:"due-target",url:row.normalized_url,serviceId:row.service_id??undefined,endpointId:row.endpoint_id??undefined,kind:row.target_kind}));
  await sendBoundedQueueMessages(env.CRAWL_QUEUE,messages);
  return messages.length;
}

export async function processDueTarget(env:Env,message:DueTargetMessage):Promise<void>{
  await enqueueTarget(env,{type:"probe",url:message.url,serviceId:message.serviceId,endpointId:message.endpointId,kind:message.kind,source:"scheduled"},300,true);
}

export function validCatalog(value: unknown): value is CatalogDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const root=value as Record<string,unknown>;
  if (!Array.isArray(root.services) || root.services.length===0 || root.services.length>500) return false;
  return root.services.every((service) => {
    if(!service||typeof service!=="object"||Array.isArray(service))return false;
    const row=service as Record<string,unknown>;
    if(typeof row.id!=="string"||row.id.length>500||typeof row.name!=="string"||row.name.length>500||typeof row.serviceUrl!=="string"||row.serviceUrl.length>2_048)return false;
    for(const field of ["url","description","status"]){if(row[field]!==undefined&&typeof row[field]!=="string")return false;}
    for(const field of ["categories","tags"]){if(row[field]!==undefined&&(!Array.isArray(row[field])||(row[field] as unknown[]).length>1_000||(row[field] as unknown[]).some((item)=>typeof item!=="string")))return false;}
    if(row.docs!==undefined){if(!row.docs||typeof row.docs!=="object"||Array.isArray(row.docs))return false;for(const item of Object.values(row.docs as Record<string,unknown>)){if(item!==undefined&&typeof item!=="string")return false;}}
    if(row.endpoints!==undefined){if(!Array.isArray(row.endpoints)||row.endpoints.length>MAX_CATALOG_ENDPOINTS_PER_SERVICE)return false;for(const endpoint of row.endpoints){if(!endpoint||typeof endpoint!=="object"||Array.isArray(endpoint))return false;const item=endpoint as Record<string,unknown>;if(typeof item.path!=="string"||item.path.length>2_048)return false;if(item.method!==undefined&&typeof item.method!=="string")return false;if(item.description!==undefined&&typeof item.description!=="string")return false;if(item.payment!==undefined&&item.payment!==null&&(typeof item.payment!=="object"||Array.isArray(item.payment)))return false;}}
    return true;
  });
}

export function catalogSnapshot(document: CatalogDocument): string {
  return safeJson({ version:document.version,services:document.services.map((service)=>({ id:service.id,name:service.name,serviceUrl:service.serviceUrl,endpoints:(service.endpoints??[]).length })).sort((a,b)=>a.id.localeCompare(b.id)) });
}

function ensureTrailingSlash(value:string):string{return value.endsWith("/")?value:`${value}/`;}
export function catalogEndpointUrl(serviceUrl:string,path:string):string{return new URL(path,ensureTrailingSlash(serviceUrl)).toString();}
function sanitizeCatalogService(service:CatalogDocument["services"][number]):CatalogDocument["services"][number]{return{id:service.id.slice(0,500),name:service.name.slice(0,500),serviceUrl:service.serviceUrl.slice(0,2_048),...(service.url?{url:service.url.slice(0,2_048)}:{}),...(service.description?{description:service.description.slice(0,4_000)}:{}),...(service.categories?{categories:service.categories.filter((item)=>typeof item==="string").slice(0,100).map((item)=>item.slice(0,200))}:{}),...(service.tags?{tags:service.tags.filter((item)=>typeof item==="string").slice(0,100).map((item)=>item.slice(0,200))}:{}),...(service.status?{status:service.status.slice(0,80)}:{}),...(service.docs?{docs:{...(service.docs.homepage?{homepage:service.docs.homepage.slice(0,2_048)}:{}),...(service.docs.llmsTxt?{llmsTxt:service.docs.llmsTxt.slice(0,2_048)}:{}),...(service.docs.apiReference?{apiReference:service.docs.apiReference.slice(0,2_048)}:{})}}:{}),endpoints:(service.endpoints??[]).slice(0,MAX_CATALOG_ENDPOINTS_PER_SERVICE).filter((endpoint)=>typeof endpoint.path==="string"&&endpoint.path.length<=2_048).map((endpoint)=>({path:endpoint.path,method:typeof endpoint.method==="string"?endpoint.method.slice(0,16):undefined,description:typeof endpoint.description==="string"?endpoint.description.slice(0,2_000):undefined,payment:endpoint.payment?boundedPayment(endpoint.payment):undefined}))};}
function dedupeCatalogServices(services:readonly CatalogDocument["services"][number][]):CatalogDocument["services"][number][]{
  const merged=new Map<string,CatalogDocument["services"][number]>();
  for(const service of services){
    let serviceUrl:string;try{serviceUrl=normalizeDiscoveryUrl(service.serviceUrl);if(redactUrlForStorage(serviceUrl)!==serviceUrl)continue;}catch{continue;}const normalized=canonicalCatalogService({...service,serviceUrl});const existing=merged.get(serviceUrl);
    if(!existing){merged.set(serviceUrl,normalized);continue;}
    const existingMetadata={...existing,endpoints:undefined};const nextMetadata={...normalized,endpoints:undefined};const preferred=safeJson(existingMetadata)<=safeJson(nextMetadata)?existing:normalized;
    merged.set(serviceUrl,canonicalCatalogService({...preferred,serviceUrl,endpoints:[...(existing.endpoints??[]),...(normalized.endpoints??[])]}));
  }
  return[...merged.values()].sort((a,b)=>a.serviceUrl.localeCompare(b.serviceUrl));
}
function canonicalCatalogService(service:CatalogDocument["services"][number]):CatalogDocument["services"][number]{
  const choices=new Map<string,{rank:string;endpoint:NonNullable<CatalogDocument["services"][number]["endpoints"]>[number]}>();
  for(const endpoint of service.endpoints??[]){let endpointUrl:string;try{endpointUrl=normalizeDiscoveryUrl(new URL(endpoint.path,service.serviceUrl.endsWith("/")?service.serviceUrl:`${service.serviceUrl}/`).toString());if(redactUrlForStorage(endpointUrl)!==endpointUrl)continue;}catch{continue;}const method=(endpoint.method??"GET").toUpperCase();const normalized={...endpoint,method};const key=`${method}|${endpointUrl}`;const rank=safeJson(normalized);const current=choices.get(key);if(!current||rank<current.rank)choices.set(key,{rank,endpoint:normalized});}
  return{...service,endpoints:[...choices.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,choice])=>choice.endpoint).slice(0,MAX_CATALOG_ENDPOINTS_PER_SERVICE)};
}
export function splitCatalogQueueRecord(service:CatalogDocument["services"][number]):CatalogDocument["services"][number][]{const endpoints=service.endpoints??[];if(endpoints.length===0)return[service];return endpoints.map((endpoint)=>({...service,endpoints:[endpoint]}));}
function boundedPayment(value:Record<string,unknown>):Record<string,unknown>{const redacted=redactJsonValue(value) as Record<string,unknown>;const serialized=safeJson(redacted);return serialized.length<=4_096?redacted:{truncated:true,originalCharacters:serialized.length};}

async function enqueueAdvertisedTarget(env:Env,message:CrawlMessage,maxDelaySeconds:number,provenance:TargetProvenance):Promise<number>{
  try{return await enqueueTarget(env,message,maxDelaySeconds,false,provenance);}catch(error){if(error instanceof ScanSafetyError)return 0;throw error;}
}

async function recordTargetProvenance(db:D1Database,targetId:string,provenance:TargetProvenance):Promise<void>{
  const sourceRef=provenance.sourceRef.slice(0,2_048);
  await db.prepare(`INSERT INTO crawl_target_sources (target_id,source_type,source_ref,first_seen,last_seen,observed_at,active)
    SELECT ?,?,?,?,?,?,CASE WHEN
      (SELECT service_id FROM crawl_targets WHERE id=?) IS NULL OR
      (SELECT COUNT(*) FROM crawl_targets active_target
        WHERE active_target.service_id=(SELECT service_id FROM crawl_targets WHERE id=?)
          AND active_target.id<>?
          AND active_target.status NOT IN ('retired','rejected')
          AND (NOT EXISTS (SELECT 1 FROM crawl_target_sources any_source WHERE any_source.target_id=active_target.id)
            OR EXISTS (SELECT 1 FROM crawl_target_sources active_source WHERE active_source.target_id=active_target.id AND active_source.active=1)))<${MAX_ACTIVE_CRAWL_TARGETS_PER_SERVICE}
      THEN CASE
        WHEN ? IN ('manual','mppscan') THEN 1
        WHEN ?='api-catalog' AND EXISTS (
          SELECT 1 FROM crawl_targets owner JOIN crawl_targets parent ON parent.service_id=owner.service_id
          WHERE owner.id=? AND parent.target_kind='api-catalog' AND parent.normalized_url=?
            AND EXISTS (SELECT 1 FROM crawl_target_sources any_parent WHERE any_parent.target_id=parent.id)
            AND NOT EXISTS (SELECT 1 FROM crawl_target_sources active_parent WHERE active_parent.target_id=parent.id AND active_parent.active=1)
        ) THEN 0
        WHEN ?='openapi' AND EXISTS (
          SELECT 1 FROM crawl_targets owner JOIN crawl_targets parent ON parent.service_id=owner.service_id
          WHERE owner.id=? AND parent.target_kind='openapi' AND parent.normalized_url=?
            AND EXISTS (SELECT 1 FROM crawl_target_sources any_parent WHERE any_parent.target_id=parent.id)
            AND NOT EXISTS (SELECT 1 FROM crawl_target_sources active_parent WHERE active_parent.target_id=parent.id AND active_parent.active=1)
        ) THEN 0
        WHEN EXISTS (SELECT 1 FROM source_snapshots newer JOIN crawl_targets owner ON owner.id=? WHERE newer.service_id=owner.service_id AND newer.source_type=? AND newer.source_ref=? AND newer.observed_at>? AND newer.status='complete') THEN 0
        WHEN ?='catalog' AND EXISTS (SELECT 1 FROM discovery_runs newer WHERE newer.source_kind='mpp.dev-catalog' AND newer.source_url=? AND newer.started_at>? AND newer.status='complete') THEN 0
        ELSE 1 END
      ELSE 0 END
    ON CONFLICT(target_id,source_type,source_ref) DO UPDATE SET last_seen=excluded.last_seen,observed_at=excluded.observed_at,active=CASE WHEN excluded.active=1 THEN 1 ELSE crawl_target_sources.active END
    WHERE excluded.observed_at>=crawl_target_sources.observed_at`)
    .bind(targetId,provenance.sourceType,sourceRef,provenance.observedAt,provenance.observedAt,provenance.observedAt,
      targetId,targetId,targetId,
      provenance.sourceType,
      provenance.sourceType,targetId,sourceRef,
      provenance.sourceType,targetId,sourceRef,
      targetId,provenance.sourceType,sourceRef,provenance.observedAt,
      provenance.sourceType,sourceRef,provenance.observedAt).run();
}

async function targetProvenanceState(db:D1Database,targetId:string,provenance:TargetProvenance):Promise<{active:number}|null>{
  return db.prepare("SELECT active FROM crawl_target_sources WHERE target_id=? AND source_type=? AND source_ref=?")
    .bind(targetId,provenance.sourceType,provenance.sourceRef.slice(0,2_048)).first<{active:number}>();
}

export async function crawlTargetId(message:Pick<CrawlMessage,"serviceId"|"endpointId"|"kind">,normalizedUrl:string):Promise<string>{
  return sha256(safeJson([message.serviceId??null,message.endpointId??null,message.kind,normalizedUrl]));
}

export async function serviceTargetMatchesHostname(db:D1Database,serviceId:string,normalizedUrl:string):Promise<boolean>{
  const service=await db.prepare("SELECT service_url FROM services WHERE id=?").bind(serviceId).first<{service_url:string}>();
  if(!service)return false;
  try{return new URL(service.service_url).hostname===new URL(normalizedUrl).hostname;}catch{return false;}
}

/** Cloudflare permits 100 messages but only 256 KB total per sendBatch call. */
export async function sendBoundedQueueMessages<T>(queue:Queue<T>,messages:Iterable<T>,prevalidated=false):Promise<void>{
  if(!prevalidated&&Array.isArray(messages))measureQueueMessages(messages);
  let batch:Array<{body:T}>=[];let bytes=0;let totalMessages=0;let totalBytes=0;let batches=0;
  for(const body of messages){
    const messageBytes=queueMessageBytes(body);totalMessages+=1;totalBytes+=messageBytes;
    if(messageBytes>120_000)throw new ScanSafetyError("queue-message-too-large","A normalized queue message exceeds the safe size budget");
    if(totalMessages>QUEUE_RUN_LIMITS.messages||totalBytes>QUEUE_RUN_LIMITS.expandedBytes)throw new ScanSafetyError("queue-run-too-large","Normalized queue fan-out exceeds the per-run budget");
    if(batch.length&&(batch.length>=100||bytes+messageBytes>240_000)){batches+=1;if(batches>QUEUE_RUN_LIMITS.batches)throw new ScanSafetyError("queue-run-too-large","Normalized queue fan-out exceeds the batch budget");await sendQueueBatch(queue,batch);batch=[];bytes=0;}
    batch.push({body});bytes+=messageBytes;
  }
  if(batch.length){batches+=1;if(batches>QUEUE_RUN_LIMITS.batches)throw new ScanSafetyError("queue-run-too-large","Normalized queue fan-out exceeds the batch budget");await sendQueueBatch(queue,batch);}
}
async function sendQueueBatch<T>(queue:Queue<T>,batch:Array<{body:T}>):Promise<void>{const candidate=queue as Queue<T>&{sendBatch?:(messages:Array<{body:T}>)=>Promise<void>};if(typeof candidate.sendBatch==="function"){await candidate.sendBatch(batch);return;}for(const {body} of batch)await queue.send(body);}

export function measureQueueMessages<T>(messages:Iterable<T>):{messages:number;expandedBytes:number;batches:number}{let count=0;let expandedBytes=0;let batchItems=0;let batchBytes=0;let batches=0;for(const body of messages){const bytes=queueMessageBytes(body);if(bytes>120_000)throw new ScanSafetyError("queue-message-too-large","A normalized queue message exceeds the safe size budget");if(batchItems&&(batchItems>=100||batchBytes+bytes>240_000)){batches+=1;batchItems=0;batchBytes=0;}count+=1;expandedBytes+=bytes;batchItems+=1;batchBytes+=bytes;if(count>QUEUE_RUN_LIMITS.messages||expandedBytes>QUEUE_RUN_LIMITS.expandedBytes||batches>QUEUE_RUN_LIMITS.batches)throw new ScanSafetyError("queue-run-too-large","Normalized queue fan-out exceeds the per-run budget");}if(batchItems)batches+=1;if(batches>QUEUE_RUN_LIMITS.batches)throw new ScanSafetyError("queue-run-too-large","Normalized queue fan-out exceeds the batch budget");return{messages:count,expandedBytes,batches};}
function queueMessageBytes(value:unknown):number{return new TextEncoder().encode(safeJson(value)).byteLength+100;}
function* catalogQueueMessages(plans:readonly {service:CatalogDocument["services"][number];snapshotId:string;expectedItems:number}[],runId:string,observedAt:string):Generator<CatalogIngestMessage>{for(const plan of plans){for(let index=0;index<plan.expectedItems;index+=1){const endpoint=plan.service.endpoints?.[index];const record:CatalogDocument["services"][number]={...plan.service,endpoints:endpoint?[endpoint]:[]};yield{type:"catalog-service",service:record,sourceUrl:MPP_CATALOG_URL,observedAt,discoveryRunId:runId,snapshotId:plan.snapshotId,itemId:`${plan.snapshotId}:${index}`,expectedItems:plan.expectedItems};}}}
