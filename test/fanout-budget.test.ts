import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_ACTIVE_CRAWL_TARGETS_PER_SERVICE,
  MAX_RETAINED_CRAWL_TARGETS_PER_SERVICE,
  MAX_RETAINED_MANUAL_CANDIDATES_GLOBAL,
  MAX_RETAINED_MANUAL_CANDIDATES_PER_ORIGIN,
  MAX_RETAINED_OPENAPI_ENDPOINTS_PER_SERVICE,
  MAX_RETAINED_OPENAPI_OFFERS_PER_SERVICE,
  MAX_SUBMISSIONS_GLOBAL_WINDOW,
  MAX_SUBMISSIONS_PER_CLIENT_WINDOW,
} from "../src/budgets";
import { enqueueTarget } from "../src/catalog";
import { processApiCatalogLink, processCrawlMessage, processOpenApiOperation } from "../src/crawler";
import { startSourceSnapshot, upsertOpenApiOperation } from "../src/db";
import type { ApiCatalogLinkMessage, CrawlMessage, ObservatoryQueueMessage, OpenApiOperationMessage } from "../src/model";
import { consumeSubmissionBudget, expireManualCandidates, reserveManualSubmission } from "../src/submissions";

async function insertService(id:string,url:string,status="candidate"):Promise<void>{
  const parsed=new URL(url);
  await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,status,first_seen,last_seen) VALUES (?,?,?,?,?,?,?)")
    .bind(id,id,url,parsed.origin,status,"2026-08-25T00:00:00.000Z","2026-08-25T00:00:00.000Z").run();
}

describe("per-service retained crawl budgets",()=>{
  it("refuses both a new active target and retired-target reactivation at the active cap",async()=>{
    const serviceId="active-target-budget";await insertService(serviceId,"https://active-budget.example/");
    await env.DB.prepare("INSERT INTO crawl_targets (id,normalized_url,service_id,target_kind,source_kind,status) VALUES ('retired-budget-target','https://active-budget.example/retired',?,'endpoint','catalog','retired')").bind(serviceId).run();
    await env.DB.prepare("INSERT INTO crawl_target_sources (target_id,source_type,source_ref,first_seen,last_seen,observed_at,active) VALUES ('retired-budget-target','catalog','https://mpp.dev/api/services','2026-08-25','2026-08-25','2026-08-25',0)").run();
    await env.DB.prepare(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<?)
      INSERT INTO crawl_targets (id,normalized_url,service_id,target_kind,source_kind,status)
      SELECT 'active-budget-'||value,'https://active-budget.example/'||value,?,'endpoint','catalog','queued' FROM n`)
      .bind(MAX_ACTIVE_CRAWL_TARGETS_PER_SERVICE,serviceId).run();
    const sent:ObservatoryQueueMessage[]=[];const bindings={DB:env.DB,CRAWL_QUEUE:{send:async(body:ObservatoryQueueMessage)=>sent.push(body)}} as unknown as Env;
    expect(await enqueueTarget(bindings,{url:"https://active-budget.example/new",serviceId,kind:"endpoint",source:"catalog"},0,false,{sourceType:"catalog",sourceRef:"https://mpp.dev/api/services",observedAt:"2026-08-25T01:00:00.000Z"})).toBe(0);
    expect(await enqueueTarget(bindings,{url:"https://active-budget.example/retired",serviceId,kind:"endpoint",source:"catalog"},0,false,{sourceType:"catalog",sourceRef:"https://mpp.dev/api/services",observedAt:"2026-08-25T01:00:00.000Z"})).toBe(0);
    expect(sent).toEqual([]);
    const counts=await env.DB.prepare("SELECT COUNT(*) AS retained,SUM(CASE WHEN status NOT IN ('retired','rejected') THEN 1 ELSE 0 END) AS active FROM crawl_targets WHERE service_id=?").bind(serviceId).first<{retained:number;active:number}>();
    expect(counts).toEqual({retained:MAX_ACTIVE_CRAWL_TARGETS_PER_SERVICE+1,active:MAX_ACTIVE_CRAWL_TARGETS_PER_SERVICE});
  });

  it("refuses a new target after the retained historical cap",async()=>{
    const serviceId="retained-target-budget";await insertService(serviceId,"https://retained-budget.example/");
    await env.DB.prepare(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<?)
      INSERT INTO crawl_targets (id,normalized_url,service_id,target_kind,source_kind,status)
      SELECT 'retained-budget-'||value,'https://retained-budget.example/'||value,?,'endpoint','catalog','retired' FROM n`)
      .bind(MAX_RETAINED_CRAWL_TARGETS_PER_SERVICE,serviceId).run();
    const bindings={DB:env.DB,CRAWL_QUEUE:{send:async()=>undefined}} as unknown as Env;
    expect(await enqueueTarget(bindings,{url:"https://retained-budget.example/overflow",serviceId,kind:"endpoint",source:"catalog"},0)).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM crawl_targets WHERE service_id=?").bind(serviceId).first<{count:number}>())?.count).toBe(MAX_RETAINED_CRAWL_TARGETS_PER_SERVICE);
  });
});

describe("OpenAPI normalized storage budgets",()=>{
  it("completes an endpoint snapshot item as a deterministic skip at the retained cap",async()=>{
    const serviceId="openapi-endpoint-budget";const sourceRef="https://openapi-endpoint-budget.example/openapi.json";await insertService(serviceId,"https://openapi-endpoint-budget.example/","observed-mpp");
    await env.DB.prepare(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<?)
      INSERT INTO endpoints (id,service_id,url,http_method,path,first_seen,last_seen)
      SELECT 'openapi-budget-endpoint-'||value,?,'https://openapi-endpoint-budget.example/p-'||value,'GET','/p-'||value,'2026-08-25','2026-08-25' FROM n`)
      .bind(MAX_RETAINED_OPENAPI_ENDPOINTS_PER_SERVICE,serviceId).run();
    await env.DB.prepare("INSERT INTO endpoint_sources (endpoint_id,source_type,source_ref,first_seen,last_seen,observed_at) SELECT id,'openapi',?,'2026-08-25','2026-08-25','2026-08-25' FROM endpoints WHERE service_id=?").bind(sourceRef,serviceId).run();
    const snapshotId="openapi-endpoint-budget-snapshot";await startSourceSnapshot(env.DB,{id:snapshotId,serviceId,sourceType:"openapi",sourceRef,observedAt:"2026-08-25T01:00:00.000Z",expectedItems:1});
    const message:OpenApiOperationMessage={type:"openapi-operation",serviceId,baseUrl:"https://openapi-endpoint-budget.example/",operation:{method:"GET",path:"/overflow",description:"overflow",offers:[{method:"tempo"}]},offerOffset:0,observedAt:"2026-08-25T01:00:00.000Z",sourceRef,snapshotId,itemId:`${snapshotId}:0`};
    const sent:ObservatoryQueueMessage[]=[];await processOpenApiOperation({DB:env.DB,CRAWL_QUEUE:{send:async(body:ObservatoryQueueMessage)=>sent.push(body)}} as unknown as Env,message);
    expect(sent).toEqual([]);
    expect(await env.DB.prepare("SELECT status FROM source_snapshots WHERE id=?").bind(snapshotId).first()).toEqual({status:"complete"});
    expect((await env.DB.prepare("SELECT COUNT(DISTINCT es.endpoint_id) AS count FROM endpoint_sources es JOIN endpoints e ON e.id=es.endpoint_id WHERE e.service_id=? AND es.source_type='openapi'").bind(serviceId).first<{count:number}>())?.count).toBe(MAX_RETAINED_OPENAPI_ENDPOINTS_PER_SERVICE);
  });

  it("completes an offer snapshot item as a deterministic skip at the retained cap",async()=>{
    const serviceId="openapi-offer-budget";const sourceRef="https://openapi-offer-budget.example/openapi.json";await insertService(serviceId,"https://openapi-offer-budget.example/","observed-mpp");
    const endpointId=await upsertOpenApiOperation(env.DB,serviceId,"https://openapi-offer-budget.example/",{method:"GET",path:"/paid",description:"paid",offers:[{method:"tempo"}]},"2026-08-25T00:00:00.000Z",sourceRef);
    await env.DB.prepare(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<?)
      INSERT INTO payment_offers (id,endpoint_id,method,intent,source_type,source_ref,source_ordinal,first_seen,last_seen)
      SELECT 'openapi-budget-offer-'||value,?,'tempo','charge','openapi','seed-'||value,value,'2026-08-25','2026-08-25' FROM n`)
      .bind(MAX_RETAINED_OPENAPI_OFFERS_PER_SERVICE-1,endpointId).run();
    const snapshotId="openapi-offer-budget-snapshot";await startSourceSnapshot(env.DB,{id:snapshotId,serviceId,sourceType:"openapi",sourceRef:"https://openapi-offer-budget.example/second.json",observedAt:"2026-08-25T01:00:00.000Z",expectedItems:1});
    const message:OpenApiOperationMessage={type:"openapi-operation",serviceId,baseUrl:"https://openapi-offer-budget.example/",operation:{method:"GET",path:"/paid",description:"paid",offers:[{method:"evm"}]},offerOffset:0,observedAt:"2026-08-25T01:00:00.000Z",sourceRef:"https://openapi-offer-budget.example/second.json",snapshotId,itemId:`${snapshotId}:0`};
    await processOpenApiOperation({DB:env.DB,CRAWL_QUEUE:{send:async()=>{throw new Error("must not enqueue")}}} as unknown as Env,message);
    expect(await env.DB.prepare("SELECT status FROM source_snapshots WHERE id=?").bind(snapshotId).first()).toEqual({status:"complete"});
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM payment_offers p JOIN endpoints e ON e.id=p.endpoint_id WHERE e.service_id=? AND p.source_type='openapi'").bind(serviceId).first<{count:number}>())?.count).toBe(MAX_RETAINED_OPENAPI_OFFERS_PER_SERVICE);
  });
});

describe("manual submission quotas",()=>{
  it("uses unlinkable short-lived client keys and enforces client and global windows",async()=>{
    const now=Date.parse("2026-08-25T12:01:00.000Z");const ip="198.51.100.77";const request=new Request("https://mpp.ninja/api/submissions",{headers:{"CF-Connecting-IP":ip}});
    for(let index=0;index<MAX_SUBMISSIONS_PER_CLIENT_WINDOW;index+=1)expect(await consumeSubmissionBudget(env.DB,request,now)).toBe(true);
    expect(await consumeSubmissionBudget(env.DB,request,now)).toBe(false);
    const windows=await env.DB.prepare("SELECT window_key,attempt_count FROM submission_rate_windows ORDER BY window_key").all<{window_key:string;attempt_count:number}>();
    expect(windows.results.every((row)=>!row.window_key.includes(ip))).toBe(true);
    expect(windows.results.find((row)=>row.window_key.startsWith("global:"))?.attempt_count).toBe(MAX_SUBMISSIONS_PER_CLIENT_WINDOW);

    const globalNow=now+10*60*1_000;
    for(let index=0;index<MAX_SUBMISSIONS_GLOBAL_WINDOW;index+=1){const distinct=new Request("https://mpp.ninja/api/submissions",{headers:{"CF-Connecting-IP":`203.0.${Math.floor(index/250)}.${index%250}`}});expect(await consumeSubmissionBudget(env.DB,distinct,globalNow)).toBe(true);}
    expect(await consumeSubmissionBudget(env.DB,new Request("https://mpp.ninja/api/submissions",{headers:{"CF-Connecting-IP":"203.1.1.1"}}),globalNow)).toBe(false);
  });

  it("recovers the global retained quota after terminal candidates expire while preserving rows",async()=>{
    const submittedAt="2026-08-25T00:00:00.000Z";const expiresAt="2026-08-26T00:00:00.000Z";
    await env.DB.prepare(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<?)
      INSERT INTO submissions (normalized_url,origin,submitted_at,status,candidate_expires_at)
      SELECT 'https://manual-'||value||'.example/','https://manual-'||value||'.example',?,'unconfirmed',? FROM n`)
      .bind(MAX_RETAINED_MANUAL_CANDIDATES_GLOBAL,submittedAt,expiresAt).run();
    expect(await reserveManualSubmission(env.DB,{normalizedUrl:"https://overflow.example/",origin:"https://overflow.example",submittedAt:"2026-08-25T12:00:00.000Z",sourceNote:null})).toBe("capacity");
    await expireManualCandidates(env.DB,"2026-08-26T00:00:01.000Z");
    expect(await reserveManualSubmission(env.DB,{normalizedUrl:"https://recovered.example/",origin:"https://recovered.example",submittedAt:"2026-08-26T00:00:01.000Z",sourceNote:null})).toBe("reserved");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM submissions").first<{count:number}>())?.count).toBe(MAX_RETAINED_MANUAL_CANDIDATES_GLOBAL+1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM submissions WHERE status='expired'").first<{count:number}>())?.count).toBe(MAX_RETAINED_MANUAL_CANDIDATES_GLOBAL);
  });

  it("enforces retained per-origin capacity atomically",async()=>{
    const origin="https://same-origin.example";
    const submittedAt="2026-08-27T01:00:00.000Z";
    for(let index=0;index<MAX_RETAINED_MANUAL_CANDIDATES_PER_ORIGIN;index+=1)expect(await reserveManualSubmission(env.DB,{normalizedUrl:`${origin}/service-${index}`,origin,submittedAt,sourceNote:null})).toBe("reserved");
    await env.DB.prepare("UPDATE submissions SET status='unconfirmed' WHERE origin=?").bind(origin).run();
    expect(await reserveManualSubmission(env.DB,{normalizedUrl:`${origin}/overflow`,origin,submittedAt,sourceNote:null})).toBe("capacity");
  });
});

describe("manual discovery promotion gate",()=>{
  it("records advertised metadata but never schedules cross-origin descendants for an unconfirmed manual service",async()=>{
    const serviceId="manual-cross-origin";await insertService(serviceId,"https://manual-cross-origin.example/");
    await env.DB.prepare("INSERT INTO sources (id,service_id,source_kind,source_url,first_seen,last_seen) VALUES ('manual-cross-source',?,'manual','https://mpp.ninja/submit','2026-08-25','2026-08-25')").bind(serviceId).run();
    const sent:ObservatoryQueueMessage[]=[];const bindings={DB:env.DB,CRAWL_QUEUE:{send:async(body:ObservatoryQueueMessage)=>sent.push(body)}} as unknown as Env;
    const linkSnapshot="manual-cross-link-snapshot";await startSourceSnapshot(env.DB,{id:linkSnapshot,serviceId,sourceType:"api-catalog",sourceRef:"https://manual-cross-origin.example/.well-known/api-catalog",observedAt:"2026-08-25T01:00:00.000Z",expectedItems:1});
    const link:ApiCatalogLinkMessage={type:"api-catalog-link",url:"https://attacker-controlled.example/openapi.json",serviceId,sourceRef:"https://manual-cross-origin.example/.well-known/api-catalog",observedAt:"2026-08-25T01:00:00.000Z",snapshotId:linkSnapshot,itemId:`${linkSnapshot}:0`};
    await processApiCatalogLink(bindings,link);
    const operationSnapshot="manual-cross-operation-snapshot";await startSourceSnapshot(env.DB,{id:operationSnapshot,serviceId,sourceType:"openapi",sourceRef:"https://manual-cross-origin.example/openapi.json",observedAt:"2026-08-25T01:00:00.000Z",expectedItems:1});
    await processOpenApiOperation(bindings,{type:"openapi-operation",serviceId,baseUrl:"https://attacker-controlled.example/",operation:{method:"GET",path:"/paid",description:"cross origin",offers:[{method:"tempo"}]},offerOffset:0,observedAt:"2026-08-25T01:00:00.000Z",sourceRef:"https://manual-cross-origin.example/openapi.json",snapshotId:operationSnapshot,itemId:`${operationSnapshot}:0`});
    expect(sent).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM crawl_targets WHERE service_id=?").bind(serviceId).first<{count:number}>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM endpoints WHERE service_id=?").bind(serviceId).first<{count:number}>())?.count).toBe(1);
  });

  it("retires a harmless manual non-MPP result and deactivates its provenance",async()=>{
    const serviceId="manual-one-shot";const url="https://1.1.1.1/manual-one-shot";await insertService(serviceId,url);
    await env.DB.prepare("INSERT INTO submissions (normalized_url,origin,service_id,submitted_at,status,candidate_expires_at) VALUES (?,?,?,?,?,?)").bind(url,"https://1.1.1.1",serviceId,"2026-08-25T00:00:00.000Z","queued","2099-01-01T00:00:00.000Z").run();
    const queued:CrawlMessage[]=[];const r2=new Map<string,string>();const bindings={DB:env.DB,CRAWL_QUEUE:{send:async(body:CrawlMessage)=>queued.push(body)},OBSERVATIONS:{get:async(key:string)=>{const value=r2.get(key);return value?{text:async()=>value}:null;},put:async(key:string,value:string)=>{r2.set(key,value);}}} as unknown as Env;
    await enqueueTarget(bindings,{url,serviceId,kind:"endpoint",source:"manual"},0,false,{sourceType:"manual",sourceRef:"https://mpp.ninja/submit",observedAt:"2026-08-25T00:00:00.000Z"});
    vi.stubGlobal("fetch",async()=>new Response("public metadata",{status:200,headers:{"Content-Type":"text/plain"}}));
    try{await processCrawlMessage(bindings,queued[0]);}finally{vi.unstubAllGlobals();}
    expect(await env.DB.prepare("SELECT status,next_due_at FROM crawl_targets WHERE service_id=?").bind(serviceId).first()).toEqual({status:"retired",next_due_at:null});
    expect(await env.DB.prepare("SELECT active FROM crawl_target_sources WHERE target_id=(SELECT id FROM crawl_targets WHERE service_id=?)").bind(serviceId).first()).toEqual({active:0});
    expect(await env.DB.prepare("SELECT status FROM services WHERE id=?").bind(serviceId).first()).toEqual({status:"unconfirmed"});
  });
});
