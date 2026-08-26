import { describe, expect, it } from "vitest";

// The CLI is intentionally dependency-free JavaScript so Node can execute it
// directly without adding a build or payment-capable MPP client dependency.
// @ts-expect-error JavaScript CLI module intentionally has no declaration file.
import { analyzeEndpoints, fetchEndpointIndex } from "../scripts/audit-index.mjs";

function endpoint(implementation: string, offers: Array<Record<string, unknown>>) {
  return {
    id: `${implementation}-endpoint`,
    service_id: `${implementation}-service`,
    service_name: `${implementation} service`,
    url: `https://${implementation}.example/resource`,
    implementation,
    implementation_confidence: implementation === "unknown" ? 0 : 0.9,
    offers,
    offerPagination: { truncated: false },
  };
}

describe("index-only MPP finding correlation", () => {
  it("does not turn charge offers or implementation markers into vulnerability claims", () => {
    const report = analyzeEndpoints([
      endpoint("mppx", [{ method: "tempo", intent: "charge", amount: "100" }]),
      endpoint("mpp-rs", [{ method: "stripe", intent: "charge", amount: "100" }]),
    ]);
    expect(report.summary).toMatchObject({ tempoSessionOffers: 0, reviewCandidates: 0, confirmedVulnerabilities: 0 });
    expect(report.findings).toEqual([]);
  });

  it("maps a Tempo session offer to C-010 without claiming exploitation", () => {
    const report = analyzeEndpoints([
      endpoint("mppx", [{ method: "tempo", intent: "session", amount: "1", sourceType: "challenge" }]),
    ]);
    expect(report.summary).toMatchObject({ tempoSessionOffers: 1, reviewCandidates: 1, confirmedVulnerabilities: 0 });
    expect(report.findings[0]).toMatchObject({ class: "C-010", status: "client-risk-surface", implementation: "mppx" });
    expect(report.findings[0].missingProof).toContain("No affected client version or uncapped client configuration is established.");
  });

  it("adds C-011 and C-012 candidates only for an mpp-rs Tempo session surface", () => {
    const report = analyzeEndpoints([
      endpoint("mpp-rs", [{ method: "tempo", intent: "session", amount: "10000" }]),
    ]);
    expect(report.findings.map((finding: { class: string }) => finding.class)).toEqual(["C-010", "C-011", "C-012"]);
    expect(report.summary.confirmedVulnerabilities).toBe(0);
  });

  it("reports incomplete offer evidence", () => {
    const item = endpoint("unknown", []);
    item.offerPagination.truncated = true;
    expect(analyzeEndpoints([item]).summary.truncatedEndpoints).toBe(1);
  });

  it("paginates only the normalized index API", async () => {
    const requested: string[] = [];
    const fetcher = async (input: URL) => {
      requested.push(input.toString());
      const second = input.searchParams.has("cursor");
      return new Response(JSON.stringify({ data: [endpoint("unknown", [])], pagination: { nextCursor: second ? null : "NTA" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const results = await fetchEndpointIndex("https://index.example", fetcher as typeof fetch);
    expect(results).toHaveLength(2);
    expect(requested).toEqual([
      "https://index.example/api/endpoints?limit=50",
      "https://index.example/api/endpoints?limit=50&cursor=NTA",
    ]);
  });
});
