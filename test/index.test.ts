import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("mpp.ninja Worker", () => {
  it("serves the hello-world page without claiming MPP functionality", async () => {
    const response = await SELF.fetch("https://example.com/");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(body).toContain("Hello, world.");
    expect(body).toContain("MPP functionality is not enabled yet.");
  });

  it("supports HEAD without a response body", async () => {
    const response = await SELF.fetch("https://example.com/", { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("returns explicit errors for unsupported paths and methods", async () => {
    const notFound = await SELF.fetch("https://example.com/mpp");
    const methodNotAllowed = await SELF.fetch("https://example.com/", { method: "POST" });

    expect(notFound.status).toBe(404);
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get("allow")).toBe("GET, HEAD");
  });
});
