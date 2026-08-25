import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { processOpenApiOperation } from "../src/crawler";
import { failSourceSnapshot, getService, listServices, recordSourceSnapshotItem, startSourceSnapshot, upsertCatalogService, upsertOpenApiOperation } from "../src/db";
import type { CatalogService, ObservatoryQueueMessage, OpenApiOffer } from "../src/model";

async function insertService(id:string,url:string):Promise<void>{
  await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,status,first_seen,last_seen) VALUES (?,?,?,?,?,?,?)")
    .bind(id,"Old service",url,new URL(url).origin,"observed-mpp","2026-08-25T00:00:00.000Z","2026-08-25T00:00:00.000Z").run();
}

async function stageOpenApiItem(input:{snapshotId:string;serviceId:string;sourceRef:string;observedAt:string;item:number;path:string;description:string;amount:string;recipient:string}):Promise<void>{
  const offer:OpenApiOffer={method:"tempo",intent:"charge",currency:"USDC",amount:input.amount,recipient:input.recipient};
  await upsertOpenApiOperation(env.DB,input.serviceId,new URL("/",input.sourceRef).toString(),{method:"GET",path:input.path,description:input.description,offers:[offer]},input.observedAt,input.sourceRef,0,true,input.snapshotId);
  await recordSourceSnapshotItem(env.DB,input.snapshotId,`${input.snapshotId}:${input.item}`,input.observedAt);
}

describe("atomic public snapshot publication",()=>{
  it("keeps the prior OpenAPI fields, offers, and change feed until every staged item completes",async()=>{
    const serviceId="atomic-openapi";const sourceRef="https://atomic-openapi.example/openapi.json";await insertService(serviceId,"https://atomic-openapi.example/");
    await startSourceSnapshot(env.DB,{id:"atomic-openapi-s1",serviceId,sourceType:"openapi",sourceRef,observedAt:"2026-08-25T01:00:00.000Z",expectedItems:1});
    await stageOpenApiItem({snapshotId:"atomic-openapi-s1",serviceId,sourceRef,observedAt:"2026-08-25T01:00:00.000Z",item:0,path:"/paid",description:"old description",amount:"1",recipient:"0xold"});
    const before=(await getService(env.DB,serviceId)) as {endpoints:Array<{path:string;description:string;offers:Array<{amount:string;recipient:string}>}>};
    expect(before.endpoints).toHaveLength(1);expect(before.endpoints[0]).toMatchObject({description:"old description",offers:[{amount:"1",recipient:"0xold"}]});
    const changesBefore=(await env.DB.prepare("SELECT COUNT(*) AS count FROM changes WHERE service_id=?").bind(serviceId).first<{count:number}>())?.count??0;

    const observedAt="2026-08-25T02:00:00.000Z";
    await startSourceSnapshot(env.DB,{id:"atomic-openapi-s2",serviceId,sourceType:"openapi",sourceRef,observedAt,expectedItems:2});
    await stageOpenApiItem({snapshotId:"atomic-openapi-s2",serviceId,sourceRef,observedAt,item:0,path:"/paid",description:"new description",amount:"2",recipient:"0xnew"});

    const partial=(await getService(env.DB,serviceId)) as {endpoints:Array<{description:string;offers:Array<{amount:string;recipient:string}>}>;changes:unknown[]};
    expect(partial.endpoints).toHaveLength(1);expect(partial.endpoints[0]).toMatchObject({description:"old description",offers:[{amount:"1",recipient:"0xold"}]});
    expect((await env.DB.prepare("SELECT description FROM endpoints WHERE service_id=? AND path='/paid'").bind(serviceId).first())?.description).toBe("old description");
    expect((await env.DB.prepare("SELECT amount FROM payment_offers WHERE endpoint_id IN (SELECT id FROM endpoints WHERE service_id=?)").bind(serviceId).first())?.amount).toBe("1");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM changes WHERE service_id=?").bind(serviceId).first<{count:number}>())?.count).toBe(changesBefore);

    await stageOpenApiItem({snapshotId:"atomic-openapi-s2",serviceId,sourceRef,observedAt,item:1,path:"/extra",description:"extra",amount:"3",recipient:"0xextra"});
    const complete=(await getService(env.DB,serviceId)) as {endpoints:Array<{path:string;description:string;offers:Array<{amount:string;recipient:string}>}>};
    expect(complete.endpoints.map(({path})=>path)).toEqual(["/extra","/paid"]);
    expect(complete.endpoints.find(({path})=>path==="/paid")).toMatchObject({description:"new description",offers:[{amount:"2",recipient:"0xnew"}]});
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM source_snapshot_endpoint_stage WHERE snapshot_id='atomic-openapi-s2'").first()).toEqual({count:0});
    const publishedChanges=await env.DB.prepare("SELECT changed_at FROM changes WHERE service_id=? AND changed_at=?").bind(serviceId,observedAt).all<{changed_at:string}>();
    expect(publishedChanges.results.length).toBeGreaterThan(0);expect(new Set(publishedChanges.results.map(({changed_at})=>changed_at))).toEqual(new Set([observedAt]));
  });

  it("hides a new catalog service and publishes its metadata/endpoints together",async()=>{
    const sourceRef="https://mpp.dev/api/services";const observedAt="2026-08-25T03:00:00.000Z";const snapshotId="atomic-catalog-s1";
    const service:CatalogService={id:"atomic-catalog",name:"Atomic Catalog",serviceUrl:"https://atomic-catalog.example/",description:"complete document",endpoints:[
      {method:"GET",path:"/one",description:"one",payment:{method:"tempo",intent:"charge",currency:"USDC",amount:"1"}},
      {method:"GET",path:"/two",description:"two",payment:{method:"tempo",intent:"charge",currency:"USDC",amount:"2"}},
    ]};
    const first=await upsertCatalogService(env.DB,{...service,endpoints:[service.endpoints![0]]},sourceRef,observedAt,true,snapshotId,2);
    await recordSourceSnapshotItem(env.DB,snapshotId,`${snapshotId}:0`,observedAt);
    expect(await getService(env.DB,first.serviceId)).toBeNull();
    const partialList=await listServices(env.DB,{limit:100,offset:0});
    expect((partialList.data as Array<{id:string}>).some(({id})=>id===first.serviceId)).toBe(false);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM changes WHERE service_id=?").bind(first.serviceId).first()).toEqual({count:0});

    await upsertCatalogService(env.DB,{...service,endpoints:[service.endpoints![1]]},sourceRef,observedAt,true,snapshotId,2);
    await recordSourceSnapshotItem(env.DB,snapshotId,`${snapshotId}:1`,observedAt);
    const complete=(await getService(env.DB,first.serviceId)) as {name:string;description:string;endpoints:Array<{path:string}>};
    expect(complete).toMatchObject({name:"Atomic Catalog",description:"complete document"});
    expect(complete.endpoints.map(({path})=>path)).toEqual(["/one","/two"]);
    expect(await env.DB.prepare("SELECT published FROM services WHERE id=?").bind(first.serviceId).first()).toEqual({published:1});
  });

  it("does not queue provisional OpenAPI targets and removes their authority when the barrier fails",async()=>{
    const serviceId="atomic-target-failure";const serviceUrl="https://atomic-target-failure.example/";const sourceRef=`${serviceUrl}openapi.json`;const snapshotId="atomic-target-failure-snapshot";const observedAt="2026-08-25T04:00:00.000Z";
    await insertService(serviceId,serviceUrl);
    await startSourceSnapshot(env.DB,{id:snapshotId,serviceId,sourceType:"openapi",sourceRef,observedAt,expectedItems:2});
    const queued:ObservatoryQueueMessage[]=[];const bindings={DB:env.DB,CRAWL_QUEUE:{send:async(body:ObservatoryQueueMessage)=>queued.push(body),sendBatch:async(batch:Array<{body:ObservatoryQueueMessage}>)=>queued.push(...batch.map(({body})=>body))}} as unknown as Env;
    await processOpenApiOperation(bindings,{type:"openapi-operation",serviceId,baseUrl:serviceUrl,operation:{method:"GET",path:"/provisional",description:"provisional",offers:[{method:"tempo",intent:"charge",amount:"1"}]},offerOffset:0,observedAt,sourceRef,snapshotId,itemId:`${snapshotId}:0`});
    expect(queued).toEqual([]);
    expect(await env.DB.prepare("SELECT status FROM crawl_targets WHERE service_id=?").bind(serviceId).first()).toEqual({status:"retired"});
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM crawl_target_sources WHERE target_id IN (SELECT id FROM crawl_targets WHERE service_id=?)").bind(serviceId).first()).toEqual({count:0});
    expect(((await getService(env.DB,serviceId)) as {endpoints:unknown[]}).endpoints).toEqual([]);

    await failSourceSnapshot(env.DB,snapshotId,"terminal split-item failure",observedAt);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM source_snapshot_target_stage WHERE snapshot_id=?").bind(snapshotId).first()).toEqual({count:0});
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM crawl_targets WHERE service_id=?").bind(serviceId).first()).toEqual({count:0});
    expect(((await getService(env.DB,serviceId)) as {endpoints:unknown[]}).endpoints).toEqual([]);
  });

  it("reclaims an inert target after the last overlapping snapshot fails",async()=>{
    const serviceId="atomic-overlap-failure";const serviceUrl="https://atomic-overlap-failure.example/";const sourceRef=`${serviceUrl}openapi.json`;
    await insertService(serviceId,serviceUrl);
    const queued:ObservatoryQueueMessage[]=[];const bindings={DB:env.DB,CRAWL_QUEUE:{send:async(body:ObservatoryQueueMessage)=>queued.push(body),sendBatch:async(batch:Array<{body:ObservatoryQueueMessage}>)=>queued.push(...batch.map(({body})=>body))}} as unknown as Env;
    for(const [snapshotId,observedAt] of [["atomic-overlap-a","2026-08-25T05:00:00.000Z"],["atomic-overlap-b","2026-08-25T06:00:00.000Z"]] as const){
      await startSourceSnapshot(env.DB,{id:snapshotId,serviceId,sourceType:"openapi",sourceRef,observedAt,expectedItems:2});
      await processOpenApiOperation(bindings,{type:"openapi-operation",serviceId,baseUrl:serviceUrl,operation:{method:"GET",path:"/shared",description:"shared",offers:[{method:"tempo",intent:"charge",amount:"1"}]},offerOffset:0,observedAt,sourceRef,snapshotId,itemId:`${snapshotId}:0`});
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM crawl_targets WHERE service_id=?").bind(serviceId).first()).toEqual({count:1});
    await failSourceSnapshot(env.DB,"atomic-overlap-a","first failed");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM crawl_targets WHERE service_id=?").bind(serviceId).first()).toEqual({count:1});
    await failSourceSnapshot(env.DB,"atomic-overlap-b","second failed");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM crawl_targets WHERE service_id=?").bind(serviceId).first()).toEqual({count:0});
    expect(queued).toEqual([]);
  });
});
