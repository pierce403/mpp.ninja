import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enqueueTarget } from "../src/catalog";
import { processCrawlMessage } from "../src/crawler";
import {
  getService,
  reconcileSourceSnapshot,
  recordSourceSnapshotItem,
  startSourceSnapshot,
  upsertCatalogService,
  upsertOpenApiOperation,
} from "../src/db";
import type { CatalogService, CrawlMessage, ObservatoryQueueMessage, OpenApiOffer } from "../src/model";
import { sha256 } from "../src/security";

afterEach(() => {
  vi.unstubAllGlobals();
});

function catalogService(id: string, serviceUrl: string, endpoints: CatalogService["endpoints"]): CatalogService {
  return { id, name: id, serviceUrl, endpoints };
}

function catalogEndpoint(path: string, amount: string): NonNullable<CatalogService["endpoints"]>[number] {
  return {
    method: "GET",
    path,
    description: path,
    payment: {
      method: "tempo",
      intent: "charge",
      currency: "USDC",
      amount,
      recipient: `0x${path.replace(/\W/g, "")}`,
      methodDetails: { chainId: 42431, decimals: 6 },
    },
  };
}

async function insertService(id: string, url: string): Promise<void> {
  const parsed = new URL(url);
  await env.DB.prepare(
    "INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, id, url, parsed.origin, "2026-08-25T00:00:00.000Z", "2026-08-25T00:00:00.000Z")
    .run();
}

async function finishCatalogSnapshot(input: {
  snapshotId: string;
  sourceRef: string;
  observedAt: string;
  service: CatalogService;
}): Promise<string> {
  const endpoints = input.service.endpoints ?? [];
  let serviceId = input.service.id;
  if (endpoints.length === 0) {
    const existing = await env.DB.prepare("SELECT id FROM services WHERE service_url=?")
      .bind(input.service.serviceUrl)
      .first<{ id: string }>();
    if (existing) serviceId = existing.id;
    await startSourceSnapshot(env.DB, {
      id: input.snapshotId,
      serviceId,
      sourceType: "catalog",
      sourceRef: input.sourceRef,
      observedAt: input.observedAt,
      expectedItems: 0,
    });
    await reconcileSourceSnapshot(env.DB, input.snapshotId);
    return serviceId;
  }
  for (const [index, endpoint] of endpoints.entries()) {
    const result = await upsertCatalogService(
      env.DB,
      { ...input.service, endpoints: [endpoint] },
      input.sourceRef,
      input.observedAt,
      true,
      input.snapshotId,
      endpoints.length,
    );
    serviceId = result.serviceId;
    await startSourceSnapshot(env.DB, {
      id: input.snapshotId,
      serviceId,
      sourceType: "catalog",
      sourceRef: input.sourceRef,
      observedAt: input.observedAt,
      expectedItems: endpoints.length,
    });
    await recordSourceSnapshotItem(env.DB, input.snapshotId, `${input.snapshotId}:${index}`, input.observedAt);
  }
  return serviceId;
}

async function finishOpenApiSnapshot(input: {
  snapshotId: string;
  serviceId: string;
  baseUrl: string;
  sourceRef: string;
  observedAt: string;
  items: Array<{ path: string; offer: OpenApiOffer; offerOffset: number }>;
}): Promise<void> {
  await startSourceSnapshot(env.DB, {
    id: input.snapshotId,
    serviceId: input.serviceId,
    sourceType: "openapi",
    sourceRef: input.sourceRef,
    observedAt: input.observedAt,
    expectedItems: input.items.length,
  });
  if (input.items.length === 0) {
    await reconcileSourceSnapshot(env.DB, input.snapshotId);
    return;
  }
  for (const [index, item] of input.items.entries()) {
    await upsertOpenApiOperation(
      env.DB,
      input.serviceId,
      input.baseUrl,
      { method: "GET", path: item.path, description: item.path, offers: [item.offer] },
      input.observedAt,
      input.sourceRef,
      item.offerOffset,
      true,
      input.snapshotId,
    );
    await recordSourceSnapshotItem(env.DB, input.snapshotId, `${input.snapshotId}:${index}`, input.observedAt);
  }
}

describe("source snapshot withdrawals", () => {
  it("withdraws catalog endpoints and offers from the current API while retaining raw rows and history", async () => {
    const sourceRef = "https://mpp.dev/api/services";
    const serviceUrl = "https://catalog-withdrawal.example/";
    const first = catalogService("catalog-withdrawal", serviceUrl, [
      catalogEndpoint("alpha", "1"),
      catalogEndpoint("beta", "2"),
    ]);
    const serviceId = await finishCatalogSnapshot({
      snapshotId: "catalog-withdrawal-s1",
      sourceRef,
      observedAt: "2026-08-25T01:00:00.000Z",
      service: first,
    });

    const before = (await getService(env.DB, serviceId)) as { endpoints: Array<{ path: string; offers: unknown[] }> };
    expect(before.endpoints.map((endpoint) => endpoint.path).sort()).toEqual(["/alpha", "/beta"]);

    await finishCatalogSnapshot({
      snapshotId: "catalog-withdrawal-s2",
      sourceRef,
      observedAt: "2026-08-25T02:00:00.000Z",
      service: catalogService("catalog-withdrawal", serviceUrl, [catalogEndpoint("alpha", "1")]),
    });

    const current = (await getService(env.DB, serviceId)) as { endpoints: Array<{ path: string; offers: unknown[] }> };
    expect(current.endpoints).toHaveLength(1);
    expect(current.endpoints[0]).toMatchObject({ path: "/alpha" });
    expect(current.endpoints[0].offers).toHaveLength(1);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM endpoints WHERE service_id=?").bind(serviceId).first<{ count: number }>())
        ?.count,
    ).toBe(2);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM payment_offers WHERE endpoint_id IN (SELECT id FROM endpoints WHERE service_id=?)").bind(serviceId).first<{ count: number }>())
        ?.count,
    ).toBe(2);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM endpoint_sources WHERE active=0 AND source_type='catalog' AND endpoint_id IN (SELECT id FROM endpoints WHERE service_id=?)").bind(serviceId).first<{ count: number }>())
        ?.count,
    ).toBe(1);
    const withdrawals = await env.DB.prepare(
      "SELECT change_type FROM changes WHERE service_id=? AND change_type IN ('endpoint-source-withdrawn','payment-offer-withdrawn') ORDER BY change_type",
    )
      .bind(serviceId)
      .all<{ change_type: string }>();
    expect(withdrawals.results.map((row) => row.change_type)).toEqual([
      "endpoint-source-withdrawn",
      "payment-offer-withdrawn",
    ]);
  });

  it("withdraws missing OpenAPI endpoints and shrunk offer ordinals without deleting history", async () => {
    const serviceId = "openapi-withdrawal";
    const baseUrl = "https://openapi-withdrawal.example/openapi.json";
    const sourceRef = baseUrl;
    await insertService(serviceId, "https://openapi-withdrawal.example/");
    const offer = (method: string, amount: string): OpenApiOffer => ({
      method,
      intent: "charge",
      currency: "USDC",
      amount,
      recipient: `0x${method}`,
      methodDetails: { chainId: 42431, decimals: 6 },
    });
    await finishOpenApiSnapshot({
      snapshotId: "openapi-withdrawal-s1",
      serviceId,
      baseUrl,
      sourceRef,
      observedAt: "2026-08-25T01:00:00.000Z",
      items: [
        { path: "/alpha", offer: offer("tempo", "1"), offerOffset: 0 },
        { path: "/alpha", offer: offer("evm", "2"), offerOffset: 1 },
        { path: "/alpha", offer: offer("solana", "3"), offerOffset: 2 },
        { path: "/beta", offer: offer("tempo", "4"), offerOffset: 0 },
      ],
    });

    await finishOpenApiSnapshot({
      snapshotId: "openapi-withdrawal-s2",
      serviceId,
      baseUrl,
      sourceRef,
      observedAt: "2026-08-25T02:00:00.000Z",
      items: [{ path: "/alpha", offer: offer("tempo", "1"), offerOffset: 0 }],
    });

    const current = (await getService(env.DB, serviceId)) as { endpoints: Array<{ path: string; offers: unknown[] }> };
    expect(current.endpoints).toHaveLength(1);
    expect(current.endpoints[0].path).toBe("/openapi.json/alpha");
    expect(current.endpoints[0].offers).toHaveLength(1);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM endpoints WHERE service_id=?").bind(serviceId).first<{ count: number }>())
        ?.count,
    ).toBe(2);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM payment_offers WHERE endpoint_id IN (SELECT id FROM endpoints WHERE service_id=?)").bind(serviceId).first<{ count: number }>())
        ?.count,
    ).toBe(4);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM payment_offers WHERE active=0 AND endpoint_id IN (SELECT id FROM endpoints WHERE service_id=?)").bind(serviceId).first<{ count: number }>())
        ?.count,
    ).toBe(3);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM changes WHERE service_id=? AND change_type='payment-offer-withdrawn'").bind(serviceId).first<{ count: number }>())
        ?.count,
    ).toBe(3);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM changes WHERE service_id=? AND change_type='endpoint-source-withdrawn'").bind(serviceId).first<{ count: number }>())
        ?.count,
    ).toBe(1);
  });

  it("does not let an older OpenAPI snapshot completion resurrect a newer withdrawal", async () => {
    const serviceId = "openapi-out-of-order-withdrawal";
    const baseUrl = "https://openapi-out-of-order.example/openapi.json";
    const sourceRef = baseUrl;
    const item = {
      path: "/alpha",
      offer: { method: "tempo", intent: "charge", currency: "USDC", amount: "1" } satisfies OpenApiOffer,
      offerOffset: 0,
    };
    await insertService(serviceId, "https://openapi-out-of-order.example/");
    await finishOpenApiSnapshot({
      snapshotId: "openapi-order-s1",
      serviceId,
      baseUrl,
      sourceRef,
      observedAt: "2026-08-25T01:00:00.000Z",
      items: [item],
    });
    await startSourceSnapshot(env.DB, {
      id: "openapi-order-older-running",
      serviceId,
      sourceType: "openapi",
      sourceRef,
      observedAt: "2026-08-25T02:00:00.000Z",
      expectedItems: 1,
    });
    await finishOpenApiSnapshot({
      snapshotId: "openapi-order-newer-empty",
      serviceId,
      baseUrl,
      sourceRef,
      observedAt: "2026-08-25T03:00:00.000Z",
      items: [],
    });

    await upsertOpenApiOperation(
      env.DB,
      serviceId,
      baseUrl,
      { method: "GET", path: item.path, description: item.path, offers: [item.offer] },
      "2026-08-25T02:00:00.000Z",
      sourceRef,
      0,
      true,
      "openapi-order-older-running",
    );
    await recordSourceSnapshotItem(
      env.DB,
      "openapi-order-older-running",
      "openapi-order-older-running:0",
      "2026-08-25T02:00:00.000Z",
    );

    expect(
      (await env.DB.prepare("SELECT active FROM endpoint_sources WHERE source_type='openapi' AND source_ref=?").bind(sourceRef).first<{ active: number }>())
        ?.active,
    ).toBe(0);
    expect(
      (await env.DB.prepare("SELECT active FROM payment_offers WHERE source_type='openapi' AND source_ref=?").bind(sourceRef).first<{ active: number }>())
        ?.active,
    ).toBe(0);
    const current = (await getService(env.DB, serviceId)) as { endpoints: unknown[] };
    expect(current.endpoints).toEqual([]);
  });

  it("lets a complete older snapshot reconcile while a newer snapshot is only partially processed", async () => {
    const serviceId = "openapi-partial-newer-snapshot";
    const baseUrl = "https://openapi-partial-newer.example/openapi.json";
    const sourceRef = baseUrl;
    const item = {
      path: "/alpha",
      offer: { method: "tempo", intent: "charge", currency: "USDC", amount: "1" } satisfies OpenApiOffer,
      offerOffset: 0,
    };
    await insertService(serviceId, "https://openapi-partial-newer.example/");
    await finishOpenApiSnapshot({
      snapshotId: "openapi-partial-newer-s1",
      serviceId,
      baseUrl,
      sourceRef,
      observedAt: "2026-08-25T01:00:00.000Z",
      items: [item],
    });
    await startSourceSnapshot(env.DB, {
      id: "openapi-partial-newer-older-empty",
      serviceId,
      sourceType: "openapi",
      sourceRef,
      observedAt: "2026-08-25T02:00:00.000Z",
      expectedItems: 1,
    });
    await startSourceSnapshot(env.DB, {
      id: "openapi-partial-newer-running",
      serviceId,
      sourceType: "openapi",
      sourceRef,
      observedAt: "2026-08-25T03:00:00.000Z",
      expectedItems: 2,
    });
    await recordSourceSnapshotItem(
      env.DB,
      "openapi-partial-newer-running",
      "openapi-partial-newer-running:0",
      "2026-08-25T03:00:00.000Z",
    );

    await recordSourceSnapshotItem(
      env.DB,
      "openapi-partial-newer-older-empty",
      "openapi-partial-newer-older-empty:0",
      "2026-08-25T02:00:00.000Z",
    );

    expect(
      (await env.DB.prepare("SELECT active FROM endpoint_sources WHERE source_type='openapi' AND source_ref=?").bind(sourceRef).first<{ active: number }>())
        ?.active,
    ).toBe(0);
    expect(
      (await env.DB.prepare("SELECT active FROM payment_offers WHERE source_type='openapi' AND source_ref=?").bind(sourceRef).first<{ active: number }>())
        ?.active,
    ).toBe(0);
    expect(
      (await env.DB.prepare("SELECT status FROM source_snapshots WHERE id='openapi-partial-newer-older-empty'").first<{ status: string }>())
        ?.status,
    ).toBe("complete");
    expect(
      (await env.DB.prepare("SELECT status FROM source_snapshots WHERE id='openapi-partial-newer-running'").first<{ status: string }>())
        ?.status,
    ).toBe("running");

    await recordSourceSnapshotItem(
      env.DB,
      "openapi-partial-newer-running",
      "openapi-partial-newer-running:1",
      "2026-08-25T03:00:00.000Z",
    );
    expect(
      (await env.DB.prepare("SELECT active FROM endpoint_sources WHERE source_type='openapi' AND source_ref=?").bind(sourceRef).first<{ active: number }>())
        ?.active,
    ).toBe(0);
    expect(
      (await env.DB.prepare("SELECT active FROM payment_offers WHERE source_type='openapi' AND source_ref=?").bind(sourceRef).first<{ active: number }>())
        ?.active,
    ).toBe(0);
  });
});

function installPublicFetch(getTarget: () => Response, onTarget?: () => void): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : input.toString();
    const url = new URL(raw);
    if (url.origin === "https://cloudflare-dns.com") {
      return new Response(
        JSON.stringify({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "1.1.1.1" }] : [] }),
        { status: 200, headers: { "Content-Type": "application/dns-json" } },
      );
    }
    onTarget?.();
    return getTarget();
  });
}

describe("runtime withdrawal and crawl-run idempotency", () => {
  it("deactivates challenge membership and its offer when a later probe has no valid 402 challenge", async () => {
    const serviceId = "challenge-disappearance";
    const url = "https://challenge-disappearance.example/data";
    const endpointId = await sha256(`${serviceId}|GET|${url}`);
    await insertService(serviceId, "https://challenge-disappearance.example/");
    await env.DB.prepare(
      "INSERT INTO endpoints (id,service_id,url,http_method,path,first_seen,last_seen) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(endpointId, serviceId, url, "GET", "/data", "2026-08-25T00:00:00.000Z", "2026-08-25T00:00:00.000Z")
      .run();
    const queued: CrawlMessage[] = [];
    const r2Keys: string[] = [];
    const fakeEnv = {
      DB: env.DB,
      CRAWL_QUEUE: { send: async (body: CrawlMessage) => queued.push(body) },
      OBSERVATIONS: { put: async (key: string) => r2Keys.push(key) },
    } as unknown as Env;
    const request = btoa(JSON.stringify({ amount: "1", currency: "USDC", recipient: "0xrecipient" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    let challenged = true;
    installPublicFetch(() =>
      challenged
        ? new Response("payment required", {
            status: 402,
            headers: {
              "WWW-Authenticate": `Payment id="challenge", realm="api", method="tempo", intent="charge", request="${request}"`,
            },
          })
        : new Response("public response", { status: 200 }),
    );
    const target: CrawlMessage = { type: "probe", url, serviceId, endpointId, kind: "endpoint", source: "scheduled" };
    await enqueueTarget(fakeEnv, target, 0, false, {
      sourceType: "mppscan",
      sourceRef: "https://mppscan.com/",
      observedAt: "2026-08-25T00:00:00.000Z",
    });
    await processCrawlMessage(fakeEnv, queued[0]);
    expect(
      (await env.DB.prepare("SELECT active FROM endpoint_sources WHERE endpoint_id=? AND source_type='challenge'").bind(endpointId).first<{ active: number }>())
        ?.active,
    ).toBe(1);
    expect(
      (await env.DB.prepare("SELECT active FROM payment_offers WHERE endpoint_id=? AND source_type='challenge'").bind(endpointId).first<{ active: number }>())
        ?.active,
    ).toBe(1);

    await env.DB.prepare("DELETE FROM origin_rate_limits WHERE origin=?").bind(new URL(url).origin).run();
    await env.DB.prepare("UPDATE crawl_targets SET next_due_at=? WHERE service_id=?")
      .bind("2026-08-25T00:00:00.000Z", serviceId)
      .run();
    challenged = false;
    await enqueueTarget(fakeEnv, target, 0, true);
    await processCrawlMessage(fakeEnv, queued[1]);

    expect(
      (await env.DB.prepare("SELECT active FROM endpoint_sources WHERE endpoint_id=? AND source_type='challenge'").bind(endpointId).first<{ active: number }>())
        ?.active,
    ).toBe(0);
    expect(
      (await env.DB.prepare("SELECT active FROM payment_offers WHERE endpoint_id=? AND source_type='challenge'").bind(endpointId).first<{ active: number }>())
        ?.active,
    ).toBe(0);
    expect(((await getService(env.DB, serviceId)) as { endpoints: unknown[] }).endpoints).toEqual([]);
    expect(r2Keys).toHaveLength(2);
  });

  it("replays the first R2 stage without refetching after a partial D1 write and no-ops completed or stale runs", async () => {
    const serviceId = "crawl-run-idempotency";
    const url = "https://crawl-run-idempotency.example/data";
    await insertService(serviceId, "https://crawl-run-idempotency.example/");
    const queued: CrawlMessage[] = [];
    const r2Writes: Array<{ key: string; value: string }> = [];
    const r2Objects = new Map<string, string>();
    let targetFetches = 0;
    const firstBody = "first stable response";
    installPublicFetch(
      () =>
        targetFetches === 1
          ? new Response(firstBody, { status: 203, headers: { "Content-Type": "text/plain", "X-Response-Version": "first" } })
          : new Response("changed second response", { status: 418, headers: { "X-Response-Version": "second" } }),
      () => {
        targetFetches += 1;
      },
    );
    const baseEnv = {
      DB: env.DB,
      CRAWL_QUEUE: { send: async (body: CrawlMessage) => queued.push(body) },
      OBSERVATIONS: {
        put: async (key: string, value: string) => {
          r2Writes.push({ key, value });
          r2Objects.set(key, value);
        },
        get: async (key: string) => {
          const value = r2Objects.get(key);
          return value === undefined ? null : { text: async () => value };
        },
      },
    } as unknown as Env;
    const target: CrawlMessage = { type: "probe", url, serviceId, kind: "endpoint", source: "scheduled" };
    await enqueueTarget(baseEnv, target, 0, false, {
      sourceType: "mppscan",
      sourceRef: "https://mppscan.com/",
      observedAt: "2026-08-25T00:00:00.000Z",
    });
    const runMessage = queued[0];
    expect(runMessage.runId).toMatch(/^[a-f0-9]{64}$/);

    let failObservationInsert = true;
    const partialDb = {
      prepare(sql: string) {
        if (failObservationInsert && sql.startsWith("INSERT INTO observations")) {
          const failed = {
            bind: () => ({
              run: async () => {
                failObservationInsert = false;
                throw new Error("simulated D1 interruption after R2 write");
              },
            }),
          };
          return failed;
        }
        return env.DB.prepare(sql);
      },
      batch(statements: D1PreparedStatement[]) {
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    const partialEnv = { ...baseEnv, DB: partialDb } as unknown as Env;

    await expect(processCrawlMessage(partialEnv, runMessage)).rejects.toThrow("simulated D1 interruption");
    expect(r2Writes).toHaveLength(1);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM observations WHERE service_id=?").bind(serviceId).first<{ count: number }>())
        ?.count,
    ).toBe(0);
    expect(
      (await env.DB.prepare("SELECT status,run_id FROM crawl_targets WHERE service_id=?").bind(serviceId).first<{ status: string; run_id: string }>())
        ?.status,
    ).toBe("retry");

    await processCrawlMessage(baseEnv, runMessage);
    expect(targetFetches).toBe(1);
    expect(r2Writes).toHaveLength(1);
    const firstObservation = JSON.parse(r2Writes[0].value) as {
      id: string;
      observedAt: string;
      bodySha256: string;
      result: { status: number; headers: Record<string, string> };
    };
    expect(firstObservation.result).toMatchObject({
      status: 203,
      headers: { "x-response-version": "[redacted]" },
    });
    expect(firstObservation.bodySha256).toBe(await sha256(firstBody));
    const observation = await env.DB.prepare(
      "SELECT id,raw_r2_key,observed_at,status,headers_json FROM observations WHERE service_id=?",
    )
      .bind(serviceId)
      .all<{ id: string; raw_r2_key: string; observed_at: string; status: number; headers_json: string }>();
    expect(observation.results).toHaveLength(1);
    expect(observation.results[0]).toMatchObject({
      id: firstObservation.id,
      raw_r2_key: r2Writes[0].key,
      observed_at: firstObservation.observedAt,
      status: 203,
    });
    expect(JSON.parse(observation.results[0].headers_json)).toMatchObject({ "x-response-version": "[redacted]" });

    const writesAfterCompletion = r2Writes.length;
    const fetchesAfterCompletion = targetFetches;
    await processCrawlMessage(baseEnv, runMessage);
    await processCrawlMessage(baseEnv, { ...runMessage, runId: "f".repeat(64) });
    expect(r2Writes).toHaveLength(writesAfterCompletion);
    expect(targetFetches).toBe(fetchesAfterCompletion);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM observations WHERE service_id=?").bind(serviceId).first<{ count: number }>())
        ?.count,
    ).toBe(1);
  });
});
