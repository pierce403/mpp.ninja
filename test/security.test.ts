import { describe, expect, it } from "vitest";

import {
  MAX_DISCOVERY_BYTES,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  PROBE_TIMEOUT_MS,
  ScanSafetyError,
  isPrivateOrReservedIp,
  normalizeUrl,
  readBoundedBody,
  redactHeaders,
  redactJsonValue,
  redactText,
  redactUrlForStorage,
  resolvePublicHostname,
  safeJson,
  sha256,
} from "../src/security";

function expectSafetyCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected ScanSafetyError");
  } catch (error) {
    expect(error).toBeInstanceOf(ScanSafetyError);
    expect((error as ScanSafetyError).code).toBe(code);
  }
}

async function expectAsyncSafetyCode(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
    throw new Error("expected ScanSafetyError");
  } catch (error) {
    expect(error).toBeInstanceOf(ScanSafetyError);
    expect((error as ScanSafetyError).code).toBe(code);
  }
}

describe("scanner URL normalization", () => {
  it("canonicalizes safe HTTP URLs without discarding meaningful path or query data", () => {
    expect(normalizeUrl(" HTTPS://Example.COM:443/a%20b?currency=USDC#private-fragment ")).toBe(
      "https://example.com/a%20b?currency=USDC",
    );
    expect(normalizeUrl("http://example.com:80")).toBe("http://example.com/");
  });

  it.each([
    ["not a URL", "invalid-url"],
    ["ftp://example.com/file", "unsafe-scheme"],
    ["https://user:password@example.com/", "credentials-in-url"],
    ["https://example.com:8443/", "unsafe-port"],
    ["http://localhost/", "private-host"],
    ["http://api.localhost/", "private-host"],
    ["http://printer.local/", "private-host"],
    ["http://metadata.internal/", "private-host"],
    ["http://127.0.0.1/", "private-ip"],
    ["http://2130706433/", "private-ip"],
    ["http://[::1]/", "private-ip"],
    ["http://[fc00::1]/", "private-ip"],
    ["http://[fe80::1]/", "private-ip"],
  ])("rejects %s with stable safety code %s", (input, code) => {
    expectSafetyCode(() => normalizeUrl(input), code);
  });
});

describe("IP target classification", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "2001::1",
    "100::1",
    "2001:2::1",
    "3fff::1",
    "400::1",
    "::ffff:8.8.8.8",
    "64:ff9b::c000:201",
    "::ffff:127.0.0.1",
  ])("treats %s as private or reserved", (address) => {
    expect(isPrivateOrReservedIp(address)).toBe(true);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "allows globally routable address %s",
    (address) => {
      expect(isPrivateOrReservedIp(address)).toBe(false);
    },
  );

  it.each(["999.1.1.1", "2001:db8:::1", "not-an-ip"])("fails closed for malformed address %s", (address) => {
    expect(isPrivateOrReservedIp(address)).toBe(true);
  });
});

describe("DNS rebinding defenses", () => {
  it("requires two identical, public resolutions and returns sorted unique evidence", async () => {
    const calls: string[] = [];
    const resolver = async (hostname: string, type: "A" | "AAAA"): Promise<string[]> => {
      calls.push(`${hostname}:${type}`);
      return type === "A" ? ["8.8.8.8", "1.1.1.1", "8.8.8.8"] : ["2606:4700:4700::1111"];
    };

    await expect(resolvePublicHostname("api.example.com", resolver)).resolves.toEqual({
      hostname: "api.example.com",
      addresses: ["1.1.1.1", "2606:4700:4700::1111", "8.8.8.8"],
      stable: true,
    });
    expect(calls).toEqual([
      "api.example.com:A",
      "api.example.com:AAAA",
      "api.example.com:A",
      "api.example.com:AAAA",
    ]);
  });

  it("rejects private answers from either resolution", async () => {
    let lookup = 0;
    const resolver = async (_hostname: string, type: "A" | "AAAA"): Promise<string[]> => {
      lookup += 1;
      if (type === "AAAA") return [];
      return lookup < 3 ? ["8.8.8.8"] : ["169.254.169.254"];
    };
    await expectAsyncSafetyCode(() => resolvePublicHostname("flip.example", resolver), "private-dns-answer");
  });

  it("rejects changed public answers and empty DNS", async () => {
    let aLookup = 0;
    const rebound = async (_hostname: string, type: "A" | "AAAA"): Promise<string[]> => {
      if (type === "AAAA") return [];
      aLookup += 1;
      return aLookup === 1 ? ["1.1.1.1"] : ["8.8.8.8"];
    };
    await expectAsyncSafetyCode(() => resolvePublicHostname("flip.example", rebound), "dns-rebinding");
    await expectAsyncSafetyCode(() => resolvePublicHostname("empty.example", async () => []), "dns-empty");
  });

  it("does not call DNS for a validated public IP literal", async () => {
    let called = false;
    const evidence = await resolvePublicHostname("1.1.1.1", async () => {
      called = true;
      return [];
    });
    expect(called).toBe(false);
    expect(evidence).toEqual({ hostname: "1.1.1.1", addresses: ["1.1.1.1"], stable: true });
  });
});

describe("observation redaction", () => {
  it("redacts credentials, cookies, payment material, and generic secret-like headers", () => {
    const redacted = redactHeaders({
      Authorization: "Bearer should-never-leak",
      Cookie: "session=should-never-leak",
      "Set-Cookie": "session=should-never-leak",
      "X-Api-Key": "should-never-leak",
      "X-Payment": "should-never-leak",
      "Payment-Credential": "should-never-leak",
      "X-Internal-Token": "should-never-leak",
      "X-Client-Secret": "should-never-leak",
      Server: "cloudflare",
    });

    expect(redacted).toMatchObject({
      authorization: "[redacted]",
      cookie: "[redacted]",
      "set-cookie": "[redacted]",
      "x-api-key": "[redacted]",
      "x-payment": "[redacted]",
      "payment-credential": "[redacted]",
      "x-internal-token": "[redacted]",
      "x-client-secret": "[redacted]",
      server: "cloudflare",
    });
    expect(JSON.stringify(redacted)).not.toContain("should-never-leak");
  });

  it("retains only required response metadata and redacts unknown JWT and client-key values", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature-value";
    const clientKey = "client_live_should-never-be-stored";
    const redacted = redactHeaders({
      "Content-Type": "application/json; charset=utf-8",
      Server: "mpp-rs/0.8.0",
      "X-Mpp-Proxy": "true",
      "X-Trace": jwt,
      "X-Client-Key": clientKey,
    });

    expect(redacted).toMatchObject({
      "content-type": "application/json; charset=utf-8",
      server: "mpp-rs/0.8.0",
      "x-mpp-proxy": "true",
      "x-trace": "[redacted]",
      "x-client-key": "[redacted]",
    });
    expect(JSON.stringify(redacted)).not.toContain(jwt);
    expect(JSON.stringify(redacted)).not.toContain(clientKey);
  });

  it("fully redacts raw Payment challenges after structured parsing occurs elsewhere", () => {
    const redacted = redactHeaders(
      new Headers({
        "WWW-Authenticate":
          'Payment id="payment-id", method="tempo", intent="charge", request="encoded-request", opaque="signed-opaque", realm="api"',
      }),
    );

    expect(redacted["www-authenticate"]).toMatch(/\[redacted\]|\[parsed-and-redacted\]/);
    expect(redacted["www-authenticate"]).not.toContain("signed-opaque");
    expect(redacted["www-authenticate"]).not.toContain("encoded-request");
    expect(redacted["www-authenticate"]).not.toContain("payment-id");
  });

  it("caps retained allowlisted header values", () => {
    const redacted = redactHeaders({ Server: "x".repeat(5000) });
    expect(redacted.server).toHaveLength(4096);
  });

  it("removes credential-shaped redirect path segments before persistence",()=>{
    const headers=redactHeaders({Location:"https://example.com/reset/token-value?credential=secret","Content-Location":"/Bearer%20eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature-value"});
    expect(headers.location).toBe("https://example.com/reset/[redacted]");
    expect(headers["content-location"]).toBe("/[redacted]");
    expect(redactUrlForStorage("https://example.com/object/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV?token=secret")).toBe("https://example.com/object/[redacted]");
    expect(JSON.stringify(headers)).not.toContain("token-value");
    expect(JSON.stringify(headers)).not.toContain("eyJ");
  });

  it("recursively redacts secret-shaped JSON fields while retaining public payment terms", () => {
    const redacted = redactJsonValue({
      amount: "1000",
      currency: "USDC",
      authorization: "signed-credential",
      authorizationWindow: "40",
      authorizationLimit: "50",
      authorizationSignature: "signed-authorization",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature-value",
      proof: "signed-payment-proof",
      clientKey: "client-live-key",
      methodDetails: {
        chainId: 42431,
        api_key: "private-key",
        nested: [{ paymentReceipt: "receipt", recipient: "0xabc" }],
      },
    });

    expect(redacted).toEqual({
      amount: "1000",
      currency: "USDC",
      "[redacted-sensitive-key-0]": "[redacted]",
      authorizationWindow: "40",
      authorizationLimit: "50",
      "[redacted-sensitive-key-1]": "[redacted]",
      "[redacted-sensitive-key-2]": "[redacted]",
      "[redacted-sensitive-key-3]": "[redacted]",
      "[redacted-sensitive-key-4]": "[redacted]",
      methodDetails: {
        chainId: 42431,
        "[redacted-sensitive-key-0]": "[redacted]",
        nested: [{ "[redacted-sensitive-key-0]": "[redacted]", recipient: "0xabc" }],
      },
    });
    expect(JSON.stringify(redacted)).not.toContain("signed-credential");
    expect(JSON.stringify(redacted)).not.toContain("signed-authorization");
    expect(JSON.stringify(redacted)).not.toContain("private-key");
    expect(JSON.stringify(redacted)).not.toContain("signed-payment-proof");
    expect(redactText("value=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature-value")).toContain("[redacted-jwt]");
  });

  it("bounds attacker-controlled JSON depth, collection size, keys, and strings", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 15; index += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    const redactedDeep = redactJsonValue(deep);
    expect(JSON.stringify(redactedDeep)).toContain("[max-depth]");
    expect(redactJsonValue(Array.from({ length: 300 }, (_, index) => index))).toHaveLength(256);
    expect(redactJsonValue("x".repeat(20_000))).toHaveLength(16_384);
    const longKey = "k".repeat(300);
    expect(Object.keys(redactJsonValue({ [longKey]: true }) as Record<string, unknown>)[0]).toHaveLength(256);
  });

  it("redacts credential-shaped values in unstructured body previews", () => {
    const redacted = redactText(
      'authorization: Bearer abc.def.ghi, api_key="super-secret", payment_signature=0xdeadbeef cookie=session-id',
    );
    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).not.toContain("super-secret");
    expect(redacted).not.toContain("0xdeadbeef");
    expect(redacted).not.toContain("session-id");
    expect(redacted).toContain("[redacted]");
  });
});

describe("bounded response handling", () => {
  it("reads an in-limit streaming body and reports bytes rather than JavaScript characters", async () => {
    const body = "MPP ✨";
    const result = await readBoundedBody(new Response(body), 16);
    expect(result).toEqual({ text: body, bytes: new TextEncoder().encode(body).byteLength });
  });

  it("rejects an oversized declared content length before consuming the stream", async () => {
    const response = new Response("tiny", { headers: { "Content-Length": "100" } });
    await expectAsyncSafetyCode(() => readBoundedBody(response, 10), "response-too-large");
  });

  it("rejects an oversized chunked response", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(6));
          controller.enqueue(new Uint8Array(6));
          controller.close();
        },
      }),
    );
    await expectAsyncSafetyCode(() => readBoundedBody(response, 10), "response-too-large");
  });

  it("defines conservative deterministic probe limits", () => {
    expect(MAX_RESPONSE_BYTES).toBe(256 * 1024);
    expect(MAX_DISCOVERY_BYTES).toBe(1024 * 1024);
    expect(MAX_REDIRECTS).toBe(3);
    expect(PROBE_TIMEOUT_MS).toBe(8_000);
  });
});

describe("safe observation serialization", () => {
  it("removes JavaScript line separator characters", () => {
    const serialized = safeJson({ value: `before\u2028middle\u2029after` });
    expect(serialized).toBe('{"value":"beforemiddleafter"}');
  });

  it("computes a deterministic SHA-256 digest", async () => {
    await expect(sha256("mpp.ninja")).resolves.toBe("cd19a01ef54e11f65e1b04c6183d2df301f45f892b9764c1fe193429cbc81f8e");
  });
});
