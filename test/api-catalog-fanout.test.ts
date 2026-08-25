import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enqueueDueTargets, enqueueTarget, processDueTarget } from "../src/catalog";
import { MAX_API_CATALOG_LINKS_PER_DOCUMENT } from "../src/budgets";
import { processApiCatalogLink, processCrawlMessage } from "../src/crawler";
import { startSourceSnapshot } from "../src/db";
import worker from "../src/index";
import type { ApiCatalogLinkMessage, DueTargetMessage, ObservatoryQueueMessage } from "../src/model";

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

describe("RFC 9727 fan-out", () => {
  it("turns a maximum-size catalog into bounded link messages without creating per-link crawl rows", async () => {
    const serviceId = "api-catalog-fanout";
    const catalogUrl = "https://catalog.example/.well-known/api-catalog";
    await insertService(serviceId, "https://catalog.example/");

    const document = {
      linkset: [
        {
          anchor: "https://catalog.example/",
          "service-desc": Array.from({ length: MAX_API_CATALOG_LINKS_PER_DOCUMENT }, (_, index) => ({
            href: `https://specs.example/openapi-${String(index).padStart(3, "0")}.json?token=discarded`,
            type: "application/openapi+json",
          })),
        },
      ],
    };
    const sentBatches: Array<Array<{ body: ObservatoryQueueMessage }>> = [];
    const storedObservations: Array<{ key: string; value: string }> = [];
    const fakeEnv = {
      DB: env.DB,
      CRAWL_QUEUE: {
        sendBatch: async (batch: Array<{ body: ObservatoryQueueMessage }>) => {
          sentBatches.push(batch);
        },
      },
      OBSERVATIONS: {
        put: async (key: string, value: string) => {
          storedObservations.push({ key, value });
        },
      },
    } as unknown as Env;

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const raw = input instanceof Request ? input.url : input.toString();
      const url = new URL(raw);
      if (url.origin === "https://cloudflare-dns.com") {
        const type = url.searchParams.get("type");
        return new Response(
          JSON.stringify({
            Status: 0,
            Answer: type === "A" ? [{ type: 1, data: "1.1.1.1" }] : [],
          }),
          { status: 200, headers: { "Content-Type": "application/dns-json" } },
        );
      }
      if (raw === catalogUrl) {
        return new Response(JSON.stringify(document), {
          status: 200,
          headers: { "Content-Type": "application/linkset+json" },
        });
      }
      throw new Error(`unexpected fetch: ${raw}`);
    });

    await processCrawlMessage(fakeEnv, {
      type: "probe",
      url: catalogUrl,
      serviceId,
      kind: "api-catalog",
      source: "openapi",
    });

    expect(sentBatches.length).toBeGreaterThan(0);
    for (const batch of sentBatches) {
      expect(batch.length).toBeLessThanOrEqual(100);
      const estimatedBytes = batch.reduce(
        (sum, item) => sum + new TextEncoder().encode(JSON.stringify(item.body)).byteLength + 100,
        0,
      );
      expect(estimatedBytes).toBeLessThanOrEqual(240_000);
    }
    const messages = sentBatches.flatMap((batch) => batch.map((item) => item.body));
    expect(messages).toHaveLength(MAX_API_CATALOG_LINKS_PER_DOCUMENT);
    expect(
      messages.every(
        (message) =>
          message.type === "api-catalog-link" &&
          message.serviceId === serviceId &&
          !new URL(message.url).search,
      ),
    ).toBe(true);
    expect(messages[0]).toMatchObject({
      type: "api-catalog-link",
      serviceId,
      url: "https://specs.example/openapi-000.json",
      sourceRef:catalogUrl,
    });
    expect(messages[MAX_API_CATALOG_LINKS_PER_DOCUMENT-1]).toMatchObject({
      type: "api-catalog-link",
      serviceId,
      url: `https://specs.example/openapi-${String(MAX_API_CATALOG_LINKS_PER_DOCUMENT-1).padStart(3,"0")}.json`,
      sourceRef:catalogUrl,
    });
    const first=messages[0] as ApiCatalogLinkMessage;const last=messages[MAX_API_CATALOG_LINKS_PER_DOCUMENT-1] as ApiCatalogLinkMessage;
    expect(first.snapshotId).toMatch(/^[a-f0-9]{64}$/);expect(last.snapshotId).toBe(first.snapshotId);expect(first.itemId).toBe(`${first.snapshotId}:0`);expect(last.itemId).toBe(`${first.snapshotId}:${MAX_API_CATALOG_LINKS_PER_DOCUMENT-1}`);

    const targetCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM crawl_targets")
      .first<{ count: number }>();
    expect(targetCount?.count).toBe(0);
    const source = await env.DB.prepare(
      "SELECT source_kind,evidence_json FROM sources WHERE service_id=? AND source_kind='api-catalog'",
    )
      .bind(serviceId)
      .first<{ source_kind: string; evidence_json: string }>();
    expect(source?.source_kind).toBe("api-catalog");
    expect(JSON.parse(source?.evidence_json ?? "{}")).toMatchObject({ runtimeFetched: true, openApiLinks: MAX_API_CATALOG_LINKS_PER_DOCUMENT });
    expect(storedObservations).toHaveLength(1);
  });

  it("schedules each link as one OpenAPI probe and deduplicates repeated link messages", async () => {
    const serviceId = "api-catalog-link-worker";
    await insertService(serviceId, "https://link-worker.example/");
    await env.DB.prepare("UPDATE services SET status='observed-mpp' WHERE id=?").bind(serviceId).run();
    const sent: ObservatoryQueueMessage[] = [];
    const fakeEnv = {
      DB: env.DB,
      CRAWL_QUEUE: {
        send: async (body: ObservatoryQueueMessage) => {
          sent.push(body);
        },
      },
    } as unknown as Env;
    const observedAt="2026-08-25T01:00:00.000Z";const sourceRef="https://link-worker.example/.well-known/api-catalog";const snapshotId="api-catalog-link-worker-snapshot";
    await startSourceSnapshot(env.DB,{id:snapshotId,serviceId,sourceType:"api-catalog",sourceRef,observedAt,expectedItems:2});
    const links: ApiCatalogLinkMessage[] = [
      { type: "api-catalog-link", serviceId, url: "https://link-worker.example/one.json?token=discarded",sourceRef,observedAt,snapshotId,itemId:`${snapshotId}:0` },
      { type: "api-catalog-link", serviceId, url: "https://link-worker.example/two.json",sourceRef,observedAt,snapshotId,itemId:`${snapshotId}:1` },
    ];

    for (const link of links) {
      await processApiCatalogLink(fakeEnv, link);
      await processApiCatalogLink(fakeEnv, link);
    }

    expect(sent).toHaveLength(2);
    expect(sent).toEqual([
      {
        type: "due-target",
        serviceId,
        url: "https://link-worker.example/one.json",
        kind: "openapi",
        endpointId:undefined,
      },
      {
        type: "due-target",
        serviceId,
        url: "https://link-worker.example/two.json",
        kind: "openapi",
        endpointId:undefined,
      },
    ]);
    const targets = await env.DB.prepare(
      "SELECT normalized_url,target_kind,source_kind,status FROM crawl_targets ORDER BY normalized_url",
    ).all<{ normalized_url: string; target_kind: string; source_kind: string; status: string }>();
    expect(targets.results).toEqual([
      {
        normalized_url: "https://link-worker.example/one.json",
        target_kind: "openapi",
        source_kind: "openapi",
        status: "due-queued",
      },
      {
        normalized_url: "https://link-worker.example/two.json",
        target_kind: "openapi",
        source_kind: "openapi",
        status: "due-queued",
      },
    ]);
  });
});

describe("fan-out message runtime validation", () => {
  it("acks malformed link and due-target messages without retries or processor side effects", async () => {
    const targetsBefore = Number(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM crawl_targets").first<{ count: number }>())?.count ?? 0,
    );
    const malformed: unknown[] = [
      { type: "api-catalog-link" },
      { type: "api-catalog-link", url: 42, serviceId: "service" },
      { type: "api-catalog-link", url: "https://specs.example/openapi.json" },
      { type: "api-catalog-link", url: "x".repeat(2_049), serviceId: "service" },
      { type: "api-catalog-link", url: "https://specs.example/openapi.json", serviceId: "x".repeat(121) },
      { type: "due-target" },
      { type: "due-target", url: 42, kind: "endpoint" },
      { type: "due-target", url: "https://due.example/", kind: "invalid" },
      { type: "due-target", url: "https://due.example/", kind: "endpoint", endpointId: "x".repeat(121) },
    ];
    const messages = malformed.map((body, index) => ({
      id: `bad-api-catalog-link-${index}`,
      timestamp: new Date("2026-08-25T00:00:00.000Z"),
      attempts: 1,
      body,
    }));
    const batch = createMessageBatch<unknown>("mpp-crawl", messages);
    const context = createExecutionContext();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await (
        worker.queue as unknown as (
          value: MessageBatch<unknown>,
          bindings: Env,
          ctx: ExecutionContext,
        ) => Promise<void>
      )(batch, env, context);
      const result = await getQueueResult(batch, context);
      expect(result.retryMessages).toEqual([]);
      expect(result.retryBatch.retry).toBe(false);
      expect(result.explicitAcks.sort()).toEqual(messages.map((message) => message.id).sort());
      expect(
        (await env.DB.prepare("SELECT COUNT(*) AS count FROM crawl_targets").first<{ count: number }>())?.count,
      ).toBe(targetsBefore);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe("Cron due-target fan-out", () => {
  it("uses one bounded SELECT to emit up to 100 one-unit due-target messages", async () => {
    const dueRows = Array.from({ length: 100 }, (_, index) => ({
      normalized_url: `https://due.example/target-${String(index).padStart(3, "0")}`,
      service_id: index % 2 === 0 ? `service-${index}` : null,
      endpoint_id: index % 3 === 0 ? `endpoint-${index}` : null,
      target_kind: (["endpoint", "openapi", "api-catalog", "homepage"] as const)[index % 4],
    }));
    const preparedSql: string[] = [];
    let allCalls = 0;
    const statement = {
      bind: () => statement,
      all: async () => {
        allCalls += 1;
        return { results: dueRows };
      },
    };
    const sentBatches: Array<Array<{ body: DueTargetMessage }>> = [];
    const fakeEnv = {
      DB: {
        prepare: (sql: string) => {
          preparedSql.push(sql);
          return statement;
        },
      },
      CRAWL_QUEUE: {
        sendBatch: async (batch: Array<{ body: DueTargetMessage }>) => {
          sentBatches.push(batch);
        },
      },
    } as unknown as Env;

    await expect(enqueueDueTargets(fakeEnv, 100)).resolves.toBe(100);

    expect(preparedSql).toHaveLength(1);
    expect(preparedSql[0]).toMatch(/^SELECT normalized_url,service_id,endpoint_id,target_kind FROM crawl_targets/);
    expect(allCalls).toBe(1);
    const messages = sentBatches.flatMap((batch) => batch.map((item) => item.body));
    expect(messages).toHaveLength(100);
    expect(sentBatches.every((batch) => batch.length <= 100)).toBe(true);
    expect(messages.every((message) => message.type === "due-target")).toBe(true);
    expect(messages[0]).toEqual({
      type: "due-target",
      url: "https://due.example/target-000",
      serviceId: "service-0",
      endpointId: "endpoint-0",
      kind: "endpoint",
    });
    expect(messages[1]).toEqual({
      type: "due-target",
      url: "https://due.example/target-001",
      serviceId: undefined,
      endpointId: undefined,
      kind: "openapi",
    });
  });

  it("turns one due-target message into exactly one deduplicated scheduled probe", async () => {
    const serviceId="due-worker-service";
    await insertService(serviceId,"https://due-worker.example/");
    const sent: ObservatoryQueueMessage[] = [];
    const fakeEnv = {
      DB: env.DB,
      CRAWL_QUEUE: {
        send: async (body: ObservatoryQueueMessage) => {
          sent.push(body);
        },
      },
    } as unknown as Env;
    const message: DueTargetMessage = {
      type: "due-target",
      url: "https://due-worker.example/openapi.json?credential=discarded",
      serviceId,
      kind: "openapi",
    };

    await enqueueTarget(fakeEnv,{type:"probe",url:message.url,serviceId,kind:"openapi",source:"catalog"},0,false,{sourceType:"catalog",sourceRef:"https://mpp.dev/api/services",observedAt:"2026-08-25T01:00:00.000Z"});
    sent.length=0;
    await env.DB.prepare("UPDATE crawl_targets SET status='complete',next_due_at='2000-01-01T00:00:00.000Z' WHERE service_id=? AND target_kind='openapi'").bind(serviceId).run();

    await processDueTarget(fakeEnv, message);
    await processDueTarget(fakeEnv, message);

    expect(sent).toEqual([
      {
        type: "probe",
        url: "https://due-worker.example/openapi.json",
        serviceId,
        endpointId: undefined,
        kind: "openapi",
        source: "scheduled",
        runId: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    const targets = await env.DB.prepare(
      "SELECT normalized_url,target_kind,source_kind,status FROM crawl_targets WHERE normalized_url=?",
    )
      .bind("https://due-worker.example/openapi.json")
      .all<{ normalized_url: string; target_kind: string; source_kind: string; status: string }>();
    expect(targets.results).toEqual([
      {
        normalized_url: "https://due-worker.example/openapi.json",
        target_kind: "openapi",
        source_kind: "catalog",
        status: "queued",
      },
    ]);
  });
});
