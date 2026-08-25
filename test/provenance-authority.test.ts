import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MPP_CATALOG_URL,
  enqueueTarget,
  importMppCatalog,
  processCatalogService,
} from "../src/catalog";
import { processCrawlMessage, processOpenApiOperation } from "../src/crawler";
import { getService, reconcileCatalogRun, startSourceSnapshot } from "../src/db";
import type {
  CatalogDocument,
  CatalogIngestMessage,
  CrawlMessage,
  ObservatoryQueueMessage,
  OpenApiOperationMessage,
} from "../src/model";

afterEach(() => {
  vi.unstubAllGlobals();
});

function service(id: string, serviceUrl: string, paths: string[]): CatalogDocument["services"][number] {
  return {
    id,
    name: id,
    serviceUrl,
    endpoints: paths.map((path) => ({
      method: "GET",
      path,
      payment: {
        method: "tempo",
        intent: "charge",
        currency: "USDC",
        amount: "1",
        recipient: `0x${id}`,
      },
    })),
  };
}

function queueEnv(): {
  bindings: Env;
  catalogMessages: CatalogIngestMessage[];
  directMessages: ObservatoryQueueMessage[];
} {
  const catalogMessages: CatalogIngestMessage[] = [];
  const directMessages: ObservatoryQueueMessage[] = [];
  const bindings = {
    DB: env.DB,
    CRAWL_QUEUE: {
      send: async (body: ObservatoryQueueMessage) => directMessages.push(body),
      sendBatch: async (batch: Array<{ body: ObservatoryQueueMessage }>) => {
        for (const { body } of batch) {
          if (body.type === "catalog-service") catalogMessages.push(body);
          else directMessages.push(body);
        }
      },
    },
  } as unknown as Env;
  return { bindings, catalogMessages, directMessages };
}

async function importCatalog(
  bindings: Env,
  captured: CatalogIngestMessage[],
  document: CatalogDocument,
  observedAt: string,
): Promise<CatalogIngestMessage[]> {
  captured.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const requested = input instanceof Request ? input.url : input.toString();
    if (requested !== MPP_CATALOG_URL) throw new Error(`unexpected fetch: ${requested}`);
    return new Response(JSON.stringify(document), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  await importMppCatalog(bindings, observedAt);
  return [...captured];
}

async function processAll(bindings: Env, messages: readonly CatalogIngestMessage[]): Promise<void> {
  for (const message of messages) await processCatalogService(bindings, message);
}

describe("catalog service-snapshot authority", () => {
  it("does not let a delayed older service snapshot reactivate membership after a newer global omission", async () => {
    const { bindings, catalogMessages } = queueEnv();
    const omittedUrl = "https://delayed-catalog-service.example/";
    const baseline = await importCatalog(
      bindings,
      catalogMessages,
      { version: 1, services: [service("delayed-catalog-service", omittedUrl, ["/alpha"])] },
      "2026-08-28T01:00:00.000Z",
    );
    await processAll(bindings, baseline);
    const serviceId = (
      await env.DB.prepare("SELECT id FROM services WHERE service_url=?")
        .bind(omittedUrl)
        .first<{ id: string }>()
    )?.id;
    expect(serviceId).toBeTruthy();

    const older = await importCatalog(
      bindings,
      catalogMessages,
      {
        version: 1,
        services: [service("delayed-catalog-service", omittedUrl, ["/alpha", "/late"])],
      },
      "2026-08-28T02:00:00.000Z",
    );
    expect(older).toHaveLength(2);
    await processCatalogService(bindings, older[0]);

    const newer = await importCatalog(
      bindings,
      catalogMessages,
      {
        version: 1,
        services: [service("newer-catalog-service", "https://newer-catalog-service.example/", ["/paid"])],
      },
      "2026-08-28T03:00:00.000Z",
    );
    await processAll(bindings, newer);
    const inactiveBefore = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM endpoint_sources es JOIN endpoints e ON e.id=es.endpoint_id WHERE e.service_id=? AND es.source_type='catalog' AND es.active=1) AS endpoints,
      (SELECT COUNT(*) FROM payment_offers p JOIN endpoints e ON e.id=p.endpoint_id WHERE e.service_id=? AND p.source_type='catalog' AND p.active=1) AS offers,
      (SELECT COUNT(*) FROM crawl_target_sources cts JOIN crawl_targets ct ON ct.id=cts.target_id WHERE ct.service_id=? AND cts.source_type='catalog' AND cts.active=1) AS targets`)
      .bind(serviceId, serviceId, serviceId)
      .first();
    expect(inactiveBefore).toEqual({ endpoints: 0, offers: 0, targets: 0 });

    await processCatalogService(bindings, older[1]);

    const inactiveAfter = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM endpoint_sources es JOIN endpoints e ON e.id=es.endpoint_id WHERE e.service_id=? AND es.source_type='catalog' AND es.active=1) AS endpoints,
      (SELECT COUNT(*) FROM payment_offers p JOIN endpoints e ON e.id=p.endpoint_id WHERE e.service_id=? AND p.source_type='catalog' AND p.active=1) AS offers,
      (SELECT COUNT(*) FROM crawl_target_sources cts JOIN crawl_targets ct ON ct.id=cts.target_id WHERE ct.service_id=? AND cts.source_type='catalog' AND cts.active=1) AS targets`)
      .bind(serviceId, serviceId, serviceId)
      .first();
    expect(inactiveAfter).toEqual({ endpoints: 0, offers: 0, targets: 0 });
    expect(((await getService(env.DB, serviceId!)) as { endpoints: unknown[] }).endpoints).toEqual([]);
  });
});

describe("advertised OpenAPI parent authority", () => {
  it("withdraws derived data and child provenance, then queues a fresh parent probe on restoration", async () => {
    const serviceId = "openapi-parent-authority";
    const serviceUrl = "https://openapi-parent-authority.example/";
    const parentUrl = "https://openapi-parent-authority.example/openapi.json";
    await env.DB.prepare(
      "INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES (?,?,?,?,?,?)",
    )
      .bind(
        serviceId,
        serviceId,
        serviceUrl,
        "https://openapi-parent-authority.example",
        "2026-08-29T00:00:00.000Z",
        "2026-08-29T00:00:00.000Z",
      )
      .run();
    await env.DB.prepare("UPDATE services SET status='observed-mpp' WHERE id=?").bind(serviceId).run();
    const sent: ObservatoryQueueMessage[] = [];
    const bindings = {
      DB: env.DB,
      CRAWL_QUEUE: { send: async (body: ObservatoryQueueMessage) => sent.push(body) },
    } as unknown as Env;
    const parent: CrawlMessage = {
      type: "probe",
      url: parentUrl,
      serviceId,
      kind: "openapi",
      source: "catalog",
    };
    await enqueueTarget(bindings, parent, 0, false, {
      sourceType: "catalog",
      sourceRef: MPP_CATALOG_URL,
      observedAt: "2026-08-29T01:00:00.000Z",
    });
    const firstParentMessage = sent[0] as CrawlMessage;
    await env.DB.prepare(
      "UPDATE crawl_targets SET status='complete',next_due_at='2026-08-29T00:00:00.000Z' WHERE service_id=? AND target_kind='openapi' AND normalized_url=?",
    )
      .bind(serviceId, parentUrl)
      .run();

    const snapshotId = "openapi-parent-authority-snapshot";
    await startSourceSnapshot(env.DB, {
      id: snapshotId,
      serviceId,
      sourceType: "openapi",
      sourceRef: parentUrl,
      observedAt: "2026-08-29T01:00:00.000Z",
      expectedItems: 1,
    });
    const operation: OpenApiOperationMessage = {
      type: "openapi-operation",
      serviceId,
      baseUrl: parentUrl,
      operation: {
        method: "GET",
        path: "/paid",
        description: "Derived paid endpoint",
        offers: [{ method: "tempo", intent: "charge", currency: "USDC", amount: "1" }],
      },
      offerOffset: 0,
      observedAt: "2026-08-29T01:00:00.000Z",
      sourceRef: parentUrl,
      snapshotId,
      itemId: `${snapshotId}:0`,
    };
    await processOpenApiOperation(bindings, operation);
    const child = await env.DB.prepare(
      "SELECT id FROM crawl_targets WHERE service_id=? AND target_kind='endpoint'",
    )
      .bind(serviceId)
      .first<{ id: string }>();
    expect(child?.id).toBeTruthy();
    expect(((await getService(env.DB, serviceId)) as { endpoints: unknown[] }).endpoints).toHaveLength(1);

    await env.DB.prepare(
      "INSERT INTO discovery_runs (id,source_kind,source_url,started_at,status,expected_services) VALUES (?,?,?,?,?,0)",
    )
      .bind(
        "openapi-parent-authority-withdrawal",
        "mpp.dev-catalog",
        MPP_CATALOG_URL,
        "2026-08-29T02:00:00.000Z",
        "processing",
      )
      .run();
    await reconcileCatalogRun(env.DB, "openapi-parent-authority-withdrawal");

    expect(
      await env.DB.prepare(
        "SELECT active FROM crawl_target_sources WHERE target_id=? AND source_type='catalog'",
      )
        .bind(
          (
            await env.DB.prepare(
              "SELECT id FROM crawl_targets WHERE service_id=? AND target_kind='openapi' AND normalized_url=?",
            )
              .bind(serviceId, parentUrl)
              .first<{ id: string }>()
          )?.id,
        )
        .first(),
    ).toEqual({ active: 0 });
    expect(
      await env.DB.prepare(
        "SELECT active FROM crawl_target_sources WHERE target_id=? AND source_type='openapi' AND source_ref=?",
      )
        .bind(child?.id, parentUrl)
        .first(),
    ).toEqual({ active: 0 });
    expect(
      (await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM active_endpoint_sources WHERE endpoint_id IN (SELECT id FROM endpoints WHERE service_id=?)",
      )
        .bind(serviceId)
        .first<{ count: number }>())?.count,
    ).toBe(0);
    expect(
      (await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM active_payment_offers WHERE endpoint_id IN (SELECT id FROM endpoints WHERE service_id=?)",
      )
        .bind(serviceId)
        .first<{ count: number }>())?.count,
    ).toBe(0);
    expect(((await getService(env.DB, serviceId)) as { endpoints: unknown[] }).endpoints).toEqual([]);

    await processCrawlMessage(bindings, firstParentMessage);
    expect(
      (await env.DB.prepare(
        "SELECT status FROM crawl_targets WHERE service_id=? AND target_kind='openapi' AND normalized_url=?",
      )
        .bind(serviceId, parentUrl)
        .first<{ status: string }>())?.status,
    ).toBe("retired");
    const sentBeforeRestoration = sent.length;
    await enqueueTarget(bindings, parent, 0, false, {
      sourceType: "catalog",
      sourceRef: MPP_CATALOG_URL,
      observedAt: "2026-08-29T03:00:00.000Z",
    });

    expect(sent).toHaveLength(sentBeforeRestoration + 1);
    const restored = sent.at(-1) as CrawlMessage;
    expect(restored).toMatchObject({ type: "probe", url: parentUrl, serviceId, kind: "openapi" });
    expect(restored.runId).toMatch(/^[a-f0-9]{64}$/);
    expect(restored.runId).not.toBe(firstParentMessage.runId);
    expect(((await getService(env.DB, serviceId)) as { endpoints: unknown[] }).endpoints).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT active FROM crawl_target_sources WHERE target_id=? AND source_type='openapi' AND source_ref=?",
      )
        .bind(child?.id, parentUrl)
        .first(),
    ).toEqual({ active: 0 });
  });

  it("cascades an API-catalog parent withdrawal through linked OpenAPI descendants", async () => {
    const serviceId="api-catalog-parent-authority";
    const serviceUrl="https://api-catalog-parent.example/";
    const catalogUrl="https://api-catalog-parent.example/.well-known/api-catalog";
    const openApiUrl="https://api-catalog-parent.example/linked-openapi.json";
    await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES (?,?,?,?,?,?)")
      .bind(serviceId,serviceId,serviceUrl,new URL(serviceUrl).origin,"2026-08-29T00:00:00.000Z","2026-08-29T00:00:00.000Z").run();
    await env.DB.prepare("UPDATE services SET status='observed-mpp' WHERE id=?").bind(serviceId).run();
    const sent:ObservatoryQueueMessage[]=[];
    const bindings={DB:env.DB,CRAWL_QUEUE:{send:async(body:ObservatoryQueueMessage)=>sent.push(body)}} as unknown as Env;
    await enqueueTarget(bindings,{type:"probe",url:catalogUrl,serviceId,kind:"api-catalog",source:"catalog"},0,false,{sourceType:"catalog",sourceRef:MPP_CATALOG_URL,observedAt:"2026-08-29T01:00:00.000Z"});
    await enqueueTarget(bindings,{type:"probe",url:openApiUrl,serviceId,kind:"openapi",source:"openapi"},0,false,{sourceType:"api-catalog",sourceRef:catalogUrl,observedAt:"2026-08-29T01:00:00.000Z"});
    const snapshotId="api-catalog-parent-openapi-snapshot";
    await startSourceSnapshot(env.DB,{id:snapshotId,serviceId,sourceType:"openapi",sourceRef:openApiUrl,observedAt:"2026-08-29T01:00:00.000Z",expectedItems:1});
    await processOpenApiOperation(bindings,{type:"openapi-operation",serviceId,baseUrl:openApiUrl,operation:{method:"GET",path:"/paid",description:"Derived",offers:[{method:"tempo",intent:"charge",amount:"1",currency:"USDC"}]},offerOffset:0,observedAt:"2026-08-29T01:00:00.000Z",sourceRef:openApiUrl,snapshotId,itemId:`${snapshotId}:0`});

    await env.DB.prepare("INSERT INTO discovery_runs (id,source_kind,source_url,started_at,status,expected_services) VALUES (?,?,?,?,?,0)")
      .bind("api-catalog-parent-omission","mpp.dev-catalog",MPP_CATALOG_URL,"2026-08-29T02:00:00.000Z","processing").run();
    await reconcileCatalogRun(env.DB,"api-catalog-parent-omission");

    const states=await env.DB.prepare("SELECT target_kind,status FROM crawl_targets WHERE service_id=? ORDER BY target_kind").bind(serviceId).all<{target_kind:string;status:string}>();
    expect(states.results).toEqual([
      {target_kind:"api-catalog",status:"retired"},
      {target_kind:"endpoint",status:"retired"},
      {target_kind:"openapi",status:"retired"},
    ]);
    expect(await env.DB.prepare("SELECT active FROM crawl_target_sources WHERE source_type='api-catalog' AND source_ref=?").bind(catalogUrl).first()).toEqual({active:0});
    expect(await env.DB.prepare("SELECT active FROM crawl_target_sources WHERE source_type='openapi' AND source_ref=?").bind(openApiUrl).first()).toEqual({active:0});
    expect(((await getService(env.DB,serviceId)) as {endpoints:unknown[]}).endpoints).toEqual([]);
  });
});

describe("in-flight source revocation",()=>{
  it("retires a crawl withdrawn during fetch before normalized state or fan-out commits",async()=>{
    const serviceId="inflight-source-revocation";
    const url="https://1.1.1.1/inflight-source-revocation";
    await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES (?,?,?,?,?,?)")
      .bind(serviceId,serviceId,url,new URL(url).origin,"2030-08-29T00:00:00.000Z","2030-08-29T00:00:00.000Z").run();
    const sent:CrawlMessage[]=[];const objects=new Map<string,string>();
    const bindings={DB:env.DB,CRAWL_QUEUE:{send:async(body:CrawlMessage)=>sent.push(body)},OBSERVATIONS:{get:async(key:string)=>objects.has(key)?{text:async()=>objects.get(key)!}:null,put:async(key:string,value:string)=>{objects.set(key,value);}}} as unknown as Env;
    const target:CrawlMessage={type:"probe",url,serviceId,kind:"endpoint",source:"catalog"};
    await enqueueTarget(bindings,target,0,false,{sourceType:"catalog",sourceRef:MPP_CATALOG_URL,observedAt:"2030-08-29T01:00:00.000Z"});
    expect(sent).toHaveLength(1);
    vi.stubGlobal("fetch",async(input:RequestInfo|URL)=>{
      const requested=input instanceof Request?input.url:input.toString();
      if(requested!==url)throw new Error(`unexpected fetch: ${requested}`);
      await env.DB.prepare("UPDATE crawl_target_sources SET active=0,observed_at=? WHERE target_id=(SELECT id FROM crawl_targets WHERE service_id=?)")
        .bind("2030-08-29T02:00:00.000Z",serviceId).run();
      return new Response("public",{status:200,headers:{"Content-Type":"text/plain"}});
    });

    await processCrawlMessage(bindings,sent[0]);
    expect(await env.DB.prepare("SELECT status,processing_token,next_due_at FROM crawl_targets WHERE service_id=?").bind(serviceId).first()).toEqual({status:"retired",processing_token:null,next_due_at:null});
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM observations WHERE service_id=?").bind(serviceId).first<{count:number}>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM security_properties WHERE service_id=?").bind(serviceId).first<{count:number}>())?.count).toBe(0);
    expect(objects.size).toBe(1);
  });
});
