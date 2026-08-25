import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("mpp.ninja Worker routes", () => {
  it("serves the real observatory dashboard with a strict browser policy", async () => {
    const result=await SELF.fetch("https://mpp.ninja/");
    const body=await result.text();
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(result.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(result.headers.get("permissions-policy")).toContain("payment=()");
    expect(body).toContain("See the public MPP attack surface");
    expect(body).toContain("Never payments or signed credentials");
    expect(body).not.toContain("Hello, world");
  });

  it("serves all read-only API collections with pagination metadata", async () => {
    for(const path of ["/api/services","/api/endpoints","/api/implementations","/api/changes","/api/stats"]){
      const result=await SELF.fetch(`https://mpp.ninja${path}`);
      expect(result.status,path).toBe(200);
      expect(result.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(result.headers.get("access-control-allow-origin")).toBe("*");
      expect(await result.json()).toBeTypeOf("object");
    }
  });

  it("supports HEAD without exposing a body", async () => {
    const result=await SELF.fetch("https://mpp.ninja/api/stats",{method:"HEAD"});
    expect(result.status).toBe(200);
    expect(await result.text()).toBe("");
  });

  it("rejects private manual submissions before scheduling work", async () => {
    const result=await SELF.fetch("https://mpp.ninja/api/submissions",{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify({url:"http://169.254.169.254/latest/meta-data",sourceNote:"Authorization: Bearer secret"})});
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({status:"rejected"});
  });

  it("bounds submission bodies and accepts only explicit safe media types",async()=>{
    const unsupported=await SELF.fetch("https://mpp.ninja/api/submissions",{method:"POST",headers:{"Content-Type":"text/plain","Accept":"application/json"},body:"url=https%3A%2F%2Fexample.com"});
    expect(unsupported.status).toBe(415);
    const oversized=await SELF.fetch("https://mpp.ninja/api/submissions",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Accept":"application/json"},body:`url=${"x".repeat(9_000)}`});
    expect(oversized.status).toBe(413);
  });

  it("accepts one safe URL, redacts context, and deduplicates resubmission without new work",async()=>{
    const url="https://1.1.1.1/mpp-submit-fixture";
    const submit=()=>SELF.fetch("https://mpp.ninja/api/submissions",{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify({url,sourceNote:'password="do not retain me" public directory lead'})});
    const first=await submit();expect(first.status).toBe(202);expect(await first.json()).toMatchObject({status:"queued",url});
    const second=await submit();expect(second.status).toBe(200);expect(await second.json()).toMatchObject({status:"duplicate",url});
    const stored=await env.DB.prepare("SELECT source_note FROM submissions WHERE normalized_url=?").bind(url).first<{source_note:string}>();
    expect(stored?.source_note).toContain('password="[redacted]"');expect(stored?.source_note).not.toContain("do not retain me");
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM crawl_targets WHERE service_id IS NOT NULL").first<{count:number}>())?.count).toBeGreaterThanOrEqual(3);
  });

  it("rejects query-bearing submissions rather than replaying bearer material",async()=>{
    const result=await SELF.fetch("https://mpp.ninja/api/submissions",{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify({url:"https://1.1.1.1/resource?token=secret"})});
    expect(result.status).toBe(400);expect(await result.json()).toMatchObject({status:"rejected"});
  });

  it("rejects credential-shaped reset paths before rate or candidate reservation",async()=>{
    const token="a".repeat(48);const url=`https://1.1.1.1/reset/${token}`;
    const before=Number((await env.DB.prepare("SELECT COUNT(*) AS count FROM submission_rate_windows").first<{count:number}>())?.count??0);
    const result=await SELF.fetch("https://mpp.ninja/api/submissions",{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json","CF-Connecting-IP":"203.0.113.55"},body:JSON.stringify({url})});
    expect(result.status).toBe(400);expect(await result.json()).toMatchObject({status:"rejected"});
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM submissions WHERE normalized_url=?").bind(url).first<{count:number}>())?.count).toBe(0);
    expect(Number((await env.DB.prepare("SELECT COUNT(*) AS count FROM submission_rate_windows").first<{count:number}>())?.count??0)).toBe(before);
  });

  it("returns explicit not-found and method errors", async () => {
    expect((await SELF.fetch("https://mpp.ninja/api/missing")).status).toBe(404);
    const result=await SELF.fetch("https://mpp.ninja/api/stats",{method:"DELETE"});
    expect(result.status).toBe(405);
    expect(result.headers.get("allow")).toBe("GET, HEAD");
  });
});
