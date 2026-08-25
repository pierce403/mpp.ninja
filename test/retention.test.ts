import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getStats } from "../src/db";
import { pruneRetainedData } from "../src/retention";

const NOW=new Date("2026-08-25T12:00:00.000Z");

async function insertService(id:string,url:string,status="active",published=1,lastSeen="2026-08-20T00:00:00.000Z"):Promise<void>{
  await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,status,published,first_seen,last_seen) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id,id,url,new URL(url).origin,status,published,"2026-06-01T00:00:00.000Z",lastSeen).run();
}

async function observation(input:{id:string;serviceId:string;url:string;observedAt:string;digest:string;key:string}):Promise<void>{
  await env.DB.prepare(`INSERT INTO observations
    (id,service_id,observed_at,request_method,requested_url,final_url,status,headers_json,redirect_count,response_bytes,body_sha256,raw_r2_key)
    VALUES (?,?,?,'GET',?,?,200,'{}',0,2,?,?)`)
    .bind(input.id,input.serviceId,input.observedAt,input.url,input.url,input.digest,input.key).run();
}

describe("bounded operational retention",()=>{
  it("expires raw pointers, compacts repeat observations, and keeps the latest digest",async()=>{
    const serviceId="retention-observations";await insertService(serviceId,"https://retention-observations.example/");
    await observation({id:"repeat-old",serviceId,url:"https://retention-observations.example/pay",observedAt:"2026-06-01T00:00:00.000Z",digest:"digest-old",key:"observations/old.json"});
    await observation({id:"repeat-new",serviceId,url:"https://retention-observations.example/pay",observedAt:"2026-08-20T00:00:00.000Z",digest:"digest-new",key:"observations/new.json"});
    await observation({id:"singleton-old",serviceId,url:"https://retention-observations.example/only",observedAt:"2026-06-02T00:00:00.000Z",digest:"digest-singleton",key:"observations/singleton.json"});

    const result=await pruneRetainedData(env.DB,NOW);
    expect(result.expiredObjectPointers).toBe(2);
    expect(result.repeatObservations).toBe(1);
    const retained=await env.DB.prepare("SELECT id,body_sha256,raw_r2_key FROM observations ORDER BY id").all<{id:string;body_sha256:string;raw_r2_key:string|null}>();
    expect(retained.results).toEqual([
        {id:"repeat-new",body_sha256:"digest-new",raw_r2_key:"observations/new.json"},
        {id:"singleton-old",body_sha256:"digest-singleton",raw_r2_key:null},
      ]);
  });

  it("reclaims inactive normalized/operational rows while preserving change history and active authority",async()=>{
    const serviceId="retention-normalized";await insertService(serviceId,"https://retention-normalized.example/");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO endpoints (id,service_id,url,http_method,path,first_seen,last_seen) VALUES ('inactive-endpoint',?,'https://retention-normalized.example/old','GET','/old','2026-06-01','2026-06-01')").bind(serviceId),
      env.DB.prepare("INSERT INTO endpoints (id,service_id,url,http_method,path,first_seen,last_seen) VALUES ('active-endpoint',?,'https://retention-normalized.example/current','GET','/current','2026-06-01','2026-06-01')").bind(serviceId),
      env.DB.prepare("INSERT INTO crawl_targets (id,normalized_url,service_id,target_kind,source_kind,status,created_at,updated_at) VALUES ('retired-target','https://retention-normalized.example/retired',?,'endpoint','catalog','retired','2026-06-01','2026-06-01')").bind(serviceId),
    ]);
    await env.DB.prepare("INSERT INTO endpoint_sources (endpoint_id,source_type,source_ref,first_seen,last_seen,observed_at,active) VALUES ('active-endpoint','catalog','https://mpp.dev/api/services','2026-06-01','2026-08-20','2026-08-20',1)").run();

    const result=await pruneRetainedData(env.DB,NOW);
    expect(result.inactiveEndpoints).toBeGreaterThanOrEqual(1);expect(result.retiredTargets).toBeGreaterThanOrEqual(1);
    expect(await env.DB.prepare("SELECT id FROM endpoints ORDER BY id").all<{id:string}>()).toMatchObject({results:[{id:"active-endpoint"}]});
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM changes WHERE service_id=? AND change_type='endpoint-discovered'").bind(serviceId).first()).toEqual({count:2});
  });

  it("deletes old manual-only candidates but preserves confirmed services",async()=>{
    await insertService("manual-junk","https://manual-junk.example/","unconfirmed",1,"2026-06-01T00:00:00.000Z");
    await insertService("manual-confirmed","https://manual-confirmed.example/","observed-mpp",1,"2026-06-01T00:00:00.000Z");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO submissions (normalized_url,origin,service_id,submitted_at,status,candidate_expires_at) VALUES ('https://manual-junk.example/','https://manual-junk.example','manual-junk','2026-06-01','expired','2026-06-02')"),
      env.DB.prepare("INSERT INTO submissions (normalized_url,origin,service_id,submitted_at,status,candidate_expires_at,confirmed_at) VALUES ('https://manual-confirmed.example/','https://manual-confirmed.example','manual-confirmed','2026-06-01','confirmed','2026-06-02','2026-06-01')"),
    ]);
    const result=await pruneRetainedData(env.DB,NOW);
    expect(result.manualOnlyServices).toBeGreaterThanOrEqual(1);expect(result.terminalSubmissions).toBeGreaterThanOrEqual(1);
    expect(await env.DB.prepare("SELECT id FROM services WHERE id IN ('manual-junk','manual-confirmed') ORDER BY id").all<{id:string}>()).toMatchObject({results:[{id:"manual-confirmed"}]});
    expect(await env.DB.prepare("SELECT normalized_url FROM submissions WHERE normalized_url LIKE 'https://manual-%' ORDER BY normalized_url").all<{normalized_url:string}>()).toMatchObject({results:[{normalized_url:"https://manual-confirmed.example/"}]});
  });

  it("prunes superseded coordination barriers but keeps the latest authority clocks",async()=>{
    const serviceId="retention-barriers";await insertService(serviceId,"https://retention-barriers.example/");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO source_snapshots (id,service_id,source_type,source_ref,observed_at,expected_items,status,finished_at) VALUES ('snapshot-old',?,'api-catalog','https://retention-barriers.example/.well-known/api-catalog','2026-06-01',0,'complete','2026-06-01')").bind(serviceId),
      env.DB.prepare("INSERT INTO source_snapshots (id,service_id,source_type,source_ref,observed_at,expected_items,status,finished_at) VALUES ('snapshot-new',?,'api-catalog','https://retention-barriers.example/.well-known/api-catalog','2026-08-20',0,'complete','2026-08-20')").bind(serviceId),
      env.DB.prepare("INSERT INTO discovery_runs (id,source_kind,source_url,started_at,finished_at,status) VALUES ('run-old','mpp.dev-catalog','https://mpp.dev/api/services','2026-06-01','2026-06-01','complete')"),
      env.DB.prepare("INSERT INTO discovery_runs (id,source_kind,source_url,started_at,finished_at,status) VALUES ('run-new','mpp.dev-catalog','https://mpp.dev/api/services','2026-08-20','2026-08-20','complete')"),
    ]);
    const result=await pruneRetainedData(env.DB,NOW);
    expect(result.sourceSnapshots).toBe(1);expect(result.discoveryRuns).toBe(1);
    expect(await env.DB.prepare("SELECT id FROM source_snapshots").all<{id:string}>()).toMatchObject({results:[{id:"snapshot-new"}]});
    expect(await env.DB.prepare("SELECT id FROM discovery_runs").all<{id:string}>()).toMatchObject({results:[{id:"run-new"}]});
  });

  it("excludes unpublished staged services from global observation and failure stats",async()=>{
    const before=await getStats(env.DB);
    await insertService("retention-visible","https://retention-visible.example/","active",1);
    await insertService("retention-hidden","https://retention-hidden.example/","active",0);
    await observation({id:"visible-observation",serviceId:"retention-visible",url:"https://retention-visible.example/",observedAt:"2026-08-24T00:00:00.000Z",digest:"visible",key:"observations/visible.json"});
    await observation({id:"hidden-observation",serviceId:"retention-hidden",url:"https://retention-hidden.example/",observedAt:"2026-08-25T00:00:00.000Z",digest:"hidden",key:"observations/hidden.json"});
    await env.DB.prepare("INSERT INTO security_properties (id,service_id,property_key,state,evidence,basis,observed_at) VALUES ('hidden-failure','retention-hidden','bounded_response','tested-fail','hidden','test','2026-08-25')").run();
    expect(await getStats(env.DB)).toMatchObject({services:Number(before.services)+1,observations:Number(before.observations)+1,tested_fail:Number(before.tested_fail),last_observation:"2026-08-24T00:00:00.000Z"});
  });
});
