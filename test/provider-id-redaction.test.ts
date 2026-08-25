import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enqueueTarget } from "../src/catalog";
import { processCrawlMessage } from "../src/crawler";
import type { CrawlMessage } from "../src/model";
import { redactJsonValue, redactText } from "../src/security";
import providerIdentifierBackfill from "../migrations/0002_redact_provider_identifiers.sql?raw";

afterEach(() => {
  vi.unstubAllGlobals();
});

function base64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

describe("provider transaction identifier redaction", () => {
  it("removes opaque identifiers while preserving observable numeric economics", () => {
    const redacted = redactJsonValue({
      amount: "2",
      chainId: 4217,
      suggestedDeposit: "100",
      authorizationWindow: 40,
      sessionDurationSeconds: 60,
      depositWindowRatio: 2.5,
      extra: {
        stripe_mode: "custody",
        stripe_payment_intent_id: "pi_must_not_survive",
        provider_transaction_id: "provider_tx_must_not_survive",
        processorReference: "processor_ref_must_not_survive",
        customerId: "customer_must_not_survive",
      },
    });

    expect(redacted).toEqual({
      amount: "2",
      chainId: 4217,
      suggestedDeposit: "100",
      authorizationWindow: 40,
      sessionDurationSeconds: 60,
      depositWindowRatio: 2.5,
      extra: {
        stripe_mode: "custody",
        "[redacted-sensitive-key-0]": "[redacted]",
        "[redacted-sensitive-key-1]": "[redacted]",
        "[redacted-sensitive-key-2]": "[redacted]",
        "[redacted-sensitive-key-3]": "[redacted]",
      },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toMatch(/pi_must_not_survive|provider_tx_must_not_survive|processor_ref_must_not_survive|customer_must_not_survive/);
    expect(
      redactText('{"stripe_payment_intent_id":"pi_text_must_not_survive","provider_transaction_id":"tx_text_must_not_survive"}'),
    ).not.toMatch(/pi_text_must_not_survive|tx_text_must_not_survive/);
  });

  it("redacts a live-shaped 402 before R2 and D1 persistence and API exposure", async () => {
    const serviceId = "provider-redaction-ingest";
    const targetUrl = "https://1.0.0.31/provider-redaction";
    const observedAt = "2026-08-25T00:00:00.000Z";
    const stripeId = "pi_ingest_must_not_survive";
    const providerId = "provider_tx_ingest_must_not_survive";
    await env.DB.prepare(
      "INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES (?,?,?,?,?,?)",
    ).bind(serviceId, serviceId, targetUrl, "https://1.0.0.31", observedAt, observedAt).run();

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
      { type: "probe", url: targetUrl, serviceId, kind: "endpoint", source: "mppscan" },
      0,
      false,
      { sourceType: "mppscan", sourceRef: "https://mppscan.com/", observedAt },
    );

    const request = base64UrlJson({
      amount: "2",
      currency: "USDC",
      suggestedDeposit: "100",
      authorizationWindow: "40",
      maxUnits: "10",
      sessionDurationSeconds: 60,
      provider_transaction_id: providerId,
      extra: {
        stripe_mode: "custody",
        stripe_payment_intent_id: stripeId,
      },
      methodDetails: { chainId: 4217, decimals: 6 },
    });
    vi.stubGlobal("fetch", async () => new Response("payment required", {
      status: 402,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Payment id="challenge", realm="api", method="tempo", intent="session", request="${request}"`,
      },
    }));

    await processCrawlMessage(fakeEnv, queued[0]);

    const observation = await env.DB.prepare(
      "SELECT challenge_json FROM observations WHERE service_id=?",
    ).bind(serviceId).first<{ challenge_json: string }>();
    const offer = await env.DB.prepare(
      "SELECT amount,currency,chain_id,decimals,session_json FROM payment_offers WHERE endpoint_id IN (SELECT id FROM endpoints WHERE service_id=?)",
    ).bind(serviceId).first<{ amount: string; currency: string; chain_id: string; decimals: number; session_json: string }>();
    expect(r2Writes).toHaveLength(1);
    const persisted = JSON.stringify([r2Writes[0], observation, offer]);
    expect(persisted).not.toMatch(new RegExp(`${stripeId}|${providerId}`));
    expect(persisted).not.toMatch(/stripe_payment_intent_id|provider_transaction_id/);
    expect(offer).toMatchObject({ amount: "2", currency: "USDC", chain_id: "4217", decimals: 6 });
    expect(JSON.parse(offer?.session_json ?? "{}" as string)).toMatchObject({
      suggestedDeposit: "100",
      authorizationWindow: "40",
      maxUnits: "10",
      sessionDurationSeconds: 60,
    });
    expect(JSON.parse(observation?.challenge_json ?? "[]" as string)[0].request).toMatchObject({
      suggestedDeposit: "100",
      authorizationWindow: "40",
      maxUnits: "10",
      sessionDurationSeconds: 60,
    });

    const response = await SELF.fetch(`https://mpp.ninja/api/services/${serviceId}`);
    expect(response.status).toBe(200);
    const apiText = await response.text();
    expect(apiText).not.toMatch(new RegExp(`${stripeId}|${providerId}`));
    expect(apiText).not.toMatch(/stripe_payment_intent_id|provider_transaction_id/);
    const api = JSON.parse(apiText) as { endpoints: Array<{ offers: Array<{ session: Record<string, unknown> }> }> };
    expect(api.endpoints[0].offers[0].session).toMatchObject({
      suggestedDeposit: "100",
      authorizationWindow: "40",
      maxUnits: "10",
      sessionDurationSeconds: 60,
    });
  });

  it("redacts legacy D1 values at JSON and rendered output boundaries", async () => {
    const serviceId = "provider-redaction-legacy";
    const endpointId = `${serviceId}-endpoint`;
    const targetUrl = "https://legacy-provider-redaction.example/paid";
    const observedAt = "2026-08-25T00:00:00.000Z";
    const stripeId = "pi_legacy_must_not_be_exposed";
    const providerId = "provider_tx_legacy_must_not_be_exposed";
    const session = JSON.stringify({
      stripe_payment_intent_id: stripeId,
      provider_transaction_id: providerId,
      suggestedDeposit: "100",
      authorizationWindow: 40,
      sessionDurationSeconds: 60,
    });
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES (?,?,?,?,?,?)",
      ).bind(serviceId, serviceId, targetUrl, "https://legacy-provider-redaction.example", observedAt, observedAt),
      env.DB.prepare(
        "INSERT INTO endpoints (id,service_id,url,http_method,path,first_seen,last_seen) VALUES (?,?,?,?,?,?,?)",
      ).bind(endpointId, serviceId, targetUrl, "GET", "/paid", observedAt, observedAt),
      env.DB.prepare(
        "INSERT INTO endpoint_sources (endpoint_id,source_type,source_ref,first_seen,last_seen,observed_at,active) VALUES (?,'challenge',?,?,?,?,1)",
      ).bind(endpointId, targetUrl, observedAt, observedAt, observedAt),
      env.DB.prepare(
        "INSERT INTO payment_offers (id,endpoint_id,method,intent,currency,amount,session_json,source_type,source_ref,source_ordinal,active,first_seen,last_seen,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)",
      ).bind(`${serviceId}-offer`, endpointId, "tempo", "session", "USDC", "2", session, "challenge", targetUrl, 0, observedAt, observedAt, observedAt),
      env.DB.prepare(
        "INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence) VALUES (?,?,?,?,?,?,?,?,?)",
      ).bind(
        `${serviceId}-explicit-change`,
        serviceId,
        endpointId,
        observedAt,
        "provider-redaction-regression",
        "session_json",
        null,
        session,
        "explicit legacy provider identifier fixture",
      ),
    ]);

    const urls = [
      `https://mpp.ninja/api/services/${serviceId}`,
      `https://mpp.ninja/api/endpoints?service=${serviceId}`,
      `https://mpp.ninja/api/changes?service=${serviceId}`,
      `https://mpp.ninja/services/${serviceId}`,
      `https://mpp.ninja/changes?service=${serviceId}`,
    ];
    for (const url of urls) {
      const response = await SELF.fetch(url);
      expect(response.status, url).toBe(200);
      const body = await response.text();
      expect(body, url).not.toMatch(new RegExp(`${stripeId}|${providerId}`));
    }

    const detail = await SELF.fetch(`https://mpp.ninja/api/services/${serviceId}`).then((response) => response.json()) as {
      endpoints: Array<{ offers: Array<{ session: Record<string, unknown> }> }>;
    };
    expect(detail.endpoints[0].offers[0].session).toMatchObject({
      suggestedDeposit: "100",
      authorizationWindow: 40,
      sessionDurationSeconds: 60,
    });
    const changesResponse = await SELF.fetch(`https://mpp.ninja/api/changes?service=${serviceId}`);
    const changesText = await changesResponse.text();
    expect(changesText).toContain("provider-redaction-regression");
    expect(changesText).not.toMatch(new RegExp(`${stripeId}|${providerId}`));
    const changesPage = await SELF.fetch(`https://mpp.ninja/changes?service=${serviceId}`).then((response) => response.text());
    expect(changesPage).toContain("provider-redaction-regression");
    expect(changesPage).not.toMatch(new RegExp(`${stripeId}|${providerId}`));
  });

  it("backfills the known legacy Stripe identifier with the actual 0002 migration", async () => {
    const serviceId = "provider-redaction-backfill";
    const endpointId = `${serviceId}-endpoint`;
    const snapshotId = `${serviceId}-snapshot`;
    const observedAt = "2026-08-25T00:00:00.000Z";
    const stripeId = "pi_backfill_must_not_survive";
    const session = JSON.stringify({
      extra: { stripe_payment_intent_id: stripeId, stripe_mode: "custody" },
      suggestedDeposit: "100",
      authorizationWindow: 40,
      sessionDurationSeconds: 60,
    });
    const challenge = JSON.stringify([{
      method: "tempo",
      request: {
        extra: { stripe_payment_intent_id: stripeId, stripe_mode: "custody" },
        suggestedDeposit: "100",
        authorizationWindow: 40,
        sessionDurationSeconds: 60,
      },
    }]);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES (?,?,?,?,?,?)",
      ).bind(serviceId, serviceId, "https://provider-redaction-backfill.example/", "https://provider-redaction-backfill.example", observedAt, observedAt),
      env.DB.prepare(
        "INSERT INTO endpoints (id,service_id,url,http_method,path,first_seen,last_seen) VALUES (?,?,?,?,?,?,?)",
      ).bind(endpointId, serviceId, "https://provider-redaction-backfill.example/paid", "GET", "/paid", observedAt, observedAt),
      env.DB.prepare(
        "INSERT INTO observations (id,service_id,endpoint_id,observed_at,request_method,requested_url,status,headers_json,challenge_json) VALUES (?,?,?,?,?,?,402,'{}',?)",
      ).bind(`${serviceId}-observation`, serviceId, endpointId, observedAt, "GET", "https://provider-redaction-backfill.example/paid", challenge),
      env.DB.prepare(
        "INSERT INTO payment_offers (id,endpoint_id,method,intent,session_json,source_type,source_ref,source_ordinal,active,first_seen,last_seen,observed_at) VALUES (?,?,?,?,?,'challenge',?,0,1,?,?,?)",
      ).bind(`${serviceId}-offer`, endpointId, "tempo", "session", session, "https://provider-redaction-backfill.example/paid", observedAt, observedAt, observedAt),
      env.DB.prepare(
        "INSERT INTO source_snapshots (id,service_id,source_type,source_ref,observed_at,expected_items,status) VALUES (?,?,'openapi',?,?,1,'running')",
      ).bind(snapshotId, serviceId, "https://provider-redaction-backfill.example/openapi.json", observedAt),
      env.DB.prepare(
        "INSERT INTO source_snapshot_offer_stage (snapshot_id,offer_id,endpoint_id,service_id,method,intent,session_json,source_type,source_ref,source_ordinal,first_seen,last_seen) VALUES (?,?,?,?,?,? ,?,'openapi',?,0,?,?)",
      ).bind(snapshotId, `${serviceId}-staged-offer`, endpointId, serviceId, "tempo", "session", session, "https://provider-redaction-backfill.example/openapi.json", observedAt, observedAt),
      env.DB.prepare(
        "INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,new_value,evidence) VALUES (?,?,?,?,?,?,?,?)",
      ).bind(`${serviceId}-change`, serviceId, endpointId, observedAt, "provider-redaction-backfill", "session_json", session, "legacy provider identifier fixture"),
    ]);

    const backfillStatements = providerIdentifierBackfill
      .replace(/^--.*$/gm, "")
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => env.DB.prepare(statement));
    await env.DB.batch(backfillStatements);

    const rows = await Promise.all([
      env.DB.prepare("SELECT challenge_json AS value FROM observations WHERE id=?").bind(`${serviceId}-observation`).first<{ value: string }>(),
      env.DB.prepare("SELECT session_json AS value FROM payment_offers WHERE id=?").bind(`${serviceId}-offer`).first<{ value: string }>(),
      env.DB.prepare("SELECT session_json AS value FROM source_snapshot_offer_stage WHERE offer_id=?").bind(`${serviceId}-staged-offer`).first<{ value: string }>(),
      env.DB.prepare("SELECT new_value AS value FROM changes WHERE id=?").bind(`${serviceId}-change`).first<{ value: string }>(),
    ]);
    const backfilled = JSON.stringify(rows);
    expect(backfilled).not.toContain(stripeId);
    expect(backfilled).not.toContain("stripe_payment_intent_id");
    expect(backfilled).toContain("suggestedDeposit");
    expect(backfilled).toContain("authorizationWindow");
    expect(backfilled).toContain("sessionDurationSeconds");
  });
});
