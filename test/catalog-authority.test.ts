import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MPP_CATALOG_URL,
  enqueueDueTargets,
  enqueueTarget,
  importMppCatalog,
  processCatalogService,
  validCatalog,
} from "../src/catalog";
import { processCrawlMessage } from "../src/crawler";
import {
  reconcileCatalogRun,
  startSourceSnapshot,
  upsertCatalogService,
} from "../src/db";
import type {
  CatalogDocument,
  CatalogIngestMessage,
  CatalogService,
  CrawlMessage,
  DueTargetMessage,
  ObservatoryQueueMessage,
} from "../src/model";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface CapturedQueue {
  catalog: CatalogIngestMessage[];
  direct: ObservatoryQueueMessage[];
  batches: ObservatoryQueueMessage[][];
}

function catalogEnv(): { bindings: Env; captured: CapturedQueue } {
  const captured: CapturedQueue = { catalog: [], direct: [], batches: [] };
  const bindings = {
    DB: env.DB,
    CRAWL_QUEUE: {
      send: async (body: ObservatoryQueueMessage) => {
        captured.direct.push(body);
      },
      sendBatch: async (batch: Array<{ body: ObservatoryQueueMessage }>) => {
        const bodies = batch.map(({ body }) => body);
        captured.batches.push(bodies);
        for (const body of bodies) {
          if (body.type === "catalog-service") captured.catalog.push(body);
        }
      },
    },
  } as unknown as Env;
  return { bindings, captured };
}

function installCatalog(document: CatalogDocument): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const requested = input instanceof Request ? input.url : input.toString();
    if (requested !== MPP_CATALOG_URL) throw new Error(`unexpected fetch: ${requested}`);
    return new Response(JSON.stringify(document), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function service(id: string, serviceUrl: string, path = "/paid"): CatalogService {
  return {
    id,
    name: id,
    serviceUrl,
    endpoints: [
      {
        method: "GET",
        path,
        description: `${id} paid endpoint`,
        payment: {
          method: "tempo",
          intent: "charge",
          currency: "USDC",
          amount: "1",
          recipient: `0x${id}`,
        },
      },
    ],
  };
}

async function importDocument(
  bindings: Env,
  captured: CapturedQueue,
  document: CatalogDocument,
  observedAt: string,
): Promise<{ result: Awaited<ReturnType<typeof importMppCatalog>>; messages: CatalogIngestMessage[] }> {
  captured.catalog.length = 0;
  installCatalog(document);
  const result = await importMppCatalog(bindings, observedAt);
  return { result, messages: [...captured.catalog] };
}

async function processAll(bindings: Env, messages: readonly CatalogIngestMessage[]): Promise<void> {
  for (const message of messages) await processCatalogService(bindings, message);
}

async function catalogState(serviceId: string): Promise<{ endpoints: number; offers: number; targets: number }> {
  const row = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM endpoint_sources es JOIN endpoints e ON e.id=es.endpoint_id WHERE e.service_id=? AND es.source_type='catalog' AND es.active=1) AS endpoints,
    (SELECT COUNT(*) FROM payment_offers p JOIN endpoints e ON e.id=p.endpoint_id WHERE e.service_id=? AND p.source_type='catalog' AND p.active=1) AS offers,
    (SELECT COUNT(*) FROM crawl_target_sources cts JOIN crawl_targets ct ON ct.id=cts.target_id WHERE ct.service_id=? AND cts.source_type='catalog' AND cts.active=1) AS targets`)
    .bind(serviceId, serviceId, serviceId)
    .first<{ endpoints: number; offers: number; targets: number }>();
  return {
    endpoints: Number(row?.endpoints ?? 0),
    offers: Number(row?.offers ?? 0),
    targets: Number(row?.targets ?? 0),
  };
}

async function catalogServiceId(serviceUrl: string): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM services WHERE service_url=?")
    .bind(serviceUrl)
    .first<{ id: string }>();
  if (!row) throw new Error(`catalog service missing: ${serviceUrl}`);
  return row.id;
}

describe("authoritative catalog validation and normalized dedupe", () => {
  it("accepts the live mpp.dev null-payment endpoint shape as an unpaid advertised endpoint", () => {
    expect(validCatalog({
      version:1,
      services:[{
        id:"agentmail-live-shape",
        name:"AgentMail live-shape fixture",
        serviceUrl:"https://agentmail.example/",
        endpoints:[{method:"GET",path:"/v0/inboxes",description:"Public catalog entry",payment:null}],
      }],
    })).toBe(true);
  });

  it("rejects catalogs containing more than 500 services before Queue fan-out", async () => {
    const { bindings, captured } = catalogEnv();
    installCatalog({
      version: 1,
      services: Array.from({ length: 501 }, (_, index) => ({
        id: `too-many-${index}`,
        name: `Too many ${index}`,
        serviceUrl: `https://too-many-${index}.example/`,
      })),
    });

    await expect(importMppCatalog(bindings, "2026-08-25T01:00:00.000Z")).rejects.toThrow(
      "catalog-invalid-shape",
    );
    expect(captured.batches).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT status,expected_services,error_detail FROM discovery_runs WHERE source_kind='mpp.dev-catalog'",
      ).first(),
    ).toEqual({ status: "failed", expected_services: 0, error_detail: "catalog-invalid-shape" });
  });

  it("merges duplicate normalized service URLs and completes the one-service barrier", async () => {
    const { bindings, captured } = catalogEnv();
    const observedAt = "2026-08-25T02:00:00.000Z";
    const { result, messages } = await importDocument(
      bindings,
      captured,
      {
        version: 1,
        services: [
          {
            ...service("normalized-first", "https://DUPLICATE-CATALOG.example:443/api?source=first", "/alpha"),
            endpoints: [
              ...service("normalized-first", "https://duplicate-catalog.example/api", "/alpha").endpoints!,
              ...service("normalized-first", "https://duplicate-catalog.example/api", "/shared").endpoints!,
            ],
          },
          {
            ...service("normalized-second", "https://duplicate-catalog.example/api?source=second", "/beta"),
            endpoints: [
              ...service("normalized-second", "https://duplicate-catalog.example/api", "/beta").endpoints!,
              ...service("normalized-second", "https://duplicate-catalog.example/api", "/shared").endpoints!,
            ],
          },
        ],
      },
      observedAt,
    );

    expect(result).toEqual({ services: 1, endpoints: 3, queued: 3 });
    expect(messages).toHaveLength(3);
    expect(new Set(messages.map((message) => message.snapshotId)).size).toBe(1);
    expect(messages.every((message) => message.expectedItems === 3)).toBe(true);
    await processAll(bindings, messages);

    expect(
      await env.DB.prepare(
        "SELECT status,expected_services,discovered_services,discovered_endpoints FROM discovery_runs WHERE id=?",
      )
        .bind(messages[0].discoveryRunId)
        .first(),
    ).toEqual({
      status: "complete",
      expected_services: 1,
      discovered_services: 1,
      discovered_endpoints: 3,
    });
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM discovery_run_services WHERE run_id=?")
        .bind(messages[0].discoveryRunId)
        .first<{ count: number }>())?.count,
    ).toBe(1);
    const normalizedId = await catalogServiceId("https://duplicate-catalog.example/api");
    expect(normalizedId).toMatch(/^catalog-[a-f0-9]{48}$/);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM endpoints WHERE service_id=?")
        .bind(normalizedId)
        .first<{ count: number }>())
        ?.count,
    ).toBe(3);
  });
});

describe("whole-service catalog withdrawal barriers", () => {
  it("withdraws an omitted service only after every service in the new catalog has completed", async () => {
    const { bindings, captured } = catalogEnv();
    const first = await importDocument(
      bindings,
      captured,
      { version: 1, services: [service("barrier-omitted", "https://barrier-omitted.example/")] },
      "2026-08-25T10:00:00.000Z",
    );
    await processAll(bindings, first.messages);
    const omittedId = await catalogServiceId("https://barrier-omitted.example/");
    expect(await catalogState(omittedId)).toEqual({ endpoints: 1, offers: 1, targets: 3 });

    const replacement = await importDocument(
      bindings,
      captured,
      { version: 1, services: [service("barrier-present", "https://barrier-present.example/")] },
      "2026-08-25T11:00:00.000Z",
    );
    expect(await catalogState(omittedId)).toEqual({ endpoints: 1, offers: 1, targets: 3 });
    expect(
      (await env.DB.prepare("SELECT status FROM discovery_runs WHERE id=?")
        .bind(replacement.messages[0].discoveryRunId)
        .first<{ status: string }>())?.status,
    ).toBe("processing");

    await processAll(bindings, replacement.messages);
    expect(await catalogState(omittedId)).toEqual({ endpoints: 0, offers: 0, targets: 0 });
    expect(
      (await env.DB.prepare("SELECT status FROM discovery_runs WHERE id=?")
        .bind(replacement.messages[0].discoveryRunId)
        .first<{ status: string }>())?.status,
    ).toBe("complete");
  });

  it("lets a complete older run reconcile absence when a newer run fails after partial processing", async () => {
    const { bindings, captured } = catalogEnv();
    const baseline = await importDocument(
      bindings,
      captured,
      { version: 1, services: [service("partial-omitted", "https://partial-omitted.example/")] },
      "2026-08-25T20:00:00.000Z",
    );
    await processAll(bindings, baseline.messages);
    const omittedId = await catalogServiceId("https://partial-omitted.example/");

    const older = await importDocument(
      bindings,
      captured,
      { version: 1, services: [service("partial-older", "https://partial-older.example/")] },
      "2026-08-25T21:00:00.000Z",
    );
    const newer = await importDocument(
      bindings,
      captured,
      {
        version: 1,
        services: [
          service("partial-newer-a", "https://partial-newer-a.example/"),
          service("partial-newer-b", "https://partial-newer-b.example/"),
        ],
      },
      "2026-08-25T22:00:00.000Z",
    );
    await processCatalogService(bindings, newer.messages[0]);
    expect(
      (await env.DB.prepare("SELECT status FROM discovery_runs WHERE id=?")
        .bind(newer.messages[0].discoveryRunId)
        .first<{ status: string }>())?.status,
    ).toBe("processing");
    await env.DB.prepare("UPDATE discovery_runs SET status='failed',finished_at=? WHERE id=?")
      .bind("2026-08-25T22:30:00.000Z",newer.messages[0].discoveryRunId).run();

    await processAll(bindings, older.messages);
    expect(await catalogState(omittedId)).toEqual({ endpoints: 0, offers: 0, targets: 0 });

    await processCatalogService(bindings, newer.messages[1]);
    expect(await catalogState(omittedId)).toEqual({ endpoints: 0, offers: 0, targets: 0 });
    expect((await env.DB.prepare("SELECT status FROM discovery_runs WHERE id=?").bind(newer.messages[0].discoveryRunId).first<{status:string}>())?.status).toBe("failed");
  });
});

describe("target provenance and reconciliation recovery", () => {
  it("keeps manual and MPPScan provenance active and a no-402 target due-eligible after catalog withdrawal", async () => {
    const serviceId = "multi-source-target";
    const targetUrl = "https://1.0.0.3/multi-source-target";
    await env.DB.prepare(
      "INSERT INTO services (id,name,service_url,origin,status,first_seen,last_seen) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(
        serviceId,
        serviceId,
        targetUrl,
        "https://1.0.0.3",
        "candidate",
        "2026-08-25T00:00:00.000Z",
        "2026-08-25T00:00:00.000Z",
      )
      .run();
    const direct: ObservatoryQueueMessage[] = [];
    const due: DueTargetMessage[] = [];
    const r2 = new Map<string, string>();
    const bindings = {
      DB: env.DB,
      CRAWL_QUEUE: {
        send: async (body: ObservatoryQueueMessage) => direct.push(body),
        sendBatch: async (batch: Array<{ body: DueTargetMessage }>) => {
          due.push(...batch.map(({ body }) => body));
        },
      },
      OBSERVATIONS: {
        get: async (key: string) => {
          const value = r2.get(key);
          return value === undefined ? null : { text: async () => value };
        },
        put: async (key: string, value: string) => {
          r2.set(key, value);
        },
      },
    } as unknown as Env;
    const target: CrawlMessage = {
      type: "probe",
      url: targetUrl,
      serviceId,
      kind: "endpoint",
      source: "catalog",
    };
    await enqueueTarget(bindings, target, 0, false, {
      sourceType: "catalog",
      sourceRef: MPP_CATALOG_URL,
      observedAt: "2026-08-25T22:45:00.000Z",
    });
    await enqueueTarget(bindings, { ...target, source: "manual" }, 0, false, {
      sourceType: "manual",
      sourceRef: "https://mpp.ninja/submit",
      observedAt: "2026-08-25T22:45:00.000Z",
    });
    await enqueueTarget(bindings, { ...target, source: "mppscan" }, 0, false, {
      sourceType: "mppscan",
      sourceRef: "https://mppscan.com/",
      observedAt: "2026-08-25T22:45:00.000Z",
    });
    expect((direct[0] as CrawlMessage).source).toBe("catalog");
    expect(await env.DB.prepare("SELECT active FROM crawl_target_sources WHERE target_id IN (SELECT id FROM crawl_targets WHERE service_id=?) AND source_type='manual'").bind(serviceId).first()).toEqual({active:1});
    await env.DB.prepare("UPDATE crawl_targets SET run_observed_at=? WHERE service_id=?")
      .bind("2026-08-25T22:46:00.000Z", serviceId)
      .run();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const requested = input instanceof Request ? input.url : input.toString();
      if (requested !== targetUrl) throw new Error(`unexpected fetch: ${requested}`);
      return new Response("ordinary public response", { status: 200 });
    });
    await processCrawlMessage(bindings, direct[0] as CrawlMessage);
    expect(await env.DB.prepare("SELECT active FROM crawl_target_sources WHERE target_id IN (SELECT id FROM crawl_targets WHERE service_id=?) AND source_type='manual'").bind(serviceId).first()).toEqual({active:1});
    expect(
      (await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM endpoint_sources WHERE source_type='challenge' AND active=1 AND endpoint_id IN (SELECT id FROM endpoints WHERE service_id=?)",
      )
        .bind(serviceId)
        .first<{ count: number }>())?.count,
    ).toBe(0);
    await env.DB.prepare("UPDATE crawl_targets SET next_due_at='2026-08-25T00:00:00.000Z' WHERE service_id=?")
      .bind(serviceId)
      .run();

    await env.DB.prepare(
      "INSERT INTO discovery_runs (id,source_kind,source_url,started_at,status,expected_services) VALUES (?,?,?,?,?,0)",
    )
      .bind(
        "multi-source-withdrawal-run",
        "mpp.dev-catalog",
        MPP_CATALOG_URL,
        "2026-08-25T23:00:00.000Z",
        "processing",
      )
      .run();
    await reconcileCatalogRun(env.DB, "multi-source-withdrawal-run");

    const provenance = await env.DB.prepare(
      "SELECT source_type,active FROM crawl_target_sources WHERE target_id IN (SELECT id FROM crawl_targets WHERE service_id=?) ORDER BY source_type",
    )
      .bind(serviceId)
      .all<{ source_type: string; active: number }>();
    expect(provenance.results).toEqual([
      { source_type: "catalog", active: 0 },
      { source_type: "manual", active: 1 },
      { source_type: "mppscan", active: 1 },
    ]);
    await enqueueDueTargets(bindings, 100);
    expect(due).toEqual([
      {
        type: "due-target",
        url: targetUrl,
        serviceId,
        endpointId: undefined,
        kind: "endpoint",
      },
    ]);
  });

  it("retries snapshot reconciliation when an item survived a simulated post-insert failure", async () => {
    const sourceRef = MPP_CATALOG_URL;
    const observedAt = "2026-08-27T02:00:00.000Z";
    const initial = service("reconcile-retry", "https://reconcile-retry.example/");
    const result = await upsertCatalogService(
      env.DB,
      initial,
      sourceRef,
      "2026-08-27T01:00:00.000Z",
    );
    await startSourceSnapshot(env.DB, {
      id: "reconcile-retry-snapshot",
      serviceId: result.serviceId,
      sourceType: "catalog",
      sourceRef,
      observedAt,
      expectedItems: 1,
    });
    await env.DB.prepare(
      "INSERT INTO source_snapshot_items (snapshot_id,item_id,processed_at) VALUES (?,?,?)",
    )
      .bind("reconcile-retry-snapshot", "reconcile-retry-snapshot:0", observedAt)
      .run();
    await env.DB.prepare(
      "INSERT INTO discovery_runs (id,source_kind,source_url,started_at,status,expected_services) VALUES (?,?,?,?,?,1)",
    )
      .bind("reconcile-retry-run", "mpp.dev-catalog", sourceRef, observedAt, "processing")
      .run();
    const sent: ObservatoryQueueMessage[] = [];
    const bindings = {
      DB: env.DB,
      CRAWL_QUEUE: { send: async (body: ObservatoryQueueMessage) => sent.push(body) },
    } as unknown as Env;
    const retry: CatalogIngestMessage = {
      type: "catalog-service",
      service: { ...initial, endpoints: [] },
      sourceUrl: sourceRef,
      observedAt,
      discoveryRunId: "reconcile-retry-run",
      snapshotId: "reconcile-retry-snapshot",
      itemId: "reconcile-retry-snapshot:0",
      expectedItems: 1,
    };

    await processCatalogService(bindings, retry);

    expect(sent).toEqual([]);
    expect(
      await env.DB.prepare("SELECT status FROM source_snapshots WHERE id='reconcile-retry-snapshot'").first(),
    ).toEqual({ status: "complete" });
    expect(await catalogState(result.serviceId)).toMatchObject({ endpoints: 0, offers: 0 });
    expect(
      await env.DB.prepare("SELECT status FROM discovery_runs WHERE id='reconcile-retry-run'").first(),
    ).toEqual({ status: "complete" });
  });
});

describe("catalog Queue fan-out preflight", () => {
  it.each([
    {
      name: "message count",
      observedAt: "2026-08-26T01:00:00.000Z",
      document: {
        version: 1,
        services: Array.from({ length: 32 }, (_, serviceIndex) => ({
          id: `message-cap-${serviceIndex}`,
          name: `Message cap ${serviceIndex}`,
          serviceUrl: `https://message-cap-${serviceIndex}.example/`,
          endpoints: Array.from({ length: 160 }, (_, endpointIndex) => ({
            method: "GET",
            path: `/p-${endpointIndex}`,
          })),
        })),
      } satisfies CatalogDocument,
    },
    {
      name: "expanded bytes",
      observedAt: "2026-08-26T02:00:00.000Z",
      document: {
        version: 1,
        services: Array.from({length:31},(_,serviceIndex)=>({
            id: `expanded-byte-cap-${serviceIndex}`,
            name: `Expanded byte cap ${serviceIndex}`,
            serviceUrl: `https://expanded-byte-cap-${serviceIndex}.example/`,
            categories: Array.from({ length: 100 }, (_, index) => `${index}-${"x".repeat(196)}`),
            endpoints: Array.from({ length: 160 }, (_, endpointIndex) => ({
              method: "GET",
              path: `/p-${endpointIndex}`,
            })),
        })),
      } satisfies CatalogDocument,
    },
  ])("fails the $name limit before sending any Queue batch", async ({ document, observedAt }) => {
    const { bindings, captured } = catalogEnv();
    installCatalog(document);

    await expect(importMppCatalog(bindings, observedAt)).rejects.toMatchObject({
      code: "queue-run-too-large",
    });
    expect(captured.batches).toEqual([]);
    expect(
      await env.DB.prepare("SELECT status,error_detail FROM discovery_runs WHERE source_kind='mpp.dev-catalog' AND started_at=?")
        .bind(observedAt)
        .first(),
    ).toEqual({
      status: "failed",
      error_detail: "Normalized queue fan-out exceeds the per-run budget",
    });
  });
});
