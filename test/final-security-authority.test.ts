import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { crawlTargetId, enqueueDueTargets, enqueueTarget } from "../src/catalog";
import { processCrawlMessage } from "../src/crawler";
import type { CrawlMessage, ObservatoryQueueMessage } from "../src/model";
import { redactJsonValue, sha256 } from "../src/security";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fail-closed crawl provenance", () => {
  it("does not recover or execute a service-scoped target whose provenance write never landed", async () => {
    const serviceId="orphaned-provenance-service";
    const orphanUrl="https://1.0.0.20/orphaned";
    const legacyUrl="https://1.0.0.21/legacy";
    await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,status,first_seen,last_seen) VALUES (?,?,?,?,?,?,?)")
      .bind(serviceId,serviceId,orphanUrl,"https://1.0.0.20","candidate","2026-08-25T00:00:00.000Z","2026-08-25T00:00:00.000Z").run();
    const orphan:CrawlMessage={type:"probe",url:orphanUrl,serviceId,kind:"endpoint",source:"scheduled"};
    const orphanId=await crawlTargetId(orphan,orphanUrl);
    const legacy:CrawlMessage={type:"probe",url:legacyUrl,kind:"endpoint",source:"scheduled"};
    const legacyId=await crawlTargetId(legacy,legacyUrl);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO crawl_targets (id,normalized_url,service_id,target_kind,source_kind,status,generation,run_id,next_due_at,updated_at) VALUES (?,?,?,'endpoint','scheduled','retry',1,'orphan-run','2000-01-01T00:00:00.000Z','2000-01-01 00:00:00')").bind(orphanId,orphanUrl,serviceId),
      env.DB.prepare("INSERT INTO crawl_targets (id,normalized_url,target_kind,source_kind,status,generation,run_id,next_due_at,updated_at) VALUES (?,?,'endpoint','scheduled','retry',1,'legacy-run','2000-01-01T00:00:00.000Z','2000-01-01 00:00:00')").bind(legacyId,legacyUrl),
    ]);

    const due:ObservatoryQueueMessage[]=[];
    const fakeEnv={DB:env.DB,CRAWL_QUEUE:{sendBatch:async(batch:Array<{body:ObservatoryQueueMessage}>)=>due.push(...batch.map(({body})=>body))}} as unknown as Env;
    await expect(enqueueDueTargets(fakeEnv,10)).resolves.toBe(0);
    expect(due).toEqual([]);

    let fetches=0;
    vi.stubGlobal("fetch",async()=>{fetches+=1;return new Response("must not execute");});
    await processCrawlMessage({DB:env.DB} as unknown as Env,{...orphan,runId:"orphan-run"});
    expect(fetches).toBe(0);
    expect(await env.DB.prepare("SELECT status,last_error,next_due_at FROM crawl_targets WHERE id=?").bind(orphanId).first()).toEqual({status:"retired",last_error:"source-withdrawn",next_due_at:null});
    await processCrawlMessage({DB:env.DB} as unknown as Env,{...legacy,runId:"legacy-run"});
    expect(fetches).toBe(0);
    expect(await env.DB.prepare("SELECT status,last_error,next_due_at FROM crawl_targets WHERE id=?").bind(legacyId).first()).toEqual({status:"retired",last_error:"cross-host-or-missing-service",next_due_at:null});
  });

  it("records a scanner-policy stop as observed probe evidence rather than a failed endpoint validation",async()=>{
    const serviceId="scanner-stop-observation";
    const targetUrl="https://1.0.0.30/";
    await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,status,first_seen,last_seen) VALUES (?,?,?,?,?,?,?)")
      .bind(serviceId,serviceId,targetUrl,"https://1.0.0.30","candidate","2026-08-25T00:00:00.000Z","2026-08-25T00:00:00.000Z").run();
    const queued:CrawlMessage[]=[];
    const fakeEnv={DB:env.DB,CRAWL_QUEUE:{send:async(body:CrawlMessage)=>queued.push(body)},OBSERVATIONS:{get:async()=>null}} as unknown as Env;
    await enqueueTarget(fakeEnv,{type:"probe",url:targetUrl,serviceId,kind:"endpoint",source:"mppscan"},0,false,{sourceType:"mppscan",sourceRef:"https://mppscan.com/",observedAt:"2026-08-25T01:00:00.000Z"});
    vi.stubGlobal("fetch",async()=>new Response(null,{status:302,headers:{Location:"https://other.example/"}}));

    await expect(processCrawlMessage(fakeEnv,queued[0])).rejects.toMatchObject({code:"cross-host-redirect"});

    expect(await env.DB.prepare("SELECT state,evidence,basis FROM security_properties WHERE service_id=? AND property_key='probe_safety'").bind(serviceId).first()).toEqual({
      state:"observed",
      evidence:"cross-host-redirect: Redirects to a different hostname are recorded as blocked, not followed",
      basis:"scanner policy decision",
    });
    expect(await env.DB.prepare("SELECT status,error_code,error_detail,requested_url FROM observations WHERE service_id=?").bind(serviceId).first()).toEqual({
      status:null,
      error_code:"cross-host-redirect",
      error_detail:"Redirects to a different hostname are recorded as blocked, not followed",
      requested_url:targetUrl,
    });
  });
});

describe("collision-safe structured redaction", () => {
  it("removes secrets embedded in sensitive key names without colliding with public keys", () => {
    const secret="credential-value-that-must-not-survive";
    const redacted=redactJsonValue({
      "[redacted-sensitive-key-0]":"public value",
      [`authorization=Bearer ${secret}`]:"ignored",
      [`token_${secret}`]:"ignored too",
    }) as Record<string,unknown>;
    expect(redacted).toEqual({
      "[redacted-sensitive-key-0]":"public value",
      "[redacted-sensitive-key-1]":"[redacted]",
      "[redacted-sensitive-key-2]":"[redacted]",
    });
    expect(JSON.stringify(redacted)).not.toContain(secret);
  });
});

describe("persisted discovery URL redaction", () => {
  it("redacts redirect evidence while preserving safe replayable OpenAPI routing", async () => {
    const serviceId="redacted-discovery-urls";
    const targetUrl="https://1.0.0.22/openapi.json";
    const redirectToken="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    const finalUrl=`https://1.0.0.22/reset/${redirectToken}`;
    const serverUrl="https://1.0.0.23/api";
    await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,status,first_seen,last_seen) VALUES (?,?,?,?,?,?,?)")
      .bind(serviceId,serviceId,targetUrl,"https://1.0.0.22","observed-mpp","2026-08-25T00:00:00.000Z","2026-08-25T00:00:00.000Z").run();
    const queued:CrawlMessage[]=[];const fanout:ObservatoryQueueMessage[]=[];const r2Writes:string[]=[];
    const fakeEnv={
      DB:env.DB,
      CRAWL_QUEUE:{send:async(body:CrawlMessage)=>queued.push(body),sendBatch:async(batch:Array<{body:ObservatoryQueueMessage}>)=>fanout.push(...batch.map(({body})=>body))},
      OBSERVATIONS:{get:async()=>null,put:async(_key:string,value:string)=>{r2Writes.push(value);}},
    } as unknown as Env;
    await enqueueTarget(fakeEnv,{type:"probe",url:targetUrl,serviceId,kind:"openapi",source:"mppscan"},0,false,{sourceType:"mppscan",sourceRef:"https://mppscan.com/",observedAt:"2026-08-25T01:00:00.000Z"});
    vi.stubGlobal("fetch",async(input:RequestInfo|URL)=>{
      const url=input instanceof Request?input.url:input.toString();
      if(url===targetUrl)return new Response(null,{status:302,headers:{Location:finalUrl}});
      if(url===finalUrl)return new Response(JSON.stringify({openapi:"3.1.0",servers:[{url:serverUrl}],paths:{"/paid":{get:{"x-payment-info":{method:"tempo",intent:"charge",amount:"1",currency:"USDC"}}}}}),{status:200,headers:{"Content-Type":"application/json"}});
      throw new Error(`unexpected fetch: ${url}`);
    });

    await processCrawlMessage(fakeEnv,queued[0]);
    expect(r2Writes).toHaveLength(1);
    expect(r2Writes[0]).not.toContain(redirectToken);
    expect(r2Writes[0]).toContain("[redacted]");
    const source=await env.DB.prepare("SELECT source_url,evidence_json FROM sources WHERE service_id=? AND source_kind='openapi'").bind(serviceId).first<{source_url:string;evidence_json:string}>();
    expect(JSON.stringify(source)).not.toContain(redirectToken);
    expect(source?.evidence_json).toContain("[redacted]");
    expect(fanout).toHaveLength(1);
    expect(fanout[0]).toMatchObject({type:"openapi-operation",baseUrl:serverUrl,sourceRef:targetUrl});
  });

  it("drops credential-shaped catalog links before R2 persistence or queue fan-out", async () => {
    const serviceId="redacted-api-catalog-link";
    const targetUrl="https://1.0.0.24/.well-known/api-catalog";
    const linkToken="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ987654";
    const unsafeLink=`https://1.0.0.25/reset/${linkToken}`;
    await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,status,first_seen,last_seen) VALUES (?,?,?,?,?,?,?)")
      .bind(serviceId,serviceId,targetUrl,"https://1.0.0.24","observed-mpp","2026-08-25T00:00:00.000Z","2026-08-25T00:00:00.000Z").run();
    const queued:CrawlMessage[]=[];const fanout:ObservatoryQueueMessage[]=[];const r2Writes:string[]=[];
    const fakeEnv={DB:env.DB,CRAWL_QUEUE:{send:async(body:CrawlMessage)=>queued.push(body),sendBatch:async(batch:Array<{body:ObservatoryQueueMessage}>)=>fanout.push(...batch.map(({body})=>body))},OBSERVATIONS:{get:async()=>null,put:async(_key:string,value:string)=>{r2Writes.push(value);}}} as unknown as Env;
    await enqueueTarget(fakeEnv,{type:"probe",url:targetUrl,serviceId,kind:"api-catalog",source:"mppscan"},0,false,{sourceType:"mppscan",sourceRef:"https://mppscan.com/",observedAt:"2026-08-25T01:00:00.000Z"});
    vi.stubGlobal("fetch",async()=>new Response(JSON.stringify({linkset:[{"service-desc":[{href:unsafeLink,type:"application/openapi+json"}]}]}),{status:200,headers:{"Content-Type":"application/linkset+json"}}));
    await processCrawlMessage(fakeEnv,queued[0]);
    expect(r2Writes).toHaveLength(1);
    expect(r2Writes[0]).not.toContain(linkToken);
    expect(fanout).toEqual([]);
    const source=await env.DB.prepare("SELECT evidence_json FROM sources WHERE service_id=? AND source_kind='api-catalog'").bind(serviceId).first<{evidence_json:string}>();
    expect(source?.evidence_json).toContain('"openApiLinks":0');
  });

  it("replays a safe redacted R2 discovery stage after an interrupted D1 commit", async () => {
    const serviceId="replay-redacted-discovery";
    const targetUrl="https://1.0.0.26/openapi.json";
    const serverUrl="https://1.0.0.27/api";
    await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,status,first_seen,last_seen) VALUES (?,?,?,?,?,?,?)")
      .bind(serviceId,serviceId,targetUrl,"https://1.0.0.26","observed-mpp","2026-08-25T00:00:00.000Z","2026-08-25T00:00:00.000Z").run();
    const queued:CrawlMessage[]=[];const fanout:ObservatoryQueueMessage[]=[];
    let storedStage="";
    const fakeEnv={DB:env.DB,CRAWL_QUEUE:{send:async(body:CrawlMessage)=>queued.push(body),sendBatch:async(batch:Array<{body:ObservatoryQueueMessage}>)=>fanout.push(...batch.map(({body})=>body))},OBSERVATIONS:{get:async()=>({text:async()=>storedStage}),put:async()=>{throw new Error("replay must not rewrite R2");}}} as unknown as Env;
    await enqueueTarget(fakeEnv,{type:"probe",url:targetUrl,serviceId,kind:"openapi",source:"mppscan"},0,false,{sourceType:"mppscan",sourceRef:"https://mppscan.com/",observedAt:"2026-08-25T01:00:00.000Z"});
    const runId=queued[0].runId as string;const observationId=await sha256(`${runId}|observation`);
    storedStage=JSON.stringify({schemaVersion:2,id:observationId,runId,serviceId,endpointId:null,observedAt:"2026-08-25T01:00:00.000Z",result:{requestedUrl:targetUrl,finalUrl:targetUrl,method:"GET",status:200,headers:{"content-type":"application/json"},responseBytes:100,redirects:[],dns:[{hostname:"1.0.0.26",addresses:["1.0.0.26"],stable:true}],challenges:[],observedAt:"2026-08-25T01:00:00.000Z",tls:{state:"tested-pass",httpProtocol:"HTTP/2",note:"HTTPS fetch completed with platform certificate validation"}},bodySha256:"body-digest",fingerprint:{implementation:"unknown",confidence:0,evidence:[]},discovery:{state:"tested-pass",evidence:"1 payment offer(s) accepted",sourceRef:targetUrl,finalUrl:targetUrl,baseUrl:serverUrl,operations:[{method:"GET",path:"/paid",description:"",offers:[{method:"tempo",intent:"charge",amount:"1",currency:"USDC"}]}]}});
    let fetches=0;vi.stubGlobal("fetch",async()=>{fetches+=1;throw new Error("R2 replay must not refetch");});
    await processCrawlMessage(fakeEnv,queued[0]);
    expect(fetches).toBe(0);
    expect(fanout).toHaveLength(1);
    expect(fanout[0]).toMatchObject({type:"openapi-operation",baseUrl:serverUrl,sourceRef:targetUrl});
  });
});
