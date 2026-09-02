import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { crawlTargetId, enqueueTarget } from "../src/catalog";
import { processCrawlMessage } from "../src/crawler";
import type { CrawlMessage } from "../src/model";
import { sha256 } from "../src/security";

afterEach(() => {
  vi.unstubAllGlobals();
});

function base64Url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

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

async function insertCandidateService(id: string, url: string): Promise<void> {
  const parsed = new URL(url);
  await env.DB.prepare(
    "INSERT INTO services (id,name,service_url,origin,status,first_seen,last_seen) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      id,
      url,
      parsed.origin,
      "candidate",
      "2026-08-25T00:00:00.000Z",
      "2026-08-25T00:00:00.000Z",
    )
    .run();
}

describe("authoritative runtime observation clocks", () => {
  it("does not let an older completion regress endpoint, service, security, fingerprint, or challenge state", async () => {
    const serviceId = "runtime-clock-authority";
    const url = "https://1.0.0.4/runtime-clock-authority";
    await insertCandidateService(serviceId, url);
    const queued: CrawlMessage[] = [];
    const bindings = {
      DB: env.DB,
      CRAWL_QUEUE: { send: async (body: CrawlMessage) => queued.push(body) },
      OBSERVATIONS: memoryR2(),
    } as unknown as Env;
    const target: CrawlMessage = {
      type: "probe",
      url,
      serviceId,
      kind: "endpoint",
      source: "manual",
    };
    await enqueueTarget(bindings, target, 0, false, {
      sourceType: "manual",
      sourceRef: "https://mpp.ninja/submit",
      observedAt: "2026-08-25T01:00:00.000Z",
    });
    const targetId = await crawlTargetId(target, url);
    await env.DB.prepare("UPDATE crawl_targets SET run_observed_at=? WHERE id=?")
      .bind("2026-08-25T03:00:00.000Z", targetId)
      .run();

    const request = base64Url({
      amount: "3",
      currency: "USDC",
      recipient: "0xnew",
      methodDetails: { chainId: 42431, decimals: 6 },
    });
    const opaque = base64Url({ _mppx_scope: "newer-scope" });
    let responseVersion: "newer" | "older" = "newer";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const requested = input instanceof Request ? input.url : input.toString();
      if (requested !== url) throw new Error(`unexpected fetch: ${requested}`);
      if (responseVersion === "newer") {
        return new Response("newer challenge", {
          status: 402,
          headers: {
            "Content-Type": "application/newer",
            "WWW-Authenticate": `Payment id="newer", realm="api", method="tempo", intent="charge", request="${request}", opaque="${opaque}"`,
          },
        });
      }
      return new Response("older public response", {
        status: 200,
        headers: { "Content-Type": "application/older", Server: "mpp-rs/0.1" },
      });
    });

    await processCrawlMessage(bindings, queued[0]);
    const olderRunId = await sha256("runtime-clock-authority|older-run");
    await env.DB.prepare(
      "UPDATE crawl_targets SET status='queued',generation=generation+1,run_id=?,run_observed_at=?,processing_token=NULL,processing_expires_at=NULL WHERE id=?",
    )
      .bind(olderRunId, "2026-08-25T02:00:00.000Z", targetId)
      .run();
    await env.DB.prepare("DELETE FROM origin_rate_limits WHERE origin=?").bind(new URL(url).origin).run();
    responseVersion = "older";
    await processCrawlMessage(bindings, { ...queued[0], runId: olderRunId });

    const endpoint = await env.DB.prepare(
      "SELECT id,last_probe_at,last_seen,last_status,content_type,tls_state,challenge_format FROM endpoints WHERE service_id=?",
    )
      .bind(serviceId)
      .first<Record<string, unknown>>();
    expect(endpoint).toMatchObject({
      last_probe_at: "2026-08-25T03:00:00.000Z",
      last_seen: "2026-08-25T03:00:00.000Z",
      last_status: 402,
      content_type: "application/newer",
      tls_state: "tested-pass",
      challenge_format: "mpp-payment-auth",
    });
    expect(
      await env.DB.prepare(
        "SELECT status,last_probe_at,implementation,implementation_confidence,fingerprint_observed_at FROM services WHERE id=?",
      )
        .bind(serviceId)
        .first(),
    ).toEqual({
      status: "observed-mpp",
      last_probe_at: "2026-08-25T03:00:00.000Z",
      implementation: "mppx",
      implementation_confidence: 0.85,
      fingerprint_observed_at: "2026-08-25T03:00:00.000Z",
    });
    expect(
      await env.DB.prepare(
        "SELECT state,evidence,observed_at FROM security_properties WHERE service_id=? AND endpoint_id=? AND property_key='challenge_parse'",
      )
        .bind(serviceId, endpoint?.id)
        .first(),
    ).toEqual({
      state: "tested-pass",
      evidence:
        "1 Payment challenge(s) observed on HTTP 402; all required fields decoded and validated",
      observed_at: "2026-08-25T03:00:00.000Z",
    });
    expect(
      await env.DB.prepare(
        "SELECT active,last_seen,observed_at FROM endpoint_sources WHERE endpoint_id=? AND source_type='challenge'",
      )
        .bind(endpoint?.id)
        .first(),
    ).toEqual({
      active: 1,
      last_seen: "2026-08-25T03:00:00.000Z",
      observed_at: "2026-08-25T03:00:00.000Z",
    });
    expect(
      await env.DB.prepare(
        "SELECT active,amount,recipient,last_seen,observed_at FROM payment_offers WHERE endpoint_id=? AND source_type='challenge'",
      )
        .bind(endpoint?.id)
        .first(),
    ).toEqual({
      active: 1,
      amount: "3",
      recipient: "0xnew",
      last_seen: "2026-08-25T03:00:00.000Z",
      observed_at: "2026-08-25T03:00:00.000Z",
    });
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM observations WHERE service_id=?")
        .bind(serviceId)
        .first<{ count: number }>())?.count,
    ).toBe(2);
  });
});

describe("retired target rediscovery", () => {
  it("allocates a fresh generation and run after a rejected manual target is retired and rediscovered", async () => {
    const serviceId = "rejected-rediscovery";
    const url = "https://8.8.4.4/rejected-rediscovery";
    await insertCandidateService(serviceId, url);
    const queued: CrawlMessage[] = [];
    const bindings = {
      DB: env.DB,
      CRAWL_QUEUE: { send: async (body: CrawlMessage) => queued.push(body) },
      OBSERVATIONS: memoryR2(),
    } as unknown as Env;
    const target: CrawlMessage = {
      type: "probe",
      url,
      serviceId,
      kind: "endpoint",
      source: "manual",
    };
    const provenance = {
      sourceType: "manual" as const,
      sourceRef: "https://mpp.ninja/submit",
      observedAt: "2026-08-25T01:00:00.000Z",
    };
    await enqueueTarget(bindings, target, 0, false, provenance);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const requested = input instanceof Request ? input.url : input.toString();
      if (requested !== url) throw new Error(`unexpected fetch: ${requested}`);
      return new Response(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/latest/meta-data" },
      });
    });

    await expect(processCrawlMessage(bindings, queued[0])).rejects.toMatchObject({ code: "private-ip" });
    const rejected = await env.DB.prepare(
      "SELECT id,status,generation,run_id,run_observed_at,last_error FROM crawl_targets WHERE service_id=?",
    )
      .bind(serviceId)
      .first<{
        id: string;
        status: string;
        generation: number;
        run_id: string;
        run_observed_at: string;
        last_error: string;
      }>();
    expect(rejected).toMatchObject({ status: "retired", generation: 1, last_error:"source-withdrawn" });

    await enqueueTarget(bindings, target, 0, false, {
      ...provenance,
      observedAt: "2099-08-25T02:00:00.000Z",
    });

    expect(queued).toHaveLength(2);
    expect(queued[1].runId).toMatch(/^[a-f0-9]{64}$/);
    expect(queued[1].runId).not.toBe(rejected?.run_id);
    expect(
      await env.DB.prepare(
        "SELECT status,generation,run_id,run_observed_at,last_error FROM crawl_targets WHERE id=?",
      )
        .bind(rejected?.id)
        .first(),
    ).toEqual({
      status: "queued",
      generation: 2,
      run_id: queued[1].runId,
      run_observed_at: null,
      last_error: null,
    });
  });
});
