import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { enqueueTarget } from "../src/catalog";
import { upsertOpenApiOperation } from "../src/db";
import {
  importMppScan,
  MPPSCAN_HOMEPAGE_URL,
  processMppScanCandidate,
} from "../src/mppscan";
import type { CrawlMessage, ObservatoryQueueMessage, UrlDiscoveryMessage } from "../src/model";

interface CapturedQueue {
  discoveries: UrlDiscoveryMessage[];
  probes: CrawlMessage[];
}

function mppScanEnv(): { bindings: Env; captured: CapturedQueue } {
  const captured: CapturedQueue = { discoveries: [], probes: [] };
  const bindings = {
    DB: env.DB,
    CRAWL_QUEUE: {
      send: async (body: ObservatoryQueueMessage) => {
        if (body.type === undefined || body.type === "probe") captured.probes.push(body);
      },
      sendBatch: async (batch: Array<{ body: ObservatoryQueueMessage }>) => {
        for (const { body } of batch) {
          if (body.type === "url-discovery") captured.discoveries.push(body);
        }
      },
    },
  } as unknown as Env;
  return { bindings, captured };
}

function homepage(originUrls: readonly string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const requested = input instanceof Request ? input.url : input.toString();
    if (requested !== MPPSCAN_HOMEPAGE_URL) throw new Error(`unexpected fetch: ${requested}`);
    return new Response(`<script type="application/json">${JSON.stringify({ originUrls })}</script>`, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }) as typeof fetch;
}

async function importRun(
  bindings: Env,
  captured: CapturedQueue,
  origins: readonly string[],
  observedAt: string,
): Promise<UrlDiscoveryMessage[]> {
  captured.discoveries.length = 0;
  await importMppScan(bindings, homepage(origins), observedAt);
  return [...captured.discoveries];
}

async function processAll(bindings: Env, messages: readonly UrlDiscoveryMessage[]): Promise<void> {
  for (const message of messages) await processMppScanCandidate(bindings, message);
}

async function serviceId(url: string): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM services WHERE service_url=?")
    .bind(url)
    .first<{ id: string }>();
  if (!row) throw new Error(`missing service: ${url}`);
  return row.id;
}

async function mppScanTargetState(id: string): Promise<{ active: number; retired: number; total: number }> {
  const row = await env.DB.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN source.active=1 THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN target.status='retired' THEN 1 ELSE 0 END) AS retired
    FROM crawl_targets target
    JOIN crawl_target_sources source ON source.target_id=target.id
    WHERE target.service_id=? AND source.source_type='mppscan' AND source.source_ref=?`)
    .bind(id, MPPSCAN_HOMEPAGE_URL)
    .first<{ active: number; retired: number; total: number }>();
  return {
    active: Number(row?.active ?? 0),
    retired: Number(row?.retired ?? 0),
    total: Number(row?.total ?? 0),
  };
}

describe("MPPScan complete-run membership authority", () => {
  it("waits for every candidate before withdrawing an omitted origin", async () => {
    const { bindings, captured } = mppScanEnv();
    const keptUrl = "https://mppscan-kept.example/";
    const omittedUrl = "https://mppscan-omitted.example/";
    const first = await importRun(bindings, captured, [keptUrl, omittedUrl], "2026-08-25T01:00:00.000Z");
    expect(first).toHaveLength(2);
    expect(
      await env.DB.prepare("SELECT status,expected_services FROM discovery_runs WHERE id=?")
        .bind(first[0].discoveryRunId)
        .first(),
    ).toEqual({ status: "processing", expected_services: 2 });

    await processMppScanCandidate(bindings, first[0]);
    expect(
      (await env.DB.prepare("SELECT status FROM discovery_runs WHERE id=?")
        .bind(first[0].discoveryRunId)
        .first<{ status: string }>())?.status,
    ).toBe("processing");
    await processMppScanCandidate(bindings, first[1]);

    const omittedId = await serviceId(omittedUrl);
    expect(await mppScanTargetState(omittedId)).toEqual({ active: 3, retired: 0, total: 3 });

    const replacement = await importRun(bindings, captured, [keptUrl], "2026-08-25T02:00:00.000Z");
    expect(await mppScanTargetState(omittedId)).toEqual({ active: 3, retired: 0, total: 3 });
    expect(
      (await env.DB.prepare("SELECT status FROM discovery_runs WHERE id=?")
        .bind(replacement[0].discoveryRunId)
        .first<{ status: string }>())?.status,
    ).toBe("processing");

    await processAll(bindings, replacement);
    expect(await mppScanTargetState(omittedId)).toEqual({ active: 0, retired: 3, total: 3 });
    expect(
      (await env.DB.prepare("SELECT status FROM discovery_runs WHERE id=?")
        .bind(replacement[0].discoveryRunId)
        .first<{ status: string }>())?.status,
    ).toBe("complete");
  });

  it("keeps last-known membership when HTTP or hydration parsing fails", async () => {
    const { bindings, captured } = mppScanEnv();
    const retainedUrl = "https://mppscan-retained.example/";
    const baseline = await importRun(bindings, captured, [retainedUrl], "2026-08-25T03:00:00.000Z");
    await processAll(bindings, baseline);
    const retainedId = await serviceId(retainedUrl);

    const unavailable = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    await expect(importMppScan(bindings, unavailable, "2026-08-25T04:00:00.000Z")).rejects.toThrow(
      "MPPScan homepage returned 503",
    );
    const malformed = (async () => new Response("<a href='https://not-authority.example/'>link</a>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })) as typeof fetch;
    await expect(importMppScan(bindings, malformed, "2026-08-25T05:00:00.000Z")).rejects.toThrow(
      "no valid origin list",
    );

    expect(await mppScanTargetState(retainedId)).toEqual({ active: 3, retired: 0, total: 3 });
    const failed = await env.DB.prepare("SELECT started_at,status FROM discovery_runs WHERE source_kind='mppscan-html' AND status='failed' ORDER BY started_at")
      .all<{ started_at: string; status: string }>();
    expect(failed.results).toEqual([
      { started_at: "2026-08-25T04:00:00.000Z", status: "failed" },
      { started_at: "2026-08-25T05:00:00.000Z", status: "failed" },
    ]);
  });

  it("prevents a delayed older run from reactivating authority or withdrawing a newer member", async () => {
    const { bindings, captured } = mppScanEnv();
    const olderUrl = "https://mppscan-delayed-older.example/";
    const newerUrl = "https://mppscan-newer.example/";
    const older = await importRun(bindings, captured, [olderUrl], "2026-08-25T06:00:00.000Z");
    const newer = await importRun(bindings, captured, [newerUrl], "2026-08-25T07:00:00.000Z");

    await processAll(bindings, newer);
    const newerId = await serviceId(newerUrl);
    expect(await mppScanTargetState(newerId)).toEqual({ active: 3, retired: 0, total: 3 });

    await processAll(bindings, older);
    const olderId = await serviceId(olderUrl);
    expect(await mppScanTargetState(olderId)).toEqual({ active: 0, retired: 3, total: 3 });
    expect(await mppScanTargetState(newerId)).toEqual({ active: 3, retired: 0, total: 3 });
    expect(
      await env.DB.prepare("SELECT status FROM discovery_runs WHERE id IN (?,?) ORDER BY started_at")
        .bind(older[0].discoveryRunId, newer[0].discoveryRunId)
        .all(),
    ).toMatchObject({ results: [{ status: "complete" }, { status: "complete" }] });
  });

  it("retires OpenAPI data and child probes derived solely from an omitted MPPScan origin", async () => {
    const { bindings, captured } = mppScanEnv();
    const omittedUrl = "https://mppscan-tree-omitted.example/";
    const baseline = await importRun(bindings, captured, [omittedUrl], "2026-08-25T08:00:00.000Z");
    await processAll(bindings, baseline);
    const omittedId = await serviceId(omittedUrl);
    const openApiUrl = `${omittedUrl}openapi.json`;
    await enqueueTarget(
      bindings,
      { type: "probe", url: `${omittedUrl}paid`, serviceId: omittedId, kind: "endpoint", source: "openapi" },
      0,
      false,
      { sourceType: "openapi", sourceRef: openApiUrl, observedAt: "2026-08-25T08:00:00.000Z" },
    );
    await upsertOpenApiOperation(
      env.DB,
      omittedId,
      omittedUrl,
      {
        method: "GET",
        path: "/paid",
        description: "advertised operation",
        offers: [{ method: "tempo", intent: "charge", currency: "USDC", amount: "1" }],
      },
      "2026-08-25T08:00:00.000Z",
      openApiUrl,
    );

    const replacement = await importRun(
      bindings,
      captured,
      ["https://mppscan-tree-replacement.example/"],
      "2026-08-25T09:00:00.000Z",
    );
    await processAll(bindings, replacement);

    expect(
      await env.DB.prepare("SELECT active FROM crawl_target_sources WHERE source_type='openapi' AND source_ref=?")
        .bind(openApiUrl)
        .first(),
    ).toEqual({ active: 0 });
    expect(
      await env.DB.prepare("SELECT active FROM endpoint_sources WHERE source_type='openapi' AND source_ref=?")
        .bind(openApiUrl)
        .first(),
    ).toEqual({ active: 0 });
    expect(
      await env.DB.prepare("SELECT active FROM payment_offers WHERE source_type='openapi' AND source_ref=?")
        .bind(openApiUrl)
        .first(),
    ).toEqual({ active: 0 });
  });
});
