import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { MAX_RETAINED_OPENAPI_ENDPOINTS_PER_SERVICE } from "../src/budgets";
import {
  failSourceSnapshot,
  failStaleSourceSnapshots,
  getService,
  recordSourceSnapshotItem,
  reconcileSourceSnapshot,
  sourceSnapshotStatus,
  startSourceSnapshot,
  upsertOpenApiOperation,
} from "../src/db";
import worker from "../src/index";
import type {
  ApiCatalogLinkMessage,
  CatalogIngestMessage,
  ObservatoryQueueMessage,
  OpenApiOperationMessage,
} from "../src/model";
import { ScanSafetyError } from "../src/security";

async function insertService(id:string,serviceUrl:string):Promise<void>{
  await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES (?,?,?,?,?,?)")
    .bind(id,id,serviceUrl,new URL(serviceUrl).origin,"2026-08-20T00:00:00.000Z","2026-08-20T00:00:00.000Z").run();
}

function operation(path:string,amount="1",recipient="0xold"){
  return{method:"GET",path,description:`operation ${path}`,offers:[{method:"tempo",intent:"charge",amount,currency:"USD",recipient}]};
}

describe("failed source snapshots",()=>{
  it("abandons partial normalized state while preserving the last published authority",async()=>{
    const serviceId="snapshot-failure-authority";
    const serviceUrl="https://snapshot-failure-authority.example/";
    const sourceRef="https://snapshot-failure-authority.example/openapi.json";
    await insertService(serviceId,serviceUrl);

    await startSourceSnapshot(env.DB,{id:"snapshot-failure-old",serviceId,sourceType:"openapi",sourceRef,observedAt:"2026-08-24T00:00:00.000Z",expectedItems:1});
    await upsertOpenApiOperation(env.DB,serviceId,serviceUrl,operation("/paid"),"2026-08-24T00:00:00.000Z",sourceRef,0,true,"snapshot-failure-old");
    await recordSourceSnapshotItem(env.DB,"snapshot-failure-old","snapshot-failure-old:0","2026-08-24T00:00:00.000Z");

    await startSourceSnapshot(env.DB,{id:"snapshot-failure-new",serviceId,sourceType:"openapi",sourceRef,observedAt:"2026-08-25T00:00:00.000Z",expectedItems:2});
    await upsertOpenApiOperation(env.DB,serviceId,serviceUrl,operation("/paid","2","0xnew"),"2026-08-25T00:00:00.000Z",sourceRef,0,true,"snapshot-failure-new");
    await recordSourceSnapshotItem(env.DB,"snapshot-failure-new","snapshot-failure-new:0","2026-08-25T00:00:00.000Z");
    await upsertOpenApiOperation(env.DB,serviceId,serviceUrl,operation("/partial","3","0xpartial"),"2026-08-25T00:00:00.000Z",sourceRef,0,true,"snapshot-failure-new");

    expect(await failSourceSnapshot(env.DB,"snapshot-failure-new","forced terminal failure","2026-08-25T01:00:00.000Z")).toBe(true);
    expect(await env.DB.prepare("SELECT status,finished_at,error_detail FROM source_snapshots WHERE id='snapshot-failure-new'").first()).toEqual({
      status:"failed",finished_at:"2026-08-25T01:00:00.000Z",error_detail:"forced terminal failure",
    });
    for(const table of ["source_snapshot_service_stage","source_snapshot_endpoint_stage","source_snapshot_offer_stage","source_snapshot_items"]){
      expect((await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE snapshot_id='snapshot-failure-new'`).first<{count:number}>())?.count).toBe(0);
    }

    const detail=await getService(env.DB,serviceId) as {endpoints:Array<{path:string;offers:Array<{amount:string;recipient:string}>}>};
    expect(detail.endpoints).toHaveLength(1);
    expect(detail.endpoints[0]).toMatchObject({path:"/paid",offers:[{amount:"1",recipient:"0xold"}]});
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM endpoints WHERE service_id=?").bind(serviceId).first()).toEqual({count:1});

    await recordSourceSnapshotItem(env.DB,"snapshot-failure-new","snapshot-failure-new:1","2026-08-25T02:00:00.000Z");
    expect(await reconcileSourceSnapshot(env.DB,"snapshot-failure-new")).toBe(false);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM source_snapshot_items WHERE snapshot_id='snapshot-failure-new'").first()).toEqual({count:0});
    await expect(upsertOpenApiOperation(env.DB,serviceId,serviceUrl,operation("/late"),"2026-08-25T00:00:00.000Z",sourceRef,0,true,"snapshot-failure-new"))
      .rejects.toMatchObject<Partial<ScanSafetyError>>({code:"source-snapshot-closed"});

    expect(await failSourceSnapshot(env.DB,"snapshot-failure-new","later duplicate failure","2026-08-25T03:00:00.000Z")).toBe(true);
    expect(await env.DB.prepare("SELECT finished_at,error_detail FROM source_snapshots WHERE id='snapshot-failure-new'").first()).toEqual({finished_at:"2026-08-25T01:00:00.000Z",error_detail:"forced terminal failure"});
  });

  it("releases staged OpenAPI cardinality after failure",async()=>{
    const serviceId="snapshot-failure-budget";
    const serviceUrl="https://snapshot-failure-budget.example/";
    const sourceRef="https://snapshot-failure-budget.example/openapi.json";
    const failedId="snapshot-failure-budget-full";
    const replacementId="snapshot-failure-budget-replacement";
    await insertService(serviceId,serviceUrl);
    await startSourceSnapshot(env.DB,{id:failedId,serviceId,sourceType:"openapi",sourceRef,observedAt:"2026-08-24T00:00:00.000Z",expectedItems:MAX_RETAINED_OPENAPI_ENDPOINTS_PER_SERVICE});
    for(let index=0;index<MAX_RETAINED_OPENAPI_ENDPOINTS_PER_SERVICE;index+=1){
      await upsertOpenApiOperation(env.DB,serviceId,serviceUrl,operation(`/staged-${index}`),"2026-08-24T00:00:00.000Z",sourceRef,0,true,failedId);
    }
    await startSourceSnapshot(env.DB,{id:replacementId,serviceId,sourceType:"openapi",sourceRef,observedAt:"2026-08-25T00:00:00.000Z",expectedItems:1});
    await expect(upsertOpenApiOperation(env.DB,serviceId,serviceUrl,operation("/replacement"),"2026-08-25T00:00:00.000Z",sourceRef,0,true,replacementId))
      .rejects.toMatchObject<Partial<ScanSafetyError>>({code:"openapi-endpoint-budget"});

    await failSourceSnapshot(env.DB,failedId,"release staged budget","2026-08-25T00:30:00.000Z");
    await expect(upsertOpenApiOperation(env.DB,serviceId,serviceUrl,operation("/replacement"),"2026-08-25T00:00:00.000Z",sourceRef,0,true,replacementId)).resolves.toMatch(/^[a-f0-9]{64}$/);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM source_snapshot_endpoint_stage WHERE snapshot_id=?").bind(failedId).first()).toEqual({count:0});
    await failSourceSnapshot(env.DB,replacementId,"test cleanup");
  });

  it("fails only snapshots at or beyond the deterministic stale boundary",async()=>{
    const serviceId="snapshot-failure-stale";
    const serviceUrl="https://snapshot-failure-stale.example/";
    const sourceRef="https://snapshot-failure-stale.example/openapi.json";
    await insertService(serviceId,serviceUrl);
    await startSourceSnapshot(env.DB,{id:"snapshot-failure-stale-old",serviceId,sourceType:"openapi",sourceRef,observedAt:"2026-08-24T12:00:00.000Z",expectedItems:1});
    await upsertOpenApiOperation(env.DB,serviceId,serviceUrl,operation("/old-staged"),"2026-08-24T12:00:00.000Z",sourceRef,0,true,"snapshot-failure-stale-old");
    await startSourceSnapshot(env.DB,{id:"snapshot-failure-stale-recent",serviceId,sourceType:"openapi",sourceRef,observedAt:"2026-08-25T11:00:00.000Z",expectedItems:1});
    await upsertOpenApiOperation(env.DB,serviceId,serviceUrl,operation("/recent-staged"),"2026-08-25T11:00:00.000Z",sourceRef,0,true,"snapshot-failure-stale-recent");

    expect(await failStaleSourceSnapshots(env.DB,"2026-08-25T12:00:00.000Z")).toBe(1);
    expect(await sourceSnapshotStatus(env.DB,"snapshot-failure-stale-old")).toBe("failed");
    expect(await env.DB.prepare("SELECT error_detail FROM source_snapshots WHERE id='snapshot-failure-stale-old'").first()).toEqual({error_detail:"stale-snapshot-timeout"});
    expect(await sourceSnapshotStatus(env.DB,"snapshot-failure-stale-recent")).toBe("running");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM source_snapshot_endpoint_stage WHERE snapshot_id='snapshot-failure-stale-old'").first()).toEqual({count:0});
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM source_snapshot_endpoint_stage WHERE snapshot_id='snapshot-failure-stale-recent'").first()).toEqual({count:1});
    await failSourceSnapshot(env.DB,"snapshot-failure-stale-recent","test cleanup");
  });

  it("keeps a published barrier durable when only post-publication target dispatch fails",async()=>{
    const observedAt="2026-08-25T04:00:00.000Z";
    const serviceId="snapshot-failure-terminal";
    const serviceUrl="https://snapshot-failure-terminal.example/";
    await insertService(serviceId,serviceUrl);
    await env.DB.prepare("UPDATE services SET status='observed-mpp' WHERE id=?").bind(serviceId).run();
    await env.DB.prepare("INSERT INTO sources (id,service_id,source_kind,source_url,first_seen,last_seen) VALUES (?,?,?,?,?,?)")
      .bind("snapshot-failure-terminal-source",serviceId,"mpp.dev-catalog","https://mpp.dev/api/services",observedAt,observedAt).run();

    const openApi:OpenApiOperationMessage={type:"openapi-operation",serviceId,baseUrl:serviceUrl,operation:operation("/terminal-openapi"),offerOffset:0,observedAt,sourceRef:`${serviceUrl}openapi.json`,snapshotId:"snapshot-failure-terminal-openapi",itemId:"snapshot-failure-terminal-openapi:0"};
    const apiCatalog:ApiCatalogLinkMessage={type:"api-catalog-link",url:`${serviceUrl}linked-openapi.json`,serviceId,sourceRef:`${serviceUrl}.well-known/api-catalog`,observedAt,snapshotId:"snapshot-failure-terminal-api-catalog",itemId:"snapshot-failure-terminal-api-catalog:0"};
    const catalog:CatalogIngestMessage={type:"catalog-service",service:{id:"terminal-catalog",name:"terminal catalog",serviceUrl:"https://snapshot-failure-catalog.example/",endpoints:[{method:"GET",path:"/paid",payment:{method:"tempo",amount:"1"}}]},sourceUrl:"https://mpp.dev/api/services",observedAt,discoveryRunId:"snapshot-failure-terminal-run",snapshotId:"snapshot-failure-terminal-catalog",itemId:"snapshot-failure-terminal-catalog:0",expectedItems:1};
    await startSourceSnapshot(env.DB,{id:openApi.snapshotId,serviceId,sourceType:"openapi",sourceRef:openApi.sourceRef,observedAt,expectedItems:1});
    await startSourceSnapshot(env.DB,{id:apiCatalog.snapshotId,serviceId,sourceType:"api-catalog",sourceRef:apiCatalog.sourceRef,observedAt,expectedItems:1});
    await env.DB.prepare("INSERT INTO discovery_runs (id,source_kind,source_url,started_at,status,expected_services,discovered_services) VALUES (?,'mpp.dev-catalog',?,?,'processing',1,1)")
      .bind(catalog.discoveryRunId,catalog.sourceUrl,observedAt).run();

    let sends=0;
    const bindings={...env,CRAWL_QUEUE:{send:async()=>{sends+=1;throw new Error("forced queue failure");}}} as unknown as Env;
    const bodies:ObservatoryQueueMessage[]=[openApi,apiCatalog,catalog];
    const batch=createMessageBatch<ObservatoryQueueMessage>("mpp-crawl",bodies.map((body,index)=>({id:`terminal-${index}`,timestamp:new Date(observedAt),attempts:6,body})));
    const context=createExecutionContext();
    const error=vi.spyOn(console,"error").mockImplementation(()=>undefined);
    try{
      await (worker.queue as (batch:MessageBatch<ObservatoryQueueMessage>,env:Env,ctx:ExecutionContext)=>Promise<void>)(batch,bindings,context);
      const result=await getQueueResult(batch,context);
      expect(result.retryMessages.map(({msgId})=>msgId).sort()).toEqual(["terminal-0","terminal-1","terminal-2"]);
      for(const snapshotId of [openApi.snapshotId,apiCatalog.snapshotId,catalog.snapshotId])expect(await sourceSnapshotStatus(env.DB,snapshotId)).toBe("complete");
      expect(await env.DB.prepare("SELECT status FROM discovery_runs WHERE id=?").bind(catalog.discoveryRunId).first()).toEqual({status:"complete"});
      expect(await env.DB.prepare("SELECT (SELECT COUNT(*) FROM source_snapshot_endpoint_stage WHERE snapshot_id IN (?,?,?))+(SELECT COUNT(*) FROM source_snapshot_offer_stage WHERE snapshot_id IN (?,?,?)) AS count")
        .bind(openApi.snapshotId,apiCatalog.snapshotId,catalog.snapshotId,openApi.snapshotId,apiCatalog.snapshotId,catalog.snapshotId).first()).toEqual({count:0});

      const sendsBeforeLate=sends;
      const lateBatch=createMessageBatch<ObservatoryQueueMessage>("mpp-crawl",[{id:"late-failed-item",timestamp:new Date(observedAt),attempts:1,body:openApi}]);
      const lateContext=createExecutionContext();
      await (worker.queue as (batch:MessageBatch<ObservatoryQueueMessage>,env:Env,ctx:ExecutionContext)=>Promise<void>)(lateBatch,bindings,lateContext);
      const lateResult=await getQueueResult(lateBatch,lateContext);
      expect(lateResult.explicitAcks).toEqual([]);
      expect(lateResult.retryMessages.map(({msgId})=>msgId)).toEqual(["late-failed-item"]);
      expect(sends).toBeGreaterThan(sendsBeforeLate);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM source_snapshot_target_stage WHERE snapshot_id IN (?,?,?)")
        .bind(openApi.snapshotId,apiCatalog.snapshotId,catalog.snapshotId).first()).toEqual({count:0});
      expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM crawl_targets WHERE status='retry'").first<{count:number}>())?.count).toBeGreaterThanOrEqual(1);
    }finally{error.mockRestore();}
  });
});
