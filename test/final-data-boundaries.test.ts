import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enqueueTarget } from "../src/catalog";
import { processCrawlMessage } from "../src/crawler";
import { parsePaymentChallenges } from "../src/mpp";
import type { CrawlMessage } from "../src/model";
import { redactJsonValue } from "../src/security";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("redaction and authentication-scheme boundaries", () => {
  it("preserves benign JSON strings that merely contain security-related words", () => {
    const value = {
      description: "Token economics, password hygiene, and secret sharing are public documentation topics.",
      note: "A credential model can be discussed without assigning a credential value.",
    };

    expect(redactJsonValue(value)).toEqual(value);
  });

  it("ignores lookalike Foo-Payment authentication schemes", () => {
    const request = btoa(JSON.stringify({ amount: "1", currency: "USDC" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    expect(
      parsePaymentChallenges(
        `Foo-Payment id="lookalike", realm="api", method="tempo", intent="charge", request="${request}"`,
      ),
    ).toEqual([]);
  });
});

describe("generic discovery parse errors", () => {
  it("records a generic OpenAPI JSON parse failure without retaining the response fragment", async () => {
    const serviceId = "generic-openapi-parse-error";
    const url = "https://1.0.0.1/generic-openapi-parse-error.json";
    const responseFragment = "UNIQUE_RESPONSE_FRAGMENT_MUST_NOT_PERSIST_8f6f9b";
    await env.DB.prepare(
      "INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES (?,?,?,?,?,?)",
    )
      .bind(
        serviceId,
        serviceId,
        "https://1.0.0.1/",
        "https://1.0.0.1",
        "2026-08-25T00:00:00.000Z",
        "2026-08-25T00:00:00.000Z",
      )
      .run();
    const queued: CrawlMessage[] = [];
    const r2Writes: string[] = [];
    const fakeEnv = {
      DB: env.DB,
      CRAWL_QUEUE: { send: async (body: CrawlMessage) => queued.push(body) },
      OBSERVATIONS: {
        get: async () => null,
        put: async (_key: string, value: string) => {
          r2Writes.push(value);
        },
      },
    } as unknown as Env;
    await enqueueTarget(
      fakeEnv,
      { type: "probe", url, serviceId, kind: "openapi", source: "scheduled" },
      0,
      false,
      { sourceType: "mppscan", sourceRef: "https://mppscan.com/", observedAt: "2026-08-25T01:00:00.000Z" },
    );
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const requested = input instanceof Request ? input.url : input.toString();
      if (requested !== url) throw new Error(`unexpected fetch: ${requested}`);
      return new Response(`{"openapi":"3.1.0","paths":${responseFragment}`, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await processCrawlMessage(fakeEnv, queued[0]);

    const property = await env.DB.prepare(
      "SELECT state,evidence,basis FROM security_properties WHERE service_id=? AND property_key='openapi_parse'",
    )
      .bind(serviceId)
      .first<{ state: string; evidence: string; basis: string }>();
    expect(property).toEqual({
      state: "tested-fail",
      evidence: "OpenAPI response claimed JSON but was not valid JSON",
      basis: "harmless discovery response",
    });
    expect(JSON.stringify(property)).not.toContain(responseFragment);
    expect(r2Writes).toHaveLength(1);
    expect(r2Writes[0]).not.toContain(responseFragment);
    const observation = await env.DB.prepare(
      "SELECT headers_json,challenge_json,dns_json,tls_json FROM observations WHERE service_id=?",
    )
      .bind(serviceId)
      .first<Record<string, string>>();
    expect(JSON.stringify(observation)).not.toContain(responseFragment);
  });
});

describe("bounded service-detail API", () => {
  it("paginates endpoints and caps embedded offers while reporting full totals", async () => {
    const serviceId = "bounded-service-detail";
    const observedAt = "2026-08-25T00:00:00.000Z";
    await env.DB.prepare(
      "INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES (?,?,?,?,?,?)",
    )
      .bind(
        serviceId,
        "Bounded service detail",
        "https://bounded-service-detail.example/",
        "https://bounded-service-detail.example",
        observedAt,
        observedAt,
      )
      .run();
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 55; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const endpointId = `${serviceId}-endpoint-${suffix}`;
      statements.push(
        env.DB.prepare(
          "INSERT INTO endpoints (id,service_id,url,http_method,path,first_seen,last_seen) VALUES (?,?,?,?,?,?,?)",
        ).bind(
          endpointId,
          serviceId,
          `https://bounded-service-detail.example/paid-${suffix}`,
          "GET",
          `/paid-${suffix}`,
          observedAt,
          observedAt,
        ),
        env.DB.prepare(
          "INSERT INTO endpoint_sources (endpoint_id,source_type,source_ref,first_seen,last_seen,active) VALUES (?,?,?,?,?,1)",
        ).bind(endpointId, "openapi", "https://bounded-service-detail.example/openapi.json", observedAt, observedAt),
      );
    }
    for (let index = 0; index < 40; index += 1) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO payment_offers (id,endpoint_id,method,intent,currency,amount,source_type,source_ref,source_ordinal,active,first_seen,last_seen) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)",
        ).bind(
          `${serviceId}-offer-${String(index).padStart(3, "0")}`,
          `${serviceId}-endpoint-000`,
          `method-${String(index).padStart(3, "0")}`,
          "charge",
          "USDC",
          String(index),
          "openapi",
          "https://bounded-service-detail.example/openapi.json",
          index,
          observedAt,
          observedAt,
        ),
      );
    }
    for (let offset = 0; offset < statements.length; offset += 50) {
      await env.DB.batch(statements.slice(offset, offset + 50));
    }

    const firstResponse = await SELF.fetch(`https://mpp.ninja/api/services/${serviceId}?limit=20`);
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as {
      endpoints: Array<{ id: string; offers: unknown[]; offerPagination: { limit: number; total: number; truncated: boolean } }>;
      endpointPagination: { limit: number; total: number; nextCursor: string | null };
    };
    expect(first.endpoints).toHaveLength(20);
    expect(first.endpointPagination).toMatchObject({ limit: 20, total: 55 });
    expect(first.endpointPagination.nextCursor).toBeTypeOf("string");
    expect(first.endpoints[0].id).toBe(`${serviceId}-endpoint-000`);
    expect(first.endpoints[0].offers).toHaveLength(12);
    expect(first.endpoints[0].offerPagination).toEqual({ limit: 12, total: 40, truncated: true });

    const secondResponse = await SELF.fetch(
      `https://mpp.ninja/api/services/${serviceId}?limit=20&cursor=${encodeURIComponent(first.endpointPagination.nextCursor ?? "")}`,
    );
    const second = (await secondResponse.json()) as typeof first;
    expect(second.endpoints).toHaveLength(20);
    expect(second.endpointPagination).toMatchObject({ limit: 20, total: 55 });
    expect(second.endpoints[0].id).toBe(`${serviceId}-endpoint-020`);
    expect(new Set([...first.endpoints, ...second.endpoints].map((endpoint) => endpoint.id)).size).toBe(40);
  });
});

describe("manual submission recovery", () => {
  it("does not let a retained queued submission create a second discovery tree", async () => {
    const url = "https://1.0.0.2/queued-submission-recovery";
    await env.DB.prepare(
      "INSERT INTO submissions (normalized_url,origin,submitted_at,status,candidate_expires_at,source_note,last_error) VALUES (?,?,?,'queued',?,NULL,NULL)",
    )
      .bind(url, "https://1.0.0.2", "2026-08-25T00:00:00.000Z", "2026-08-26T00:00:00.000Z")
      .run();

    const response = await SELF.fetch("https://mpp.ninja/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "duplicate", url });
    const targets = await env.DB.prepare(
      "SELECT target_kind,status FROM crawl_targets WHERE service_id=(SELECT id FROM services WHERE service_url=?) ORDER BY target_kind",
    )
      .bind(url)
      .all<{ target_kind: string; status: string }>();
    expect(targets.results).toEqual([]);
    expect(
      await env.DB.prepare("SELECT status,last_error FROM submissions WHERE normalized_url=?").bind(url).first(),
    ).toEqual({ status: "queued", last_error: null });
  });
});
