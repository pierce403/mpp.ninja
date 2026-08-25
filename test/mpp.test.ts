import { describe, expect, it } from "vitest";

import {
  challengeToOffer,
  economicRiskMetadata,
  fingerprintImplementation,
  ingestApiCatalog,
  ingestOpenApi,
  isValidPaymentChallenge,
  parsePaymentChallenges,
} from "../src/mpp";
import { MAX_API_CATALOG_LINKS_PER_DOCUMENT } from "../src/budgets";
import type { ParsedChallenge, PaymentOffer, ProbeResult } from "../src/model";

function base64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function probe(overrides: Partial<Pick<ProbeResult, "status" | "headers" | "challenges" | "bodyText" | "finalUrl">> = {}) {
  return {
    status: 402,
    headers: {},
    challenges: [],
    bodyText: "",
    finalUrl: "https://api.example/v1/data",
    ...overrides,
  };
}

function challenge(overrides: Partial<ParsedChallenge> = {}): ParsedChallenge {
  return {
    method: "tempo",
    intent: "charge",
    realm: "api",
    description: null,
    expires: null,
    idPresent: true,
    opaquePresent: false,
    opaqueMppxScope: false,
    request: {},
    ...overrides,
  };
}

function offer(overrides: Partial<PaymentOffer> = {}): PaymentOffer {
  return {
    method: "tempo",
    intent: "session",
    amount: null,
    currency: null,
    recipient: null,
    chainId: null,
    decimals: null,
    unitType: null,
    session: null,
    sourceType: "challenge",
    ...overrides,
  };
}

describe("Payment challenge parsing", () => {
  it("parses multiple challenges without splitting commas inside quoted fields", () => {
    const tempoRequest = base64UrlJson({
      amount: "0.0025",
      currency: "0x20c0000000000000000000000000000000000000",
      recipient: "0x000000000000000000000000000000000000beef",
      unitType: "request",
      methodDetails: { chainId: 42431, decimals: 6 },
      suggestedDeposit: "0.025",
    });
    const evmRequest = base64UrlJson({ amount: "1000", currency: "USDC", methodDetails: { chainId: "8453" } });
    const opaque = base64UrlJson({ nonce: "opaque-one" });
    const header =
      `Payment id="secret-one", realm="api", method="tempo", intent="session", description="Data, fresh and verified", request="${tempoRequest}", opaque="${opaque}", ` +
      `Payment id="secret-two", realm="api", method="evm", intent="charge", request="${evmRequest}"`;

    const parsed = parsePaymentChallenges(header);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      method: "tempo",
      intent: "session",
      realm: "api",
      description: "Data, fresh and verified",
      expires: null,
      idPresent: true,
      opaquePresent: true,
      opaqueMppxScope: false,
      request: {
        amount: "0.0025",
        currency: "0x20c0000000000000000000000000000000000000",
        recipient: "0x000000000000000000000000000000000000beef",
        unitType: "request",
        methodDetails: { chainId: 42431, decimals: 6 },
        suggestedDeposit: "0.025",
      },
    });
    expect(parsed[1]).toMatchObject({ method: "evm", intent: "charge", realm: "api", idPresent: true, opaquePresent: false });
    expect(parsed.every(isValidPaymentChallenge)).toBe(true);
  });

  it("isolates Payment challenges before and after other authentication schemes", () => {
    const request=base64UrlJson({amount:"1",currency:"USDC"});
    const payment=`Payment id="challenge", realm="api", method="tempo", intent="charge", request="${request}"`;
    for(const header of [`${payment}, Bearer realm="other"`,`Bearer realm="other", ${payment}`,`Basic realm="login", ${payment}, Digest realm="other", nonce="public"`]){
      const parsed=parsePaymentChallenges(header);
      expect(parsed,header).toHaveLength(1);
      expect(parsed[0],header).toMatchObject({method:"tempo",intent:"charge",realm:"api",request:{amount:"1",currency:"USDC"}});
      expect(isValidPaymentChallenge(parsed[0]),header).toBe(true);
    }
  });

  it("accepts legal token extension parameters and rejects invalid token values", () => {
    const request=base64UrlJson({amount:"1",currency:"USDC"});
    const base=`Payment id="challenge", realm="api", method="tempo", intent="charge", request="${request}"`;
    expect(parsePaymentChallenges(`${base}, vendor.foo="public"`)[0].parseError).toBeUndefined();
    expect(parsePaymentChallenges(base.replace('realm="api"',"realm=<bad>"))[0].parseError).toBe("invalid:syntax");
  });

  it("records deterministic parse errors and never throws for malformed input", () => {
    expect(parsePaymentChallenges(null)).toEqual([]);
    expect(parsePaymentChallenges("Bearer realm=api")).toEqual([]);
    expect(parsePaymentChallenges('Payment method="tempo", request="%%%"')).toEqual([
      {
        method: "tempo",
        intent: "unknown",
        realm: null,
        description: null,
        expires: null,
        idPresent: false,
        opaquePresent: false,
        opaqueMppxScope: false,
        request: null,
        parseError: "missing:id,realm,intent",
      },
    ]);
    expect(
      parsePaymentChallenges('Payment id="challenge", realm="api", method="tempo", intent="charge", request="%%%"')[0].parseError,
    ).toBe("invalid:request");
  });

  it("rejects duplicate parameters, unconsumed syntax, and oversized challenge headers",()=>{
    const request=base64UrlJson({amount:"1"});
    const base=`Payment id="challenge", realm="api", method="tempo", intent="charge", request="${request}"`;
    for(const header of [`${base}, @@@`,`${base}, method="evm"`]){const [parsed]=parsePaymentChallenges(header);expect(parsed.parseError).toContain("invalid:syntax");expect(isValidPaymentChallenge(parsed)).toBe(false);}
    const [oversized]=parsePaymentChallenges(`${base}, description="${"x".repeat(33_000)}"`);expect(oversized.parseError).toBe("header-too-large");expect(isValidPaymentChallenge(oversized)).toBe(false);
  });

  it("requires id, realm, method, intent, and a decodable request", () => {
    const request = base64UrlJson({ amount: "1" });
    const cases: Array<[string, string]> = [
      [`Payment realm="api", method="tempo", intent="charge", request="${request}"`, "missing:id"],
      [`Payment id="challenge", method="tempo", intent="charge", request="${request}"`, "missing:realm"],
      [`Payment id="challenge", realm="api", intent="charge", request="${request}"`, "missing:method"],
      [`Payment id="challenge", realm="api", method="tempo", request="${request}"`, "missing:intent"],
      ['Payment id="challenge", realm="api", method="tempo", intent="charge"', "missing:request"],
    ];
    for (const [header, error] of cases) {
      const [parsed] = parsePaymentChallenges(header);
      expect(parsed.parseError, header).toBe(error);
      expect(isValidPaymentChallenge(parsed), header).toBe(false);
    }
  });

  it("handles escaped quoted challenge metadata", () => {
    const parsed = parsePaymentChallenges(
      `Payment id="challenge", realm="api", method="tempo", intent="charge", request="${base64UrlJson({})}", description="A \\"quoted\\" value"`,
    );
    expect(parsed[0].description).toBe('A "quoted" value');
    expect(isValidPaymentChallenge(parsed[0])).toBe(true);
  });

  it("redacts nested credentials in decoded requests and detects mppx markers without retaining opaque data", () => {
    const request = base64UrlJson({
      amount: "1",
      authorization: "signed-request",
      methodDetails: { chainId: 42431, paymentSignature: "secret-signature" },
    });
    const opaque = base64UrlJson({ _mppx_scope: "service", credential: "do-not-store" });
    const [parsed] = parsePaymentChallenges(
      `Payment id="secret-id", realm="api", method="tempo", intent="charge", request="${request}", opaque="${opaque}"`,
    );

    expect(parsed).toMatchObject({
      idPresent: true,
      opaquePresent: true,
      opaqueMppxScope: true,
      request: {
        amount: "1",
        "[redacted-sensitive-key-0]": "[redacted]",
        methodDetails: { chainId: 42431, "[redacted-sensitive-key-0]": "[redacted]" },
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("signed-request");
    expect(JSON.stringify(parsed)).not.toContain("secret-signature");
    expect(JSON.stringify(parsed)).not.toContain("do-not-store");
    expect(JSON.stringify(parsed)).not.toContain("secret-id");
  });

  it("preserves public authorization limits through parsing and derives economic metadata without retaining credentials", () => {
    const request = base64UrlJson({
      amount: "2",
      suggestedDeposit: "100",
      authorizationWindow: "40",
      authorizationLimit: "50",
      maxUnits: "10",
      authorization: "signed-request",
      authorizationSignature: "secret-signature",
    });
    const [parsed] = parsePaymentChallenges(
      `Payment id="secret-id", realm="api", method="tempo", intent="session", request="${request}"`,
    );

    expect(parsed.request).toMatchObject({
      authorizationWindow: "40",
      authorizationLimit: "50",
      "[redacted-sensitive-key-0]": "[redacted]",
      "[redacted-sensitive-key-1]": "[redacted]",
    });
    const normalized = challengeToOffer(parsed);
    expect(economicRiskMetadata(normalized)).toEqual({
      deposit: 100,
      authorizationWindow: 40,
      depositWindowRatio: 2.5,
      observableAuthorizationExposure: 20,
      note: "derived only from advertised or challenged values",
    });
    expect(JSON.stringify(normalized)).not.toMatch(/signed-request|secret-signature|secret-id/);
  });
});

describe("challenge normalization", () => {
  it("normalizes core fields once while retaining non-core method details as evidence", () => {
    const normalized = challengeToOffer(
      challenge({
        method: "tempo",
        intent: "session",
        request: {
          amount: "0.01",
          currency: "USDC",
          recipient: "0xabc",
          unitType: "token",
          methodDetails: { chainId: 42431, decimals: 6, feePayer: "0xfee" },
          suggestedDeposit: "1",
          authorizationWindow: "0.2",
        },
      }),
    );

    expect(normalized).toEqual({
      method: "tempo",
      intent: "session",
      amount: "0.01",
      currency: "USDC",
      recipient: "0xabc",
      chainId: "42431",
      decimals: 6,
      unitType: "token",
      session: {
        suggestedDeposit: "1",
        authorizationWindow: "0.2",
        methodDetails: { feePayer: "0xfee" },
      },
      sourceType: "challenge",
    });
  });

  it("uses null for absent or wrong-typed advertised values", () => {
    const normalized = challengeToOffer(challenge({ request: { amount: 10, methodDetails: "not-an-object" } }));
    expect(normalized).toMatchObject({
      amount: null,
      currency: null,
      recipient: null,
      chainId: null,
      decimals: null,
      unitType: null,
      session: null,
    });
  });
});

describe("OpenAPI MPP discovery ingestion", () => {
  it("extracts and deterministically sorts operation-level x-payment-info offers", () => {
    const result = ingestOpenApi({
      openapi: "3.1.0",
      paths: {
        "/z-last": {
          post: {
            summary: "Last",
            "x-payment-info": { method: "tempo", intent: "charge", amount: "2" },
          },
        },
        "/a-first": {
          parameters: [],
          get: {
            description: "First operation",
            "x-payment-info": {
              offers: [
                { method: "tempo", intent: "charge", amount: "1", currency: "USDC" },
                { method: "evm", intent: "charge", amount: "1000000", currency: "USDC" },
              ],
            },
          },
          head: { summary: "Free metadata" },
        },
      },
    });

    expect(result).toEqual([
      {
        method: "GET",
        path: "/a-first",
        description: "First operation",
        offers: [
          { method: "tempo", intent: "charge", amount: "1", currency: "USDC" },
          { method: "evm", intent: "charge", amount: "1000000", currency: "USDC" },
        ],
      },
      {
        method: "POST",
        path: "/z-last",
        description: "Last",
        offers: [{ method: "tempo", intent: "charge", amount: "2" }],
      },
    ]);
  });

  it.each([
    null,
    [],
    {},
    { openapi: "2.0", paths: {} },
    { openapi: "3.1.0" },
    { openapi: "3.1.0", paths: [] },
  ])("ignores a non-OpenAPI-3 document without throwing", (document) => {
    expect(ingestOpenApi(document)).toEqual([]);
  });

  it("ignores invalid paths, unsupported methods, and malformed offers", () => {
    expect(
      ingestOpenApi({
        openapi: "3.1.0",
        paths: {
          relative: { get: { "x-payment-info": { method: "tempo" } } },
          "/valid": {
            options: { "x-payment-info": { method: "tempo" } },
            get: { "x-payment-info": "invalid" },
          },
        },
      }),
    ).toEqual([]);
  });

  it("normalizes the current protocol-list x-payment-info shape", () => {
    expect(
      ingestOpenApi({
        openapi: "3.1.0",
        paths: {
          "/weather": {
            get: {
              summary: "Weather",
              "x-payment-info": {
                price: { amount: "0.01", currency: "USDC" },
                protocols: ["tempo", { method: "evm", recipient: "0xabc" }],
              },
            },
          },
        },
      }),
    ).toEqual([
      {
        method: "GET",
        path: "/weather",
        description: "Weather",
        offers: [
          { amount: "0.01", currency: "USDC", method: "tempo" },
          { amount: "0.01", currency: "USDC", method: "evm", recipient: "0xabc" },
        ],
      },
    ]);
  });
});

describe("RFC 9727 API catalog ingestion",()=>{
  it("extracts bounded OpenAPI service descriptions and resolves relative URLs",()=>{
    expect(ingestApiCatalog({linkset:[{anchor:"https://api.example/","service-desc":[{href:"/openapi.json",type:"application/openapi+json"},{href:"https://docs.example/spec.json",type:"application/json"}],"service-doc":[{href:"javascript:alert(1)",type:"text/html"}]}]},"https://api.example/.well-known/api-catalog")).toEqual(["https://api.example/openapi.json","https://docs.example/spec.json"]);
  });
  it("ignores malformed and non-catalog documents",()=>{expect(ingestApiCatalog({},"https://api.example/.well-known/api-catalog")).toEqual([]);expect(ingestApiCatalog({linkset:"bad"},"https://api.example/.well-known/api-catalog")).toEqual([]);});
  it("rejects linksets above the per-document scheduling budget",()=>{
    const links=Array.from({length:MAX_API_CATALOG_LINKS_PER_DOCUMENT+1},(_,index)=>({href:`https://api.example/openapi-${index}.json`,type:"application/openapi+json"}));
    expect(ingestApiCatalog({linkset:[{"service-desc":links}]},"https://api.example/.well-known/api-catalog")).toEqual([]);
  });
});

describe("conservative implementation fingerprinting", () => {
  it("uses explicit product markers with fixed confidence and evidence", () => {
    expect(fingerprintImplementation(probe({ headers: { "x-mpp-proxy": "true" } }))).toEqual({
      implementation: "mpp-proxy",
      confidence: 0.95,
      evidence: ["mpp-proxy product marker observed"],
    });
    expect(fingerprintImplementation(probe({ headers: { server: "mpp-rs/0.8.0" } }))).toEqual({
      implementation: "mpp-rs",
      confidence: 0.9,
      evidence: ["mpp-rs product marker observed"],
    });
    expect(
      fingerprintImplementation(
        probe({ challenges: [challenge({ opaquePresent: true, request: { _mppx_scope: "service" } })] }),
      ),
    ).toEqual({ implementation: "mppx", confidence: 0.85, evidence: ["mppx scope marker observed in a valid 402 challenge"] });
  });

  it("uses only explicit OpenAPI implementation fields and never arbitrary prose", () => {
    expect(
      fingerprintImplementation(probe(), { openapi: "3.1.0", "x-mpp-implementation": "mpp-rs/0.8.0" }),
    ).toMatchObject({ implementation: "mpp-rs", confidence: 0.9 });
    expect(
      fingerprintImplementation(probe(), {openapi:"3.1.0",info:{title:"mpp-proxy examples",description:"This service does not use mpp-proxy or mpp-rs"},paths:{"/not-mpp-rs":{get:{description:"mpp-proxy migration notes"}}}}),
    ).toEqual({implementation:"unknown",confidence:0,evidence:["no conservative implementation marker observed"]});
    expect(
      fingerprintImplementation(probe({challenges:[challenge({request:{description:"No _mppx_scope field is used"}})]})),
    ).toEqual({implementation:"custom",confidence:0.35,evidence:["valid 402 Payment challenge observed without implementation-specific marker"]});
    expect(
      fingerprintImplementation(probe({ headers: { server: "cloudflare" }, finalUrl: "https://workers.dev/api" })),
    ).toEqual({ implementation: "unknown", confidence: 0, evidence: ["no conservative implementation marker observed"] });
    for(const server of ["not-mpp-rs","unrelatedmpp-rs","mpp-rs-like","gateway/mpp-rs"]){
      expect(fingerprintImplementation(probe({headers:{server}})),server).toEqual({implementation:"unknown",confidence:0,evidence:["no conservative implementation marker observed"]});
    }
  });

  it("labels a standards-compliant challenge as low-confidence custom and no challenge as unknown", () => {
    expect(fingerprintImplementation(probe({ challenges: [challenge()] }))).toEqual({
      implementation: "custom",
      confidence: 0.35,
      evidence: ["valid 402 Payment challenge observed without implementation-specific marker"],
    });
    expect(fingerprintImplementation(probe())).toEqual({
      implementation: "unknown",
      confidence: 0,
      evidence: ["no conservative implementation marker observed"],
    });
  });

  it("uses deterministic precedence when multiple explicit markers conflict", () => {
    const result = fingerprintImplementation(
      probe({
        headers: { "x-mpp-proxy": "true", server: "mpp-rs/0.8" },
        challenges: [challenge({ opaquePresent: true, request: { _mppx_scope: "service" } })],
      }),
    );
    expect(result.implementation).toBe("mpp-proxy");
    expect(result.confidence).toBe(0.95);
    expect(result.evidence).toEqual([
      "mppx scope marker observed in a valid 402 challenge",
      "mpp-proxy product marker observed",
      "mpp-rs product marker observed",
    ]);
  });

  it("does not infer a runtime implementation from Payment-like headers on non-402 responses", () => {
    expect(
      fingerprintImplementation(
        probe({
          status: 200,
          challenges: [challenge({ opaqueMppxScope: true, request: { _mppx_scope: "service" } })],
        }),
      ),
    ).toEqual({ implementation: "unknown", confidence: 0, evidence: ["no conservative implementation marker observed"] });
  });
});

describe("observable economic-risk metadata", () => {
  it("derives ratios and authorization exposure only from observable non-negative inputs", () => {
    expect(
      economicRiskMetadata(
        offer({
          amount: "2",
          session: { deposit: "100", authorizationWindow: "40", maxUnits: "10" },
        }),
      ),
    ).toEqual({
      deposit: 100,
      authorizationWindow: 40,
      depositWindowRatio: 2.5,
      observableAuthorizationExposure: 20,
      note: "derived only from advertised or challenged values",
    });
  });

  it("never reports negative authorization exposure", () => {
    expect(
      economicRiskMetadata(offer({ amount: "5", session: { window: 10, units: 3 } })).observableAuthorizationExposure,
    ).toBe(0);
  });

  it("reports unknown rather than inferring absent, malformed, negative, or zero-denominator inputs", () => {
    expect(economicRiskMetadata(offer())).toEqual({
      deposit: null,
      authorizationWindow: null,
      depositWindowRatio: null,
      observableAuthorizationExposure: null,
      note: "unknown: session authorization inputs not observable",
    });
    expect(
      economicRiskMetadata(
        offer({ amount: "not-a-number", session: { depositAmount: -1, windowAmount: "0", maxUnits: "unknown" } }),
      ),
    ).toEqual({
      deposit: null,
      authorizationWindow: 0,
      depositWindowRatio: null,
      observableAuthorizationExposure: null,
      note: "derived only from advertised or challenged values",
    });
  });
});
