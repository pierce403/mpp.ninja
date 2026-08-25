import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { enqueueTarget } from "../src/catalog";
import { MAX_OPENAPI_OFFERS_PER_DOCUMENT, MAX_OPENAPI_OPERATIONS_PER_DOCUMENT } from "../src/budgets";
import { upsertCatalogService, upsertDiscoveredServiceUrl, upsertOpenApiOperation } from "../src/db";
import worker from "../src/index";
import { ingestApiCatalog, ingestOpenApi, parsePaymentChallenges } from "../src/mpp";
import type { ObservatoryQueueMessage } from "../src/model";
import { ScanSafetyError, redactHeaders, redactJsonValue, redactText } from "../src/security";

async function expectRejectedOrQueryFree(
  action: () => Promise<void>,
  persistedValues: () => Promise<string[]>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ScanSafetyError);
    return;
  }
  const values = await persistedValues();
  expect(values.length).toBeGreaterThan(0);
  for (const value of values) {
    expect(new URL(value).search, value).toBe("");
    expect(value.toLowerCase(), value).not.toMatch(/token|secret|api[_-]?key|password/);
  }
}

describe("advertised URL query boundaries", () => {
  it("strips or rejects query-bearing catalog service and endpoint URLs before D1 persistence", async () => {
    let serviceId = "";
    await expectRejectedOrQueryFree(
      async () => {
        const result = await upsertCatalogService(
          env.DB,
          {
            id: "query-catalog",
            name: "Query Catalog",
            serviceUrl: "https://catalog.example/base/?api_key=must-not-persist",
            url: "https://catalog.example/?token=must-not-persist",
            endpoints: [
              {
                method: "GET",
                path: "data?password=must-not-persist",
                payment: { method: "tempo", intent: "charge", amount: "1" },
              },
            ],
          },
          "https://mpp.dev/api/services",
          "2026-08-25T00:00:00.000Z",
        );
        serviceId = result.serviceId;
      },
      async () => {
        const services = await env.DB.prepare(
          "SELECT service_url,homepage_url FROM services WHERE id=?",
        ).bind(serviceId).all<{ service_url: string; homepage_url: string | null }>();
        const endpoints = await env.DB.prepare(
          "SELECT url FROM endpoints WHERE service_id=?",
        ).bind(serviceId).all<{ url: string }>();
        return [
          ...services.results.flatMap((row) => [row.service_url, ...(row.homepage_url ? [row.homepage_url] : [])]),
          ...endpoints.results.map((row) => row.url),
        ];
      },
    );
  });

  it("strips or rejects query-bearing generic discovery candidates before D1 persistence", async () => {
    await expectRejectedOrQueryFree(
      async () => {
        await upsertDiscoveredServiceUrl(
          env.DB,
          "https://candidate.example/mpp?credential=must-not-persist",
          "public-source",
          "https://source.example/catalog",
          "2026-08-25T00:00:00.000Z",
        );
      },
      async () => {
        const rows = await env.DB.prepare(
          "SELECT service_url FROM services WHERE origin='https://candidate.example'",
        ).all<{ service_url: string }>();
        return rows.results.map((row) => row.service_url);
      },
    );
  });

  it("strips or rejects query-bearing targets before crawl scheduling and queue delivery", async () => {
    const serviceId="query-free-probe";
    await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,status,first_seen,last_seen) VALUES (?,?,?,?,?,'2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z')")
      .bind(serviceId,serviceId,"https://probe.example/","https://probe.example","observed-mpp").run();
    const sent: ObservatoryQueueMessage[] = [];
    const testEnv = {
      DB: env.DB,
      CRAWL_QUEUE: {
        send: async (body: ObservatoryQueueMessage) => {
          sent.push(body);
        },
      },
    } as unknown as Env;

    await expectRejectedOrQueryFree(
      async () => {
        await enqueueTarget(
          testEnv,
          {
            type: "probe",
            url: "https://probe.example/api?authorization=must-not-probe",
            serviceId,
            kind: "endpoint",
            source: "openapi",
          },
          0,
        );
      },
      async () => {
        const rows = await env.DB.prepare(
          "SELECT normalized_url FROM crawl_targets WHERE normalized_url LIKE 'https://probe.example/%'",
        ).all<{ normalized_url: string }>();
        return [...rows.results.map((row) => row.normalized_url), ...sent.map((message) => message.url)];
      },
    );
  });

  it("strips or rejects query-bearing RFC 9727 links before returning probe candidates", () => {
    const result = ingestApiCatalog(
      {
        linkset: [
          {
            "service-desc": [
              {
                href: "https://api.example/openapi.json?api_key=must-not-probe#fragment",
                type: "application/openapi+json",
              },
            ],
          },
        ],
      },
      "https://api.example/.well-known/api-catalog",
    );
    for (const value of result) {
      expect(new URL(value).search).toBe("");
      expect(value).not.toContain("must-not-probe");
    }
  });

  it("strips or rejects query-bearing OpenAPI operation paths before endpoint persistence", async () => {
    await expectRejectedOrQueryFree(
      async () => {
        await env.DB.prepare(
          "INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES ('openapi-query','OpenAPI Query','https://openapi.example/','https://openapi.example','2026-08-25','2026-08-25')",
        ).run();
        await upsertOpenApiOperation(
          env.DB,
          "openapi-query",
          "https://openapi.example/openapi.json?source_secret=must-not-persist",
          {
            method: "GET",
            path: "/data?token=must-not-persist",
            description: "query fixture",
            offers: [{ method: "tempo", intent: "charge", amount: "1" }],
          },
          "2026-08-25T00:00:00.000Z",
        );
      },
      async () => {
        const rows = await env.DB.prepare(
          "SELECT url FROM endpoints WHERE service_id='openapi-query'",
        ).all<{ url: string }>();
        return rows.results.map((row) => row.url);
      },
    );
  });

  it("rejects credential-shaped OpenAPI path segments before endpoint persistence",async()=>{
    await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES ('openapi-credential-path','Credential Path','https://credential-path.example/','https://credential-path.example','2026-08-25','2026-08-25')").run();
    const secret="a".repeat(48);
    await expect(upsertOpenApiOperation(env.DB,"openapi-credential-path","https://credential-path.example/",{method:"GET",path:`/reset/${secret}`,description:"must not persist",offers:[{method:"tempo",intent:"charge",amount:"1"}]},"2026-08-25T00:00:00.000Z")).rejects.toMatchObject({code:"credential-shaped-openapi-path"});
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM endpoints WHERE service_id='openapi-credential-path'").first()).toEqual({count:0});
  });
});

describe("password-style observation redaction", () => {
  it("fully redacts secret-shaped WWW-Authenticate parameters", () => {
    const header = [
      'Payment method="tempo"',
      'intent="charge"',
      'id="payment-id-value"',
      'password="password-value"',
      'passwd="passwd-value"',
      'client_secret="client-secret-value"',
      'api_key="api-key-value"',
      'token="token-value"',
      'credential="credential-value"',
      'authorization="authorization-value"',
      'payment_signature="signature-value"',
      'opaque="opaque-value"',
    ].join(", ");
    const redacted = redactHeaders({ "WWW-Authenticate": header })["www-authenticate"];

    for (const secret of [
      "payment-id-value",
      "password-value",
      "passwd-value",
      "client-secret-value",
      "api-key-value",
      "token-value",
      "credential-value",
      "authorization-value",
      "signature-value",
      "opaque-value",
    ]) {
      expect(redacted, secret).not.toContain(secret);
    }
    expect(redacted).toMatch(/\[redacted\]|\[parsed-and-redacted\]/);
  });

  it("redacts password and passphrase keys in structured and unstructured observations", () => {
    expect(
      redactJsonValue({
        username: "public-name",
        password: "password-value",
        passwd: "passwd-value",
        passphrase: "passphrase-value",
        nested: { clientPassword: "client-password-value" },
      }),
    ).toEqual({
      username: "public-name",
      "[redacted-sensitive-key-0]": "[redacted]",
      "[redacted-sensitive-key-1]": "[redacted]",
      "[redacted-sensitive-key-2]": "[redacted]",
      nested: { "[redacted-sensitive-key-0]": "[redacted]" },
    });
    const text = redactText(
      'password="password-value" passwd=passwd-value passphrase:passphrase-value client_password=client-password-value',
    );
    expect(text).not.toMatch(/password-value|passwd-value|passphrase-value|client-password-value/);
  });

  it("redacts password-style keys decoded from Payment request metadata", () => {
    const encoded = btoa(
      JSON.stringify({
        amount: "1",
        password: "password-value",
        nested: { passphrase: "passphrase-value" },
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const [parsed] = parsePaymentChallenges(
      `Payment id="challenge", realm="api", method="tempo", intent="charge", request="${encoded}"`,
    );
    expect(parsed.request).toEqual({
      amount: "1",
      "[redacted-sensitive-key-0]": "[redacted]",
      nested: { "[redacted-sensitive-key-0]": "[redacted]" },
    });
  });
});

describe("OpenAPI attacker-controlled cardinality and size limits", () => {
  it("accepts the exact operation budget and bounds each normalized payload", () => {
    const paths: Record<string, unknown> = {
      "/oversized-offers": {
        get: {
          "x-payment-info": {
            offers: Array.from({ length: 100 }, (_, offerIndex) => ({
              method: `method-${offerIndex}`,
              intent: "charge",
              amount: "1",
              memo: "x".repeat(20_000),
            })),
          },
        },
      },
    };
    for (let index = 0; index < MAX_OPENAPI_OPERATIONS_PER_DOCUMENT-1; index += 1) {
      paths[`/operation-${String(index).padStart(4, "0")}`] = {
        get: {
          "x-payment-info": { method: "tempo", intent: "charge", amount: "1" },
        },
      };
    }

    const operations = ingestOpenApi({ openapi: "3.1.0", paths });
    expect(operations).toHaveLength(MAX_OPENAPI_OPERATIONS_PER_DOCUMENT);
    for (const operation of operations) {
      expect(operation.path.length).toBeLessThanOrEqual(2_048);
      expect(operation.offers.length).toBeLessThanOrEqual(8);
      expect(new TextEncoder().encode(JSON.stringify(operation)).byteLength).toBeLessThanOrEqual(96 * 1_024);
    }
  });

  it("rejects documents above operation, offer, or path budgets",()=>{
    const operations=Object.fromEntries(Array.from({length:MAX_OPENAPI_OPERATIONS_PER_DOCUMENT+1},(_,index)=>[`/op-${index}`,{get:{"x-payment-info":{method:"tempo"}}}]));
    expect(ingestOpenApi({openapi:"3.1.0",paths:operations})).toEqual([]);
    const offerHeavy=Object.fromEntries(Array.from({length:Math.ceil(MAX_OPENAPI_OFFERS_PER_DOCUMENT/8)+1},(_,index)=>[`/offers-${index}`,{get:{"x-payment-info":{offers:Array.from({length:8},(__,offer)=>({method:`m-${offer}`}))}}}]));
    expect(ingestOpenApi({openapi:"3.1.0",paths:offerHeavy})).toEqual([]);
    expect(ingestOpenApi({openapi:"3.1.0",paths:{[`/${"p".repeat(2_049)}`]:{get:{"x-payment-info":{method:"tempo"}}}}})).toEqual([]);
  });
});

describe("queue message shape guards", () => {
  it("acknowledges null and malformed messages as rejected without retrying or dispatching", async () => {
    const malformed: unknown[] = [
      null,
      42,
      {},
      { type: "catalog-service" },
      { type: "url-discovery" },
      { type: "openapi-operation" },
      { type: "probe", url: 42, kind: "endpoint", source: "catalog" },
      { type: "probe", url: "https://api.example/", kind: "invalid", source: "catalog" },
    ];
    const messages = malformed.map((body, index) => ({
      id: `malformed-${index}`,
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
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
