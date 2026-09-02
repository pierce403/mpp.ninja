import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MPP_CATALOG_URL, crawlTargetId, enqueueTarget } from "../src/catalog";
import { processCrawlMessage, processOpenApiOperation } from "../src/crawler";
import { getService, startSourceSnapshot } from "../src/db";
import type { CrawlMessage, ObservatoryQueueMessage, OpenApiOperationMessage } from "../src/model";

afterEach(() => {
  vi.unstubAllGlobals();
});

function memoryR2(): R2Bucket {
  const objects = new Map<string, string>();
  return {
    get: async (key: string) => {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    put: async (key: string, value: string) => {
      objects.set(key, value);
    },
  } as unknown as R2Bucket;
}

function queueEnv(): { bindings: Env; direct: ObservatoryQueueMessage[]; batches: ObservatoryQueueMessage[] } {
  const direct: ObservatoryQueueMessage[] = [];
  const batches: ObservatoryQueueMessage[] = [];
  const bindings = {
    DB: env.DB,
    OBSERVATIONS: memoryR2(),
    CRAWL_QUEUE: {
      send: async (body: ObservatoryQueueMessage) => direct.push(body),
      sendBatch: async (batch: Array<{ body: ObservatoryQueueMessage }>) => {
        batches.push(...batch.map(({ body }) => body));
      },
    },
  } as unknown as Env;
  return { bindings, direct, batches };
}

async function insertService(serviceId: string, serviceUrl: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES (?,?,?,?,?,?)",
  )
    .bind(serviceId, serviceId, serviceUrl, new URL(serviceUrl).origin, "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z")
    .run();
}

async function markTargetPreviouslyComplete(message: CrawlMessage): Promise<void> {
  const id = await crawlTargetId(message, message.url);
  await env.DB.prepare(
    "UPDATE crawl_targets SET status='complete',next_due_at='2000-01-01T00:00:00.000Z',processing_token=NULL,processing_expires_at=NULL WHERE id=?",
  )
    .bind(id)
    .run();
}

async function seedOpenApiOffer(
  bindings: Env,
  serviceId: string,
  sourceRef: string,
  snapshotId: string,
): Promise<void> {
  const observedAt = "2026-08-24T01:00:00.000Z";
  await startSourceSnapshot(env.DB, {
    id: snapshotId,
    serviceId,
    sourceType: "openapi",
    sourceRef,
    observedAt,
    expectedItems: 1,
  });
  const message: OpenApiOperationMessage = {
    type: "openapi-operation",
    serviceId,
    baseUrl: sourceRef,
    operation: {
      method: "GET",
      path: "/paid",
      description: "Previously advertised paid operation",
      offers: [{ method: "tempo", intent: "charge", currency: "USDC", amount: "1" }],
    },
    offerOffset: 0,
    observedAt,
    sourceRef,
    snapshotId,
    itemId: `${snapshotId}:0`,
  };
  await processOpenApiOperation(bindings, message);
}

async function scheduleRecrawl(bindings: Env, message: CrawlMessage): Promise<CrawlMessage> {
  const queuedBefore = await env.DB.prepare("SELECT generation FROM crawl_targets WHERE id=?")
    .bind(await crawlTargetId(message, message.url))
    .first<{ generation: number }>();
  await enqueueTarget(bindings, message, 0, true);
  const target = await env.DB.prepare("SELECT run_id,generation FROM crawl_targets WHERE id=?")
    .bind(await crawlTargetId(message, message.url))
    .first<{ run_id: string; generation: number }>();
  expect(Number(target?.generation)).toBeGreaterThan(Number(queuedBefore?.generation ?? 0));
  if (!target?.run_id) throw new Error("recrawl was not reserved");
  return { ...message, runId: target.run_id };
}

async function expectWithdrawnWithHistory(serviceId: string): Promise<void> {
  const detail = (await getService(env.DB, serviceId)) as { endpoints: unknown[] };
  expect(detail.endpoints).toEqual([]);
  expect(
    (await env.DB.prepare("SELECT COUNT(*) AS count FROM endpoints WHERE service_id=?").bind(serviceId).first<{ count: number }>())?.count,
  ).toBe(1);
  expect(
    (await env.DB.prepare("SELECT COUNT(*) AS count FROM payment_offers WHERE endpoint_id IN (SELECT id FROM endpoints WHERE service_id=?)").bind(serviceId).first<{ count: number }>())?.count,
  ).toBe(1);
  const history = await env.DB.prepare(
    "SELECT change_type FROM changes WHERE service_id=? AND change_type IN ('endpoint-source-withdrawn','payment-offer-withdrawn') ORDER BY change_type",
  )
    .bind(serviceId)
    .all<{ change_type: string }>();
  expect(history.results.map(({ change_type }) => change_type)).toEqual([
    "endpoint-source-withdrawn",
    "payment-offer-withdrawn",
  ]);
}

const laterResponses = [
  { name: "invalid JSON 200", status: 200, body: "{}", contentType:"application/json", withdraws: true, state:"tested-fail" },
  { name: "ordinary HTML 200", status: 200, body: "<html>not a discovery document</html>", contentType:"text/html", withdraws: true, state:"observed" },
  { name: "HTTP 404", status: 404, body: "not found", contentType:"text/plain", withdraws: true, state:"observed" },
  { name: "transient HTTP 500", status: 500, body: "temporary", contentType:"text/plain", withdraws: false, state:null },
] as const;

describe("authoritative discovery absence", () => {
  it.each(laterResponses)("reconciles an OpenAPI source after $name", async ({ name, status, body, contentType, withdraws, state }) => {
    const serviceId = `openapi-authoritative-${name.replace(/[^a-z0-9]+/gi,"-").toLowerCase()}`;
    const serviceUrl = `https://1.1.1.1/${serviceId}/`;
    const sourceRef = `${serviceUrl}openapi.json`;
    await insertService(serviceId, serviceUrl);
    const { bindings, batches } = queueEnv();
    const parent: CrawlMessage = { type: "probe", url: sourceRef, serviceId, kind: "openapi", source: "catalog" };
    await enqueueTarget(bindings, parent, 0, false, {
      sourceType: "catalog",
      sourceRef: MPP_CATALOG_URL,
      observedAt: "2026-08-24T01:00:00.000Z",
    });
    await markTargetPreviouslyComplete(parent);
    await seedOpenApiOffer(bindings, serviceId, sourceRef, `${serviceId}-s1`);
    expect(((await getService(env.DB, serviceId)) as { endpoints: unknown[] }).endpoints).toHaveLength(1);

    const next = await scheduleRecrawl(bindings, parent);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const requested = input instanceof Request ? input.url : input.toString();
      if (requested !== sourceRef) throw new Error(`unexpected fetch: ${requested}`);
      return new Response(body, { status, headers: { "Content-Type": contentType } });
    });
    await env.DB.prepare("DELETE FROM origin_rate_limits WHERE origin=?").bind(new URL(sourceRef).origin).run();
    await processCrawlMessage(bindings, next);

    const parseState = await env.DB.prepare(
      "SELECT state FROM security_properties WHERE service_id=? AND property_key='openapi_parse'",
    )
      .bind(serviceId)
      .first<{ state: string }>();
    if (withdraws) {
      expect(parseState).toEqual({ state });
      await expectWithdrawnWithHistory(serviceId);
    } else {
      expect(parseState).toBeNull();
      expect(
        await env.DB.prepare("SELECT active,observed_at FROM endpoint_sources WHERE source_type='openapi' AND source_ref=?")
          .bind(sourceRef)
          .first(),
      ).toEqual({ active: 1, observed_at: "2026-08-24T01:00:00.000Z" });
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS count FROM active_endpoint_sources aes JOIN endpoints e ON e.id=aes.endpoint_id WHERE e.service_id=?")
          .bind(serviceId)
          .first(),
      ).toEqual({ count: 1 });
      expect(((await getService(env.DB, serviceId)) as { endpoints: unknown[] }).endpoints).toHaveLength(1);
    }
    expect(batches.some((message) => message.type === "openapi-operation")).toBe(false);
  });

  it.each(laterResponses)("cascades an API-catalog source after $name", async ({ name, status, body, contentType, withdraws, state }) => {
    const serviceId = `api-catalog-authoritative-${name.replace(/[^a-z0-9]+/gi,"-").toLowerCase()}`;
    const serviceUrl = `https://8.8.8.8/${serviceId}/`;
    const catalogUrl = `${serviceUrl}.well-known/api-catalog`;
    const openApiUrl = `https://8.8.8.8/${serviceId}/openapi.json`;
    await insertService(serviceId, serviceUrl);
    const { bindings } = queueEnv();
    const catalogParent: CrawlMessage = { type: "probe", url: catalogUrl, serviceId, kind: "api-catalog", source: "catalog" };
    await enqueueTarget(bindings, catalogParent, 0, false, {
      sourceType: "catalog",
      sourceRef: MPP_CATALOG_URL,
      observedAt: "2026-08-24T01:00:00.000Z",
    });
    await markTargetPreviouslyComplete(catalogParent);
    const openApiParent: CrawlMessage = { type: "probe", url: openApiUrl, serviceId, kind: "openapi", source: "openapi" };
    await enqueueTarget(bindings, openApiParent, 0, false, {
      sourceType: "api-catalog",
      sourceRef: catalogUrl,
      observedAt: "2026-08-24T01:00:00.000Z",
    });
    await markTargetPreviouslyComplete(openApiParent);
    await seedOpenApiOffer(bindings, serviceId, openApiUrl, `${serviceId}-s1`);
    expect(((await getService(env.DB, serviceId)) as { endpoints: unknown[] }).endpoints).toHaveLength(1);

    const next = await scheduleRecrawl(bindings, catalogParent);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const requested = input instanceof Request ? input.url : input.toString();
      if (requested !== catalogUrl) throw new Error(`unexpected fetch: ${requested}`);
      return new Response(body, { status, headers: { "Content-Type": contentType } });
    });
    await env.DB.prepare("DELETE FROM origin_rate_limits WHERE origin=?").bind(new URL(catalogUrl).origin).run();
    await processCrawlMessage(bindings, next);

    const parseState = await env.DB.prepare(
      "SELECT state FROM security_properties WHERE service_id=? AND property_key='api_catalog_parse'",
    )
      .bind(serviceId)
      .first<{ state: string }>();
    if (withdraws) {
      expect(parseState).toEqual({ state });
      await expectWithdrawnWithHistory(serviceId);
      expect(
        await env.DB.prepare("SELECT active FROM crawl_target_sources WHERE source_type='api-catalog' AND source_ref=?")
          .bind(catalogUrl)
          .first(),
      ).toEqual({ active: 0 });
    } else {
      expect(parseState).toBeNull();
      expect(
        await env.DB.prepare("SELECT active,observed_at FROM endpoint_sources WHERE source_type='openapi' AND source_ref=?")
          .bind(openApiUrl)
          .first(),
      ).toEqual({ active: 1, observed_at: "2026-08-24T01:00:00.000Z" });
      expect(((await getService(env.DB, serviceId)) as { endpoints: unknown[] }).endpoints).toHaveLength(1);
    }
  });
});
