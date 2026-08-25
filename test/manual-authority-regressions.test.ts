import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { MAX_UNCONFIRMED_MANUAL_ATTEMPTS } from "../src/budgets";
import { crawlTargetId, enqueueDueTargets, enqueueTarget, processDueTarget } from "../src/catalog";
import { processApiCatalogLink, processCrawlMessage } from "../src/crawler";
import { startSourceSnapshot } from "../src/db";
import type { ApiCatalogLinkMessage, CrawlMessage, DueTargetMessage, ObservatoryQueueMessage } from "../src/model";
import { expireManualCandidates, serviceAllowsDerivedDiscovery } from "../src/submissions";

async function insertService(id:string,url:string,status="candidate"):Promise<void>{
  const parsed=new URL(url);
  await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,status,first_seen,last_seen) VALUES (?,?,?,?,?,?,?)")
    .bind(id,id,url,parsed.origin,status,"2026-08-25T00:00:00.000Z","2026-08-25T00:00:00.000Z").run();
}

async function addTrustedAuthority(serviceId:string,id:string,sourceType:"catalog"|"mppscan",url:string):Promise<void>{
  await env.DB.batch([
    env.DB.prepare("INSERT INTO crawl_targets (id,normalized_url,service_id,target_kind,source_kind,status) VALUES (?,?,?,'endpoint',?,'complete')")
      .bind(id,url,serviceId,sourceType),
    env.DB.prepare("INSERT INTO crawl_target_sources (target_id,source_type,source_ref,first_seen,last_seen,observed_at,active) VALUES (?,?,?,?,?,?,1)")
      .bind(id,sourceType,sourceType==="catalog"?"https://mpp.dev/api/services":"https://mppscan.com/","2026-08-25T00:00:00.000Z","2026-08-25T00:00:00.000Z","2026-08-25T00:00:00.000Z"),
  ]);
}

async function processLink(envBindings:Env,serviceId:string,suffix:string):Promise<void>{
  const snapshotId=`authority-link-${suffix}`;
  const observedAt=`2026-08-25T01:00:${String(suffix.length).padStart(2,"0")}.000Z`;
  const sourceRef=`https://authority.example/catalog-${suffix}.json`;
  await startSourceSnapshot(env.DB,{id:snapshotId,serviceId,sourceType:"api-catalog",sourceRef,observedAt,expectedItems:1});
  const message:ApiCatalogLinkMessage={type:"api-catalog-link",url:`https://authority.example/derived-${suffix}.json`,serviceId,sourceRef,observedAt,snapshotId,itemId:`${snapshotId}:0`};
  await processApiCatalogLink(envBindings,message);
}

describe("manual candidate scheduling races",()=>{
  it("blocks due selection and stale due messages, then expires provenance despite a raced source label",async()=>{
    const serviceId="manual-due-race";const url="https://1.1.1.1/manual-due-race";
    await insertService(serviceId,url);
    await env.DB.prepare("INSERT INTO submissions (normalized_url,origin,service_id,submitted_at,status,candidate_expires_at) VALUES (?,?,?,?,?,?)")
      .bind(url,"https://1.1.1.1",serviceId,"2026-08-25T00:00:00.000Z","unconfirmed","2099-01-01T00:00:00.000Z").run();
    const sent:ObservatoryQueueMessage[]=[];
    const bindings={DB:env.DB,CRAWL_QUEUE:{send:async(body:ObservatoryQueueMessage)=>sent.push(body),sendBatch:async(batch:{body:ObservatoryQueueMessage}[])=>sent.push(...batch.map((entry)=>entry.body))}} as unknown as Env;
    await enqueueTarget(bindings,{url,serviceId,kind:"endpoint",source:"manual"},0,false,{sourceType:"manual",sourceRef:"https://mpp.ninja/submit",observedAt:"2026-08-25T00:00:00.000Z"});
    sent.length=0;
    await env.DB.prepare("UPDATE crawl_targets SET status='retry',next_due_at='2000-01-01T00:00:00.000Z' WHERE service_id=?").bind(serviceId).run();

    expect(await enqueueDueTargets(bindings,10)).toBe(0);
    const due:DueTargetMessage={type:"due-target",url,serviceId,kind:"endpoint"};
    await processDueTarget(bindings,due);
    expect(sent).toEqual([]);
    expect(await env.DB.prepare("SELECT source_kind,status,attempt_count FROM crawl_targets WHERE service_id=?").bind(serviceId).first()).toEqual({source_kind:"manual",status:"retry",attempt_count:0});

    const targetId=await crawlTargetId({serviceId,kind:"endpoint"},url);
    await env.DB.prepare("INSERT INTO crawl_target_sources (target_id,source_type,source_ref,first_seen,last_seen,observed_at,active) VALUES (?,'catalog','https://mpp.dev/api/services','2026-08-25','2026-08-25','2026-08-25',1)").bind(targetId).run();
    await processDueTarget(bindings,due);
    expect(sent).toHaveLength(1);
    expect(await env.DB.prepare("SELECT source_kind,status FROM crawl_targets WHERE id=?").bind(targetId).first()).toEqual({source_kind:"manual",status:"queued"});
    await env.DB.prepare("UPDATE crawl_target_sources SET active=0,observed_at='2026-08-26T00:00:00.000Z' WHERE target_id=? AND source_type='catalog'").bind(targetId).run();

    // Simulate a pre-fix scheduler having overwritten this denormalized label.
    // Expiry must still use provenance and revoke the candidate.
    await env.DB.prepare("UPDATE crawl_targets SET source_kind='scheduled',status='retry' WHERE service_id=?").bind(serviceId).run();
    await expireManualCandidates(env.DB,"2100-01-01T00:00:00.000Z");
    expect(await env.DB.prepare("SELECT status,next_due_at FROM crawl_targets WHERE service_id=?").bind(serviceId).first()).toEqual({status:"retired",next_due_at:null});
    expect(await env.DB.prepare("SELECT active FROM crawl_target_sources WHERE target_id=(SELECT id FROM crawl_targets WHERE service_id=?) AND source_type='manual'").bind(serviceId).first()).toEqual({active:0});
  });

  it("keeps the three-attempt cap for an already queued message relabeled scheduled",async()=>{
    const serviceId="manual-attempt-race";const url="https://1.1.1.1/manual-attempt-race";
    await insertService(serviceId,url);
    await env.DB.prepare("INSERT INTO submissions (normalized_url,origin,service_id,submitted_at,status,candidate_expires_at) VALUES (?,?,?,?,?,?)")
      .bind(url,"https://1.1.1.1",serviceId,"2026-08-25T00:00:00.000Z","queued","2099-01-01T00:00:00.000Z").run();
    const queued:CrawlMessage[]=[];const objects=new Map<string,string>();
    const bindings={DB:env.DB,CRAWL_QUEUE:{send:async(body:CrawlMessage)=>queued.push(body)},OBSERVATIONS:{get:async(key:string)=>{const value=objects.get(key);return value?{text:async()=>value}:null;},put:async(key:string,value:string)=>{objects.set(key,value);}}} as unknown as Env;
    await enqueueTarget(bindings,{url,serviceId,kind:"endpoint",source:"manual"},0,false,{sourceType:"manual",sourceRef:"https://mpp.ninja/submit",observedAt:"2026-08-25T00:00:00.000Z"});
    const racedMessage={...queued[0],source:"scheduled" as const};
    vi.stubGlobal("fetch",async()=>{throw new Error("synthetic network failure");});
    try{
      for(let attempt=1;attempt<MAX_UNCONFIRMED_MANUAL_ATTEMPTS;attempt+=1)await expect(processCrawlMessage(bindings,racedMessage)).rejects.toThrow();
      await expect(processCrawlMessage(bindings,racedMessage)).resolves.toBeUndefined();
    }finally{vi.unstubAllGlobals();}

    const targetId=await crawlTargetId(racedMessage,url);
    expect(await env.DB.prepare("SELECT source_kind,status,attempt_count,next_due_at FROM crawl_targets WHERE id=?").bind(targetId).first()).toEqual({source_kind:"manual",status:"retired",attempt_count:MAX_UNCONFIRMED_MANUAL_ATTEMPTS,next_due_at:null});
    expect(await env.DB.prepare("SELECT active FROM crawl_target_sources WHERE target_id=? AND source_type='manual'").bind(targetId).first()).toEqual({active:0});
  });
});

describe("current trusted discovery authority",()=>{
  it("ignores withdrawn historical catalog and MPPScan rows while honoring either active authority",async()=>{
    const serviceId="current-authority";await insertService(serviceId,"https://authority.example/");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sources (id,service_id,source_kind,source_url,first_seen,last_seen) VALUES ('historical-catalog',?,'mpp.dev-catalog','https://mpp.dev/api/services','2026-08-24','2026-08-24')").bind(serviceId),
      env.DB.prepare("INSERT INTO sources (id,service_id,source_kind,source_url,first_seen,last_seen) VALUES ('historical-mppscan',?,'mppscan','https://mppscan.com/','2026-08-24','2026-08-24')").bind(serviceId),
    ]);
    const sent:ObservatoryQueueMessage[]=[];const bindings={DB:env.DB,CRAWL_QUEUE:{send:async(body:ObservatoryQueueMessage)=>sent.push(body)}} as unknown as Env;

    expect(await serviceAllowsDerivedDiscovery(env.DB,serviceId)).toBe(false);
    await processLink(bindings,serviceId,"withdrawn");
    expect(sent).toEqual([]);

    await addTrustedAuthority(serviceId,"active-catalog-authority","catalog","https://authority.example/catalog-endpoint");
    expect(await serviceAllowsDerivedDiscovery(env.DB,serviceId)).toBe(true);
    await processLink(bindings,serviceId,"catalog");
    expect(sent).toHaveLength(1);

    await env.DB.prepare("UPDATE crawl_target_sources SET active=0,observed_at='2026-08-25T02:00:00.000Z' WHERE target_id='active-catalog-authority'").run();
    expect(await serviceAllowsDerivedDiscovery(env.DB,serviceId)).toBe(false);
    await processLink(bindings,serviceId,"catalog-withdrawn");
    expect(sent).toHaveLength(1);

    await addTrustedAuthority(serviceId,"active-mppscan-authority","mppscan","https://authority.example/mppscan-endpoint");
    expect(await serviceAllowsDerivedDiscovery(env.DB,serviceId)).toBe(true);
    await processLink(bindings,serviceId,"mppscan");
    expect(sent).toHaveLength(2);

    await env.DB.prepare("UPDATE crawl_target_sources SET active=0,observed_at='2026-08-25T03:00:00.000Z' WHERE target_id='active-mppscan-authority'").run();
    await env.DB.prepare("UPDATE services SET status='observed-mpp' WHERE id=?").bind(serviceId).run();
    expect(await serviceAllowsDerivedDiscovery(env.DB,serviceId)).toBe(true);
  });
});
