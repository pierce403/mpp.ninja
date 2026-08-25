import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { crawlTargetId, enqueueTarget, processCatalogService } from "../src/catalog";
import { processApiCatalogLink, processCrawlMessage, processOpenApiOperation } from "../src/crawler";
import { startSourceSnapshot } from "../src/db";
import type { CatalogIngestMessage, CrawlMessage, ObservatoryQueueMessage } from "../src/model";

afterEach(()=>vi.unstubAllGlobals());

async function service(id:string,url:string,status="observed-mpp"):Promise<void>{
  await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,status,first_seen,last_seen) VALUES (?,?,?,?,?,'2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z')")
    .bind(id,id,url,new URL(url).origin,status).run();
}

function bindings(queued:ObservatoryQueueMessage[]):Env{
  return {DB:env.DB,CRAWL_QUEUE:{send:async(body:ObservatoryQueueMessage)=>queued.push(body),sendBatch:async(batch:Array<{body:ObservatoryQueueMessage}>)=>queued.push(...batch.map(({body})=>body))}} as unknown as Env;
}

describe("service-host crawl confinement",()=>{
  it("retires cross-host and provenance-less targets while allowing a same-host scheme upgrade",async()=>{
    const id="host-confinement";await service(id,"http://host-confinement.example/base");
    const cross:CrawlMessage={url:"https://other-confinement.example/pay",serviceId:id,kind:"endpoint",source:"catalog"};
    const crossId=await crawlTargetId(cross,cross.url);
    await env.DB.prepare("INSERT INTO crawl_targets (id,normalized_url,service_id,target_kind,source_kind,status,next_due_at) VALUES (?,?,?,'endpoint','catalog','retry','2000-01-01T00:00:00.000Z')").bind(crossId,cross.url,id).run();
    const queued:ObservatoryQueueMessage[]=[];
    expect(await enqueueTarget(bindings(queued),cross,0)).toBe(0);
    expect(await env.DB.prepare("SELECT status,last_error,next_due_at FROM crawl_targets WHERE id=?").bind(crossId).first()).toEqual({status:"retired",last_error:"cross-host-or-missing-service",next_due_at:null});
    expect(await enqueueTarget(bindings(queued),{url:"https://host-confinement.example/pay",serviceId:id,kind:"endpoint",source:"catalog"},0,false,{sourceType:"catalog",sourceRef:"https://mpp.dev/api/services",observedAt:"2026-08-25T01:00:00.000Z"})).toBe(1);
    expect(await enqueueTarget(bindings(queued),{url:"https://host-confinement.example/no-service",kind:"endpoint",source:"scheduled"},0)).toBe(0);
    expect(queued).toHaveLength(1);
  });

  it("retires a stale crafted cross-host delivery without fetching",async()=>{
    const id="host-delivery";await service(id,"https://host-delivery.example/");
    const message:CrawlMessage={url:"https://other-delivery.example/pay",serviceId:id,kind:"endpoint",source:"scheduled",runId:"host-delivery-run"};
    const targetId=await crawlTargetId(message,message.url);
    await env.DB.prepare("INSERT INTO crawl_targets (id,normalized_url,service_id,target_kind,source_kind,status,generation,run_id,next_due_at) VALUES (?,?,?,'endpoint','scheduled','queued',1,?,CURRENT_TIMESTAMP)").bind(targetId,message.url,id,message.runId).run();
    let fetches=0;vi.stubGlobal("fetch",async()=>{fetches+=1;return new Response("must not fetch");});
    await processCrawlMessage({DB:env.DB} as unknown as Env,message);
    expect(fetches).toBe(0);
    expect(await env.DB.prepare("SELECT status,last_error FROM crawl_targets WHERE id=?").bind(targetId).first()).toEqual({status:"retired",last_error:"cross-host-or-missing-service"});
  });

  it("completes RFC and OpenAPI barriers but never schedules cross-host descendants",async()=>{
    const id="host-descendants";const sourceRef="https://host-descendants.example/openapi.json";await service(id,"https://host-descendants.example/");
    const queued:ObservatoryQueueMessage[]=[];const runtime=bindings(queued);
    await startSourceSnapshot(env.DB,{id:"host-rfc-snapshot",serviceId:id,sourceType:"api-catalog",sourceRef:"https://host-descendants.example/.well-known/api-catalog",observedAt:"2026-08-25T01:00:00.000Z",expectedItems:1});
    await processApiCatalogLink(runtime,{type:"api-catalog-link",url:"https://other-descendants.example/openapi.json",serviceId:id,sourceRef:"https://host-descendants.example/.well-known/api-catalog",observedAt:"2026-08-25T01:00:00.000Z",snapshotId:"host-rfc-snapshot",itemId:"host-rfc-snapshot:0"});
    await startSourceSnapshot(env.DB,{id:"host-openapi-snapshot",serviceId:id,sourceType:"openapi",sourceRef,observedAt:"2026-08-25T02:00:00.000Z",expectedItems:1});
    await processOpenApiOperation(runtime,{type:"openapi-operation",serviceId:id,baseUrl:"https://other-descendants.example/",operation:{method:"GET",path:"/paid",description:"advertised cross-host endpoint",offers:[{method:"tempo",intent:"charge",amount:"1",currency:"USDC"}]},offerOffset:0,observedAt:"2026-08-25T02:00:00.000Z",sourceRef,snapshotId:"host-openapi-snapshot",itemId:"host-openapi-snapshot:0"});
    expect(queued).toEqual([]);
    expect(await env.DB.prepare("SELECT status FROM source_snapshots WHERE id='host-rfc-snapshot'").first()).toEqual({status:"complete"});
    expect(await env.DB.prepare("SELECT status FROM source_snapshots WHERE id='host-openapi-snapshot'").first()).toEqual({status:"complete"});
    expect(await env.DB.prepare("SELECT url,published FROM endpoints WHERE service_id=?").bind(id).first()).toEqual({url:"https://other-descendants.example/paid",published:1});
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM crawl_targets WHERE normalized_url LIKE 'https://other-descendants.example/%'").first()).toEqual({count:0});
  });

  it("publishes cross-host catalog metadata without scheduling it or a cross-host docs URL",async()=>{
    const runId="host-catalog-run";const snapshotId="host-catalog-snapshot";const observedAt="2026-08-25T03:00:00.000Z";
    await env.DB.prepare("INSERT INTO discovery_runs (id,source_kind,source_url,started_at,status,expected_services) VALUES (?,'mpp.dev-catalog','https://mpp.dev/api/services',?,'processing',1)").bind(runId,observedAt).run();
    const message:CatalogIngestMessage={type:"catalog-service",service:{id:"host-catalog",name:"Host catalog",serviceUrl:"https://host-catalog.example/",docs:{apiReference:"https://other-catalog.example/openapi.json"},endpoints:[{method:"GET",path:"https://other-catalog.example/pay",payment:{method:"tempo",intent:"charge",amount:"1",currency:"USDC"}}]},sourceUrl:"https://mpp.dev/api/services",observedAt,discoveryRunId:runId,snapshotId,itemId:`${snapshotId}:0`,expectedItems:1};
    const queued:ObservatoryQueueMessage[]=[];const result=await processCatalogService(bindings(queued),message);
    expect(result.queued).toBe(1);
    expect(queued).toHaveLength(1);expect(queued[0]).toMatchObject({url:"https://host-catalog.example/.well-known/api-catalog"});
    expect(await env.DB.prepare("SELECT url,published FROM endpoints WHERE url='https://other-catalog.example/pay'").first()).toEqual({url:"https://other-catalog.example/pay",published:1});
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM crawl_targets WHERE normalized_url LIKE 'https://other-catalog.example/%'").first()).toEqual({count:0});
  });
});
