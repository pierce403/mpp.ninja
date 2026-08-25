import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enqueueTarget, processCatalogService, processDueTarget } from "../src/catalog";
import { processCrawlMessage, processOpenApiOperation } from "../src/crawler";
import { startSourceSnapshot } from "../src/db";
import type {
  CatalogIngestMessage,
  CrawlMessage,
  DueTargetMessage,
  ObservatoryQueueMessage,
  OpenApiOperationMessage,
} from "../src/model";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function insertService(id: string, serviceUrl: string): Promise<void> {
  const url = new URL(serviceUrl);
  await env.DB.prepare(
    "INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, id, serviceUrl, url.origin, "2026-08-25T00:00:00.000Z", "2026-08-25T00:00:00.000Z")
    .run();
}

function memoryR2(): {
  bucket: R2Bucket;
  objects: Map<string, string>;
} {
  const objects = new Map<string, string>();
  return {
    objects,
    bucket: {
      get: async (key: string) => {
        const value = objects.get(key);
        return value === undefined ? null : { text: async () => value };
      },
      put: async (key: string, value: string) => {
        objects.set(key, value);
      },
    } as unknown as R2Bucket,
  };
}

describe("crawl processing ownership", () => {
  it("allows only one delivery to own a crawl run processing token", async () => {
    const serviceId = "exclusive-crawl-run";
    const url = "https://1.1.1.1/exclusive-crawl-run";
    await insertService(serviceId, "https://1.1.1.1/exclusive-crawl-run");
    const queued: CrawlMessage[] = [];
    const r2 = memoryR2();
    const fakeEnv = {
      DB: env.DB,
      CRAWL_QUEUE: { send: async (body: CrawlMessage) => queued.push(body) },
      OBSERVATIONS: r2.bucket,
    } as unknown as Env;
    const target: CrawlMessage = { type: "probe", url, serviceId, kind: "endpoint", source: "scheduled" };
    await enqueueTarget(fakeEnv, target, 0, false, {
      sourceType: "mppscan",
      sourceRef: "https://mppscan.com/",
      observedAt: "2026-08-25T00:00:00.000Z",
    });

    let releaseTarget!: () => void;
    let markTargetStarted!: () => void;
    const targetStarted = new Promise<void>((resolve) => {
      markTargetStarted = resolve;
    });
    const targetReleased = new Promise<void>((resolve) => {
      releaseTarget = resolve;
    });
    let targetFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const requested = input instanceof Request ? input.url : input.toString();
      if (requested !== url) throw new Error(`unexpected fetch: ${requested}`);
      targetFetches += 1;
      markTargetStarted();
      await targetReleased;
      return new Response("exclusive response", { status: 200 });
    });

    const first = processCrawlMessage(fakeEnv, queued[0]);
    await targetStarted;
    await expect(processCrawlMessage(fakeEnv, queued[0])).rejects.toMatchObject({ code: "run-in-progress" });
    const processing = await env.DB.prepare(
      "SELECT status,processing_token,processing_expires_at FROM crawl_targets WHERE service_id=?",
    )
      .bind(serviceId)
      .first<{ status: string; processing_token: string | null; processing_expires_at: string | null }>();
    expect(processing?.status).toBe("processing");
    expect(processing?.processing_token).toMatch(/^[0-9a-f-]{36}$/i);
    expect(processing?.processing_expires_at).toBeTruthy();
    expect(targetFetches).toBe(1);

    releaseTarget();
    await first;
    expect(targetFetches).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT status,processing_token,processing_expires_at FROM crawl_targets WHERE service_id=?",
      )
        .bind(serviceId)
        .first(),
    ).toMatchObject({ status: "complete", processing_token: null, processing_expires_at: null });
  });

  it("cannot mark a crawl complete after its processing token is replaced", async () => {
    const serviceId = "stolen-completion-token";
    const url = "https://8.8.8.8/stolen-completion-token";
    await insertService(serviceId, "https://8.8.8.8/stolen-completion-token");
    const queued: CrawlMessage[] = [];
    const r2 = memoryR2();
    const baseEnv = {
      DB: env.DB,
      CRAWL_QUEUE: { send: async (body: CrawlMessage) => queued.push(body) },
      OBSERVATIONS: r2.bucket,
    } as unknown as Env;
    await enqueueTarget(
      baseEnv,
      { type: "probe", url, serviceId, kind: "endpoint", source: "scheduled" },
      0,
      false,
      {
        sourceType: "mppscan",
        sourceRef: "https://mppscan.com/",
        observedAt: "2026-08-25T00:00:00.000Z",
      },
    );
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const requested = input instanceof Request ? input.url : input.toString();
      if (requested !== url) throw new Error(`unexpected fetch: ${requested}`);
      return new Response("owned response", { status: 200 });
    });

    const guardedDb = {
      prepare(sql: string) {
        const statement = env.DB.prepare(sql);
        if (!sql.startsWith("UPDATE crawl_targets SET status=?,attempt_count=")) return statement;
        return {
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values);
            return {
              run: async () => {
                await env.DB.prepare("UPDATE crawl_targets SET processing_token='replacement-token' WHERE service_id=?")
                  .bind(serviceId)
                  .run();
                return bound.run();
              },
            };
          },
        } as unknown as D1PreparedStatement;
      },
      batch(statements: D1PreparedStatement[]) {
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    const guardedEnv = { ...baseEnv, DB: guardedDb } as unknown as Env;

    await expect(processCrawlMessage(guardedEnv, queued[0])).rejects.toMatchObject({ code: "run-lease-lost" });
    expect(
      await env.DB.prepare("SELECT status,processing_token FROM crawl_targets WHERE service_id=?")
        .bind(serviceId)
        .first(),
    ).toMatchObject({ status: "processing", processing_token: "replacement-token" });
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM observations WHERE service_id=?").bind(serviceId).first<{ count: number }>())
        ?.count,
    ).toBe(1);
  });
});

describe("completed source-message and due-target idempotency", () => {
  it("does not re-enqueue probes when a completed catalog source item is delivered again", async () => {
    const serviceId = "completed-catalog-message";
    const discoveryRunId = "completed-catalog-message-run";
    const sent: ObservatoryQueueMessage[] = [];
    const fakeEnv = {
      DB: env.DB,
      CRAWL_QUEUE: { send: async (body: ObservatoryQueueMessage) => sent.push(body) },
    } as unknown as Env;
    await env.DB.prepare(
      "INSERT INTO discovery_runs (id,source_kind,source_url,started_at,status,expected_services) VALUES (?,?,?,?,?,?)",
    )
      .bind(
        discoveryRunId,
        "mpp.dev-catalog",
        "https://mpp.dev/api/services",
        "2026-08-25T01:00:00.000Z",
        "processing",
        1,
      )
      .run();
    const message: CatalogIngestMessage = {
      type: "catalog-service",
      service: {
        id: serviceId,
        name: "Completed catalog message",
        serviceUrl: "https://completed-catalog-message.example/",
        endpoints: [
          {
            method: "GET",
            path: "/paid",
            payment: { method: "tempo", intent: "charge", amount: "1", currency: "USDC" },
          },
        ],
      },
      sourceUrl: "https://mpp.dev/api/services",
      observedAt: "2026-08-25T01:00:00.000Z",
      discoveryRunId,
      snapshotId: "completed-catalog-message-snapshot",
      itemId: "completed-catalog-message-snapshot:0",
      expectedItems: 1,
    };

    await processCatalogService(fakeEnv, message);
    expect(sent.length).toBeGreaterThan(0);
    expect(
      (await env.DB.prepare("SELECT status FROM source_snapshots WHERE id=?").bind(message.snapshotId).first<{ status: string }>())
        ?.status,
    ).toBe("complete");
    await env.DB.prepare("DELETE FROM crawl_targets WHERE service_id=?").bind(serviceId).run();
    sent.length = 0;

    await processCatalogService(fakeEnv, message);
    expect(sent).toEqual([]);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM crawl_targets WHERE service_id=?").bind(serviceId).first<{ count: number }>())
        ?.count,
    ).toBe(0);
  });

  it("does not re-enqueue a probe when a completed OpenAPI source item is delivered again", async () => {
    const serviceId = "completed-openapi-message";
    const baseUrl = "https://completed-openapi-message.example/openapi.json";
    await insertService(serviceId, "https://completed-openapi-message.example/");
    await env.DB.prepare("UPDATE services SET status='observed-mpp' WHERE id=?").bind(serviceId).run();
    const sent: ObservatoryQueueMessage[] = [];
    const fakeEnv = {
      DB: env.DB,
      CRAWL_QUEUE: { send: async (body: ObservatoryQueueMessage) => sent.push(body) },
    } as unknown as Env;
    const message: OpenApiOperationMessage = {
      type: "openapi-operation",
      serviceId,
      baseUrl,
      operation: {
        method: "GET",
        path: "/paid",
        description: "Paid endpoint",
        offers: [{ method: "tempo", intent: "charge", amount: "1", currency: "USDC" }],
      },
      offerOffset: 0,
      observedAt: "2026-08-25T01:00:00.000Z",
      sourceRef: baseUrl,
      snapshotId: "completed-openapi-message-snapshot",
      itemId: "completed-openapi-message-snapshot:0",
    };
    await startSourceSnapshot(env.DB, {
      id: message.snapshotId,
      serviceId,
      sourceType: "openapi",
      sourceRef: message.sourceRef,
      observedAt: message.observedAt,
      expectedItems: 1,
    });

    await processOpenApiOperation(fakeEnv, message);
    expect(sent).toHaveLength(1);
    expect(
      (await env.DB.prepare("SELECT status FROM source_snapshots WHERE id=?").bind(message.snapshotId).first<{ status: string }>())
        ?.status,
    ).toBe("complete");
    await env.DB.prepare("DELETE FROM crawl_targets WHERE service_id=?").bind(serviceId).run();
    sent.length = 0;

    await processOpenApiOperation(fakeEnv, message);
    expect(sent).toEqual([]);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM crawl_targets WHERE service_id=?").bind(serviceId).first<{ count: number }>())
        ?.count,
    ).toBe(0);
  });

  it("does not advance a completed target when a forced due message arrives before next_due_at", async () => {
    const serviceId = "future-due-target";
    const url = "https://9.9.9.9/future-due-target";
    await insertService(serviceId, "https://9.9.9.9/future-due-target");
    const sent: ObservatoryQueueMessage[] = [];
    const fakeEnv = {
      DB: env.DB,
      CRAWL_QUEUE: { send: async (body: ObservatoryQueueMessage) => sent.push(body) },
    } as unknown as Env;
    const target: CrawlMessage = { type: "probe", url, serviceId, kind: "endpoint", source: "scheduled" };
    await enqueueTarget(fakeEnv, target, 0);
    const before = await env.DB.prepare("SELECT id,generation,run_id FROM crawl_targets WHERE service_id=?")
      .bind(serviceId)
      .first<{ id: string; generation: number; run_id: string }>();
    const futureDue = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    await env.DB.prepare("UPDATE crawl_targets SET status='complete',next_due_at=? WHERE id=?")
      .bind(futureDue, before?.id)
      .run();
    sent.length = 0;
    const due: DueTargetMessage = { type: "due-target", url, serviceId, kind: "endpoint" };

    await processDueTarget(fakeEnv, due);

    expect(sent).toEqual([]);
    expect(
      await env.DB.prepare("SELECT status,generation,run_id,next_due_at FROM crawl_targets WHERE id=?")
        .bind(before?.id)
        .first(),
    ).toEqual({
      status: "complete",
      generation: before?.generation,
      run_id: before?.run_id,
      next_due_at: futureDue,
    });
  });
});
