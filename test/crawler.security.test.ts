import { describe, expect, it } from "vitest";

import { safeProbe } from "../src/crawler";
import { MAX_REDIRECTS, ScanSafetyError, type DnsResolver } from "../src/security";

const publicResolver: DnsResolver = async (_hostname, type) => (type === "A" ? ["1.1.1.1"] : []);

function mockFetch(
  implementation: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetcher: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const actualInit = init ?? {};
    calls.push({ url, init: actualInit });
    return implementation(url, actualInit);
  }) as typeof fetch;
  return { fetcher, calls };
}

async function expectProbeSafetyCode(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
    throw new Error("expected ScanSafetyError");
  } catch (error) {
    expect(error).toBeInstanceOf(ScanSafetyError);
    expect((error as ScanSafetyError).code).toBe(code);
  }
}

describe("safe harmless crawler requests", () => {
  it("performs only an unauthenticated manual-redirect GET and records a redacted 402 challenge", async () => {
    const request = btoa(JSON.stringify({ amount: "1", currency: "USDC", authorization: "secret" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const { fetcher, calls } = mockFetch(
      () =>
        new Response('{"error":"payment required"}', {
          status: 402,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": "session=secret",
            "WWW-Authenticate": `Payment id="secret-id", realm="api", method="tempo", intent="charge", request="${request}"`,
          },
        }),
    );

    const result = await safeProbe("https://api.example/pay?public=1#fragment", "endpoint", { fetcher, resolver: publicResolver });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.example/pay");
    expect(calls[0].init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(new Headers(calls[0].init.headers).has("authorization")).toBe(false);
    expect(calls[0].init.body).toBeUndefined();
    expect(result).toMatchObject({
      requestedUrl: "https://api.example/pay",
      finalUrl: "https://api.example/pay",
      method: "GET",
      status: 402,
      redirects: [],
      responseBytes: 28,
      tls: { state: "tested-pass" },
    });
    expect(result.headers["set-cookie"]).toBe("[redacted]");
    expect(result.headers["www-authenticate"]).not.toContain("secret-id");
    expect(result.challenges[0].request).toEqual({ amount: "1", currency: "USDC", "[redacted-sensitive-key-0]": "[redacted]" });
  });

  it("uses HEAD for homepage discovery and never consumes a response body", async () => {
    const { fetcher, calls } = mockFetch(() => new Response("ignored", { status: 200 }));
    const result = await safeProbe("https://service.example/", "homepage", { fetcher, resolver: publicResolver });
    expect(calls[0].init.method).toBe("HEAD");
    expect(result.bodyText).toBe("");
    expect(result.responseBytes).toBe(0);
  });
});

describe("safe redirect processing", () => {
  it("rejects a cross-host redirect before a second DNS lookup or fetch", async () => {
    const resolutions: string[] = [];
    const resolver: DnsResolver = async (hostname, type) => {
      resolutions.push(`${hostname}:${type}`);
      return type === "A" ? [hostname === "api.example" ? "1.1.1.1" : "8.8.8.8"] : [];
    };
    const { fetcher, calls } = mockFetch((url) =>
      url === "https://api.example/start"
        ? new Response(null, { status: 302, headers: { Location: "https://payments.example/final" } })
        : new Response("payment metadata", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );

    await expectProbeSafetyCode(
      () => safeProbe("https://api.example/start", "endpoint", { fetcher, resolver }),
      "cross-host-redirect",
    );
    expect(calls.map((call) => call.url)).toEqual(["https://api.example/start"]);
    expect(resolutions).toEqual([
      "api.example:A",
      "api.example:AAAA",
      "api.example:A",
      "api.example:AAAA",
    ]);
  });

  it("allows a same-host cleartext-to-HTTPS upgrade",async()=>{
    const {fetcher,calls}=mockFetch((url)=>url.startsWith("http:")
      ?new Response(null,{status:308,headers:{Location:"https://api.example/final"}})
      :new Response("ok",{status:200}));
    const result=await safeProbe("http://api.example/start","endpoint",{fetcher,resolver:publicResolver});
    expect(calls.map(({url})=>url)).toEqual(["http://api.example/start","https://api.example/final"]);
    expect(result.finalUrl).toBe("https://api.example/final");
  });

  it("blocks private, local, credentialed, and HTTPS-downgrade redirect targets before fetching them", async () => {
    const cases: Array<[string, string]> = [
      ["http://169.254.169.254/latest/meta-data", "private-ip"],
      ["https://localhost/admin", "private-host"],
      ["https://user:pass@example.com/admin", "credentials-in-url"],
      ["http://public.example/insecure", "https-downgrade"],
    ];
    for (const [location, code] of cases) {
      const { fetcher, calls } = mockFetch(() => new Response(null, { status: 302, headers: { Location: location } }));
      await expectProbeSafetyCode(
        () => safeProbe("https://api.example/start", "endpoint", { fetcher, resolver: publicResolver }),
        code,
      );
      expect(calls).toHaveLength(1);
    }
  });

  it("rejects redirects without a Location and chains longer than the fixed maximum", async () => {
    const missing = mockFetch(() => new Response(null, { status: 302 }));
    await expectProbeSafetyCode(
      () => safeProbe("https://api.example/start", "endpoint", { fetcher: missing.fetcher, resolver: publicResolver }),
      "redirect-without-location",
    );

    let hop = 0;
    const looping = mockFetch(() => {
      hop += 1;
      return new Response(null, { status: 302, headers: { Location: `/hop-${hop}` } });
    });
    await expectProbeSafetyCode(
      () => safeProbe("https://api.example/start", "endpoint", { fetcher: looping.fetcher, resolver: publicResolver }),
      "too-many-redirects",
    );
    expect(looping.calls).toHaveLength(MAX_REDIRECTS + 1);
  });

  it("permits bounded same-origin canonical redirects but rejects URL loops", async () => {
    const canonical = mockFetch((url) =>
      url.endsWith("/start")
        ? new Response(null, { status: 301, headers: { Location: "/start/" } })
        : new Response("ok", { status: 200 }),
    );
    const origins: string[] = [];
    const result = await safeProbe("https://api.example/start", "endpoint", {
      fetcher: canonical.fetcher,
      resolver: publicResolver,
      onOrigin: async (origin) => { origins.push(origin); },
    });
    expect(result.finalUrl).toBe("https://api.example/start/");
    expect(origins).toEqual(["https://api.example"]);

    const loop = mockFetch((url) =>
      new Response(null, { status: 302, headers: { Location: url.endsWith("/a") ? "/b" : "/a" } }),
    );
    await expectProbeSafetyCode(
      () => safeProbe("https://api.example/a", "endpoint", { fetcher: loop.fetcher, resolver: publicResolver }),
      "redirect-loop",
    );
    expect(loop.calls).toHaveLength(2);
  });

  it("blocks the observatory itself as a scan target", async () => {
    const { fetcher, calls } = mockFetch(() => new Response("must not run"));
    await expectProbeSafetyCode(
      () => safeProbe("https://mpp.ninja/api/stats", "endpoint", { fetcher, resolver: publicResolver }),
      "self-target",
    );
    expect(calls).toHaveLength(0);
  });

  it("does not follow non-redirect status codes even if they include Location", async () => {
    const { fetcher, calls } = mockFetch(() => new Response("created", { status: 201, headers: { Location: "https://other.example/" } }));
    const result = await safeProbe("https://api.example/create-info", "endpoint", { fetcher, resolver: publicResolver });
    expect(calls).toHaveLength(1);
    expect(result.status).toBe(201);
    expect(result.redirects).toEqual([]);
  });
});
