import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { crawlTargetId, enqueueTarget } from "../src/catalog";
import { safeProbe } from "../src/crawler";
import { upsertCatalogService, upsertOpenApiOperation } from "../src/db";
import type { CatalogService, CrawlMessage } from "../src/model";
import { type DnsResolver } from "../src/security";

function catalogService(overrides: Partial<CatalogService> = {}): CatalogService {
  return {
    id: "ordering-service",
    name: "Ordering Service",
    serviceUrl: "https://ordering.example/api/",
    description: "catalog fixture",
    endpoints: [
      {
        method: "GET",
        path: "price",
        description: "catalog endpoint",
        payment: {
          method: "tempo",
          intent: "charge",
          currency: "USDC",
          amount: "1",
          recipient: "0xrecipient",
          methodDetails: { chainId: 42431, decimals: 6 },
        },
      },
    ],
    ...overrides,
  };
}

describe("queue scheduling failure recovery", () => {
  it("marks a target retry when Queue.send fails instead of leaving it stuck queued or enqueueing", async () => {
    const serviceId="queue-failure-service";
    await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,status,first_seen,last_seen) VALUES (?,?,?,?,?,'2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z')")
      .bind(serviceId,serviceId,"https://queue-failure.example/","https://queue-failure.example","observed-mpp").run();
    const queueError = new Error("deterministic queue outage");
    const testEnv = {
      DB: env.DB,
      CRAWL_QUEUE: {
        send: async () => {
          throw queueError;
        },
      },
    } as unknown as Env;
    const message: CrawlMessage = {
      type: "probe",
      url: "https://queue-failure.example/mpp?secret=discarded",
      serviceId,
      kind: "endpoint",
      source: "catalog",
    };

    await expect(enqueueTarget(testEnv,message,0,false,{sourceType:"catalog",sourceRef:"https://mpp.dev/api/services",observedAt:"2026-08-25T01:00:00.000Z"})).rejects.toBe(queueError);

    const id = await crawlTargetId(message, "https://queue-failure.example/mpp");
    const target = await env.DB.prepare(
      "SELECT id,normalized_url,status,last_error,next_due_at FROM crawl_targets WHERE id=?",
    )
      .bind(id)
      .first<{
        id: string;
        normalized_url: string;
        status: string;
        last_error: string | null;
        next_due_at: string | null;
      }>();
    expect(target).toMatchObject({
      id,
      normalized_url: "https://queue-failure.example/mpp",
      status: "retry",
      last_error: "queue-send-failed",
    });
    expect(target?.next_due_at).toBeTruthy();
    expect(target?.status).not.toMatch(/queued|enqueueing/);
  });

  it("uses composite target identities for kind, service, and endpoint scope", async () => {
    const url = "https://shared.example/mpp";
    const variants: Array<Pick<CrawlMessage, "serviceId" | "endpointId" | "kind">> = [
      { kind: "endpoint" },
      { kind: "openapi" },
      { kind: "api-catalog" },
      { kind: "homepage" },
      { kind: "endpoint", serviceId: "service-a" },
      { kind: "endpoint", serviceId: "service-b" },
      { kind: "endpoint", serviceId: "service-a", endpointId: "endpoint-a" },
      { kind: "endpoint", serviceId: "service-a", endpointId: "endpoint-b" },
    ];
    const ids = await Promise.all(variants.map((variant) => crawlTargetId(variant, url)));
    expect(new Set(ids).size).toBe(variants.length);
    expect(ids.every((id) => /^[a-f0-9]{64}$/.test(id))).toBe(true);
  });
});

describe("redirect-origin rate-limit callbacks", () => {
  it("leases the confined hostname once across a same-host redirect chain", async () => {
    const leased: string[] = [];
    const resolver: DnsResolver = async (hostname, type) => {
      if (type === "AAAA") return [];
      return [hostname === "one.example" ? "1.1.1.1" : "8.8.8.8"];
    };
    const responses = new Map<string, Response>([
      [
        "https://one.example/start",
        new Response(null, { status: 302, headers: { Location: "https://one.example/step" } }),
      ],
      [
        "https://one.example/step",
        new Response(null, { status: 307, headers: { Location: "https://one.example/final" } }),
      ],
      ["https://one.example/final", new Response("done", { status: 200 })],
    ]);
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      const response = responses.get(url);
      if (!response) throw new Error(`unexpected URL: ${url}`);
      return response;
    }) as typeof fetch;

    const result = await safeProbe("https://one.example/start", "endpoint", {
      fetcher,resolver,onOrigin: async (origin) => {leased.push(origin);},
    });
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe("https://one.example/final");
    expect(leased).toEqual(["https://one.example"]);
  });

  it("rejects an exact redirect URL loop without reacquiring origin leases", async () => {
    const leased: string[] = [];
    const resolver: DnsResolver = async (_hostname, type) => (type === "A" ? ["1.1.1.1"] : []);
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://one.example/start") {
        return new Response(null, { status: 302, headers: { Location: "https://one.example/step" } });
      }
      return new Response(null, { status: 302, headers: { Location: "https://one.example/start" } });
    }) as typeof fetch;

    await expect(
      safeProbe("https://one.example/start", "endpoint", {
        fetcher,
        resolver,
        onOrigin: async (origin) => {
          leased.push(origin);
        },
      }),
    ).rejects.toMatchObject({ code: "redirect-loop" });
    expect(leased).toEqual(["https://one.example"]);
  });
});

describe("out-of-order discovery protection", () => {
  it("uses catalog source time instead of dropping metadata behind a newer runtime last_seen",async()=>{
    const initial=catalogService({id:"source-clock",name:"Initial catalog",serviceUrl:"https://source-clock.example/api/"});
    const first=await upsertCatalogService(env.DB,initial,"https://mpp.dev/api/services","2026-08-25T01:00:00.000Z");
    await env.DB.prepare("UPDATE services SET last_seen='2026-08-25T03:00:00.000Z' WHERE id=?").bind(first.serviceId).run();
    await env.DB.prepare("UPDATE endpoints SET last_seen='2026-08-25T03:00:00.000Z' WHERE service_id=?").bind(first.serviceId).run();
    const updated=catalogService({id:"source-clock",name:"Updated catalog",serviceUrl:"https://source-clock.example/api/",endpoints:[{method:"GET",path:"price",description:"new source metadata",payment:{method:"tempo",intent:"charge",currency:"EURC",amount:"2",recipient:"0xupdated",methodDetails:{chainId:8453,decimals:6}}}]});
    await upsertCatalogService(env.DB,updated,"https://mpp.dev/api/services","2026-08-25T02:00:00.000Z");
    expect(await env.DB.prepare("SELECT name,last_seen,catalog_seen_at FROM services WHERE id=?").bind(first.serviceId).first()).toMatchObject({name:"Updated catalog",last_seen:"2026-08-25T03:00:00.000Z",catalog_seen_at:"2026-08-25T02:00:00.000Z"});
    expect(await env.DB.prepare("SELECT description,last_seen,catalog_seen_at FROM endpoints WHERE service_id=?").bind(first.serviceId).first()).toMatchObject({description:"new source metadata",last_seen:"2026-08-25T03:00:00.000Z",catalog_seen_at:"2026-08-25T02:00:00.000Z"});
    expect(await env.DB.prepare("SELECT currency,chain_id,amount,recipient FROM payment_offers WHERE endpoint_id IN (SELECT id FROM endpoints WHERE service_id=?)").bind(first.serviceId).first()).toMatchObject({currency:"EURC",chain_id:"8453",amount:"2",recipient:"0xupdated"});
  });

  it("does not roll a newer catalog service, endpoint, or offer back to stale values", async () => {
    const newer = catalogService({
      name: "New catalog name",
      description: "new catalog description",
      endpoints: [
        {
          method: "GET",
          path: "price",
          description: "new endpoint description",
          payment: {
            method: "tempo",
            intent: "charge",
            currency: "USDC",
            amount: "200",
            recipient: "0xnew",
            methodDetails: { chainId: 42431, decimals: 6 },
          },
        },
      ],
    });
    const stale = catalogService({
      name: "Stale catalog name",
      description: "stale catalog description",
      endpoints: [
        {
          method: "GET",
          path: "price",
          description: "stale endpoint description",
          payment: {
            method: "tempo",
            intent: "charge",
            currency: "USDC",
            amount: "100",
            recipient: "0xstale",
            methodDetails: { chainId: 42431, decimals: 6 },
          },
        },
      ],
    });

    const { serviceId } = await upsertCatalogService(env.DB, newer, "https://mpp.dev/api/services", "2026-08-25T02:00:00.000Z");
    await upsertCatalogService(env.DB, stale, "https://mpp.dev/api/services", "2026-08-25T01:00:00.000Z");

    const service = await env.DB.prepare(
      "SELECT name,description,last_seen FROM services WHERE id=?",
    ).bind(serviceId).first<{ name: string; description: string; last_seen: string }>();
    const endpoint = await env.DB.prepare(
      "SELECT description,last_seen FROM endpoints WHERE service_id=?",
    ).bind(serviceId).first<{ description: string; last_seen: string }>();
    const offer = await env.DB.prepare(
      "SELECT amount,recipient,last_seen FROM payment_offers WHERE endpoint_id IN (SELECT id FROM endpoints WHERE service_id=?)",
    ).bind(serviceId).first<{ amount: string; recipient: string; last_seen: string }>();
    const staleChanges = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM changes WHERE service_id=? AND changed_at='2026-08-25T01:00:00.000Z'",
    ).bind(serviceId).first<{ count: number }>();

    expect(service).toEqual({
      name: "New catalog name",
      description: "new catalog description",
      last_seen: "2026-08-25T02:00:00.000Z",
    });
    expect(endpoint).toEqual({
      description: "new endpoint description",
      last_seen: "2026-08-25T02:00:00.000Z",
    });
    expect(offer).toEqual({ amount: "200", recipient: "0xnew", last_seen: "2026-08-25T02:00:00.000Z" });
    expect(staleChanges?.count).toBe(0);
  });

  it("does not roll a newer OpenAPI endpoint or offer back when a stale queue message arrives", async () => {
    await env.DB.prepare(
      "INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES ('openapi-ordering','OpenAPI Ordering','https://openapi-ordering.example/','https://openapi-ordering.example','2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z')",
    ).run();
    const newer = {
      method: "GET",
      path: "/price",
      description: "new OpenAPI description",
      offers: [
        {
          method: "tempo",
          intent: "charge",
          currency: "USDC",
          amount: "300",
          recipient: "0xnew-openapi",
          methodDetails: { chainId: 42431, decimals: 6 },
        },
      ],
    };
    const stale = {
      method: "GET",
      path: "/price",
      description: "stale OpenAPI description",
      offers: [
        {
          method: "tempo",
          intent: "charge",
          currency: "USDC",
          amount: "150",
          recipient: "0xstale-openapi",
          methodDetails: { chainId: 42431, decimals: 6 },
        },
      ],
    };

    const endpointId = await upsertOpenApiOperation(
      env.DB,
      "openapi-ordering",
      "https://openapi-ordering.example/openapi.json",
      newer,
      "2026-08-25T03:00:00.000Z",
    );
    await upsertOpenApiOperation(
      env.DB,
      "openapi-ordering",
      "https://openapi-ordering.example/openapi.json",
      stale,
      "2026-08-25T01:00:00.000Z",
    );

    const endpoint = await env.DB.prepare("SELECT description,last_seen FROM endpoints WHERE id=?")
      .bind(endpointId)
      .first<{ description: string; last_seen: string }>();
    const offer = await env.DB.prepare(
      "SELECT amount,recipient,last_seen FROM payment_offers WHERE endpoint_id=?",
    )
      .bind(endpointId)
      .first<{ amount: string; recipient: string; last_seen: string }>();
    const staleChanges = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM changes WHERE service_id='openapi-ordering' AND changed_at='2026-08-25T01:00:00.000Z'",
    ).first<{ count: number }>();

    expect(endpoint).toEqual({
      description: "new OpenAPI description",
      last_seen: "2026-08-25T03:00:00.000Z",
    });
    expect(offer).toEqual({
      amount: "300",
      recipient: "0xnew-openapi",
      last_seen: "2026-08-25T03:00:00.000Z",
    });
    expect(staleChanges?.count).toBe(0);
  });
});
