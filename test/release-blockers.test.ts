import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { crawlTargetId, enqueueTarget, splitCatalogQueueRecord } from "../src/catalog";
import { openApiQueueMessages } from "../src/crawler";
import { parsePaymentChallenges } from "../src/mpp";
import type { CatalogService, CrawlMessage, IngestedOperation, ObservatoryQueueMessage } from "../src/model";
import { redactHeaders } from "../src/security";

function base64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

describe("bounded Payment challenge fan-out", () => {
  it("retains at most the first eight Payment challenges from one attacker-controlled header", () => {
    const request = base64UrlJson({ amount: "1", currency: "USDC" });
    const header = Array.from(
      { length: 12 },
      (_, index) =>
        `Payment id="challenge-${index}", realm="realm-${index}", method="tempo", intent="charge", request="${request}"`,
    ).join(", ");

    const parsed = parsePaymentChallenges(header);
    expect(parsed).toHaveLength(8);
    expect(parsed.map((challenge) => challenge.realm)).toEqual(
      Array.from({ length: 8 }, (_, index) => `realm-${index}`),
    );
    expect(parsed.every((challenge) => challenge.parseError === undefined)).toBe(true);
    expect(parsed.some((challenge) => challenge.realm === "realm-8")).toBe(false);
  });
});

describe("redirect and discovery metadata redaction", () => {
  it("removes queries and fragments from Location headers and discards Link/Refresh metadata", () => {
    const redacted = redactHeaders({
      Location: "https://payments.example/continue?token=location-secret#fragment",
      "Content-Location": "/receipts/latest?api_key=content-secret#fragment",
      Link: '<https://payments.example/next?credential=link-secret>; rel="next", </openapi.json?token=link-secret>; rel="service-desc"',
      Refresh: "0; url=https://payments.example/final?password=refresh-secret",
      Server: "cloudflare",
    });

    expect(redacted.location).toBe("https://payments.example/continue");
    expect(redacted["content-location"]).toBe("/receipts/latest");
    expect(redacted.link).toBe("[redacted]");
    expect(redacted.refresh).toBe("[redacted]");
    expect(redacted.server).toBe("cloudflare");
    expect(JSON.stringify(redacted)).not.toMatch(
      /location-secret|content-secret|link-secret|refresh-secret|[?&](?:token|api_key|credential|password)=/,
    );
  });

  it("removes URL userinfo from redirect metadata before persistence",()=>{const redacted=redactHeaders({Location:"https://alice:location-password@payments.example/continue?token=secret","Content-Location":"https://bob:other-secret@payments.example/receipt"});expect(redacted.location).toBe("https://payments.example/continue");expect(redacted["content-location"]).toBe("https://payments.example/receipt");expect(JSON.stringify(redacted)).not.toMatch(/alice|bob|location-password|other-secret|token=secret/);});
});

describe("bounded queue record shaping", () => {
  it("splits catalog services to exactly one endpoint per queue message", () => {
    const service: CatalogService = {
      id: "catalog-split",
      name: "Catalog Split",
      serviceUrl: "https://catalog-split.example/",
      endpoints: Array.from({ length: 4 }, (_, index) => ({
        method: index % 2 === 0 ? "GET" : "HEAD",
        path: `/endpoint-${index}`,
        description: `Endpoint ${index}`,
      })),
    };

    const records = splitCatalogQueueRecord(service);
    expect(records).toHaveLength(4);
    expect(records.every((record) => record.endpoints?.length === 1)).toBe(true);
    expect(records.map((record) => record.endpoints?.[0].path)).toEqual([
      "/endpoint-0",
      "/endpoint-1",
      "/endpoint-2",
      "/endpoint-3",
    ]);
    expect(records.every((record) => record.id === service.id && record.serviceUrl === service.serviceUrl)).toBe(true);

    const empty = splitCatalogQueueRecord({ ...service, endpoints: [] });
    expect(empty).toHaveLength(1);
    expect(empty[0].endpoints).toEqual([]);
  });

  it("creates one-offer OpenAPI messages with stable per-operation offer offsets", () => {
    const operations: IngestedOperation[] = [
      {
        method: "GET",
        path: "/alpha",
        description: "Alpha",
        offers: [
          { method: "tempo", amount: "1" },
          { method: "evm", amount: "2" },
          { method: "solana", amount: "3" },
        ],
      },
      {
        method: "HEAD",
        path: "/beta",
        description: "Beta",
        offers: [
          { method: "tempo", amount: "4" },
          { method: "evm", amount: "5" },
        ],
      },
    ];

    const messages = openApiQueueMessages(
      "service-id",
      "https://api.example/openapi.json",
      operations,
      "2026-08-25T00:00:00.000Z",
    );
    expect(messages).toHaveLength(5);
    expect(messages.every((message) => message.operation.offers.length === 1)).toBe(true);
    expect(
      messages.map((message) => [
        message.operation.path,
        message.offerOffset,
        message.operation.offers[0].method,
        message.operation.offers[0].amount,
      ]),
    ).toEqual([
      ["/alpha", 0, "tempo", "1"],
      ["/alpha", 1, "evm", "2"],
      ["/alpha", 2, "solana", "3"],
      ["/beta", 0, "tempo", "4"],
      ["/beta", 1, "evm", "5"],
    ]);
  });
});

describe("enqueueing lease recovery", () => {
  it("recovers stale enqueueing rows while deduplicating fresh enqueueing rows", async () => {
    const serviceId="enqueueing-service";
    await env.DB.prepare("INSERT INTO services (id,name,service_url,origin,status,first_seen,last_seen) VALUES (?,?,?,?,?,'2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z')")
      .bind(serviceId,serviceId,"https://enqueueing.example/","https://enqueueing.example","observed-mpp").run();
    const sent: ObservatoryQueueMessage[] = [];
    const testEnv = {
      DB: env.DB,
      CRAWL_QUEUE: {
        send: async (body: ObservatoryQueueMessage) => {
          sent.push(body);
        },
      },
    } as unknown as Env;
    const stale: CrawlMessage = {
      type: "probe",
      url: "https://enqueueing.example/stale",
      serviceId,
      kind: "endpoint",
      source: "scheduled",
    };
    const fresh: CrawlMessage = {
      type: "probe",
      url: "https://enqueueing.example/fresh",
      serviceId,
      kind: "endpoint",
      source: "scheduled",
    };
    const staleId = await crawlTargetId(stale, stale.url);
    const freshId = await crawlTargetId(fresh, fresh.url);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO crawl_targets (id,normalized_url,service_id,target_kind,source_kind,status,next_due_at,updated_at) VALUES (?,?,?,?,?,'enqueueing',CURRENT_TIMESTAMP,'2000-01-01 00:00:00')",
      ).bind(staleId,stale.url,serviceId,stale.kind,stale.source),
      env.DB.prepare(
        "INSERT INTO crawl_targets (id,normalized_url,service_id,target_kind,source_kind,status,next_due_at,updated_at) VALUES (?,?,?,?,?,'enqueueing',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
      ).bind(freshId,fresh.url,serviceId,fresh.kind,fresh.source),
    ]);

    await expect(enqueueTarget(testEnv, stale, 0)).resolves.toBe(1);
    await expect(enqueueTarget(testEnv, fresh, 0)).resolves.toBe(0);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: stale.url, kind: stale.kind });
    const rows = await env.DB.prepare(
      "SELECT id,status FROM crawl_targets WHERE id IN (?,?) ORDER BY id",
    )
      .bind(staleId, freshId)
      .all<{ id: string; status: string }>();
    expect(Object.fromEntries(rows.results.map((row) => [row.id, row.status]))).toEqual({
      [staleId]: "queued",
      [freshId]: "enqueueing",
    });
  });
});

describe("migration-backed immutable change history", () => {
  it("preserves successive payment-offer and security-property changes through triggers", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES ('history-service','History Service','https://history.example/','https://history.example','2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z')",
      ),
      env.DB.prepare(
        "INSERT INTO endpoints (id,service_id,url,http_method,path,first_seen,last_seen) VALUES ('history-endpoint','history-service','https://history.example/data','GET','/data','2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z')",
      ),
    ]);
    await env.DB.prepare(
      "INSERT INTO payment_offers (id,endpoint_id,method,intent,currency,recipient,amount,session_json,source_type,source_ordinal,first_seen,last_seen) VALUES ('history-offer','history-endpoint','tempo','charge','USDC','0xone','1','{}','challenge',0,'2026-08-25T01:00:00.000Z','2026-08-25T01:00:00.000Z')",
    ).run();
    await env.DB.prepare(
      "UPDATE payment_offers SET recipient='0xtwo',amount='2',last_seen='2026-08-25T02:00:00.000Z' WHERE id='history-offer'",
    ).run();
    await env.DB.prepare(
      "UPDATE payment_offers SET amount='3',last_seen='2026-08-25T03:00:00.000Z' WHERE id='history-offer'",
    ).run();

    await env.DB.prepare(
      "INSERT INTO security_properties (id,service_id,endpoint_id,property_key,state,evidence,basis,observed_at) VALUES ('history-security','history-service','history-endpoint','challenge_parse','unknown','none observed','harmless response','2026-08-25T01:00:00.000Z')",
    ).run();
    await env.DB.prepare(
      "UPDATE security_properties SET state='tested-pass',evidence='valid challenge',observed_at='2026-08-25T02:00:00.000Z' WHERE id='history-security'",
    ).run();
    await env.DB.prepare(
      "UPDATE security_properties SET state='tested-fail',evidence='malformed challenge',basis='later harmless response',observed_at='2026-08-25T03:00:00.000Z' WHERE id='history-security'",
    ).run();

    const offerChanges = await env.DB.prepare(
      "SELECT changed_at,change_type,field_name,old_value,new_value FROM changes WHERE service_id='history-service' AND change_type LIKE 'payment-offer-%' ORDER BY changed_at,field_name",
    ).all<{
      changed_at: string;
      change_type: string;
      field_name: string;
      old_value: string | null;
      new_value: string | null;
    }>();
    expect(offerChanges.results).toHaveLength(4);
    expect(offerChanges.results.filter((row) => row.change_type === "payment-offer-discovered")).toHaveLength(1);
    expect(
      offerChanges.results
        .filter((row) => row.change_type === "payment-offer-updated")
        .map((row) => [row.changed_at, row.field_name, row.old_value, row.new_value]),
    ).toEqual([
      ["2026-08-25T02:00:00.000Z", "amount", "1", "2"],
      ["2026-08-25T02:00:00.000Z", "recipient", "0xone", "0xtwo"],
      ["2026-08-25T03:00:00.000Z", "amount", "2", "3"],
    ]);

    const securityChanges = await env.DB.prepare(
      "SELECT changed_at,old_value,new_value FROM changes WHERE service_id='history-service' AND change_type='security-property-changed' ORDER BY changed_at",
    ).all<{ changed_at: string; old_value: string; new_value: string }>();
    expect(securityChanges.results).toHaveLength(2);
    expect(securityChanges.results.map((row) => row.changed_at)).toEqual([
      "2026-08-25T02:00:00.000Z",
      "2026-08-25T03:00:00.000Z",
    ]);
    expect(securityChanges.results.map((row) => JSON.parse(row.old_value).state)).toEqual(["unknown", "tested-pass"]);
    expect(securityChanges.results.map((row) => JSON.parse(row.new_value).state)).toEqual(["tested-pass", "tested-fail"]);
  });
});
