import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { listEndpoints, listServices, parsePage, upsertCatalogService } from "../src/db";
import type { CatalogService } from "../src/model";

function service(overrides:Partial<CatalogService>={}):CatalogService{
  return {id:"fixture",name:"Fixture API",serviceUrl:"https://api.example.com/mpp/",description:"Payment data",endpoints:[{method:"GET",path:"price",payment:{method:"tempo",intent:"charge",amount:"100",currency:"USDC",recipient:"0xone",methodDetails:{chainId:42431,decimals:6}}}],...overrides};
}

describe("D1 migrations and normalized history",()=>{
  it("applies every migration and enforces the evidence-state vocabulary",async()=>{
    const tables=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();
    expect(tables.results.map((row)=>row.name)).toEqual(expect.arrayContaining(["services","endpoints","payment_offers","sources","observations","security_properties","changes","submissions","crawl_targets","origin_rate_limits","discovery_runs","d1_migrations"]));
    await expect(env.DB.prepare("INSERT INTO services (id,name,service_url,origin,first_seen,last_seen) VALUES ('s','s','https://s.example/','https://s.example','2026-01-01','2026-01-01')").run()).resolves.toBeDefined();
    await expect(env.DB.prepare("INSERT INTO security_properties (id,service_id,property_key,state,evidence,basis,observed_at) VALUES ('bad','s','x','secure','x','x','2026-01-01')").run()).rejects.toThrow();
  });

  it("deduplicates exact service URLs while preserving distinct paths on one origin",async()=>{
    const now="2026-08-25T00:00:00.000Z";
    const first=await upsertCatalogService(env.DB,service(),"https://mpp.dev/api/services",now);
    const duplicate=await upsertCatalogService(env.DB,service({id:"renamed-catalog-id"}),"https://mpp.dev/api/services",now);
    const sibling=await upsertCatalogService(env.DB,service({id:"sibling",name:"Sibling",serviceUrl:"https://api.example.com/other/",endpoints:[]}),"https://mpp.dev/api/services",now);
    expect(duplicate.serviceId).toBe(first.serviceId);
    expect(sibling.serviceId).not.toBe(first.serviceId);
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM services WHERE origin='https://api.example.com'").first<{count:number}>())?.count).toBe(2);
  });

  it("detects recipient and price changes without creating duplicate offer slots",async()=>{
    await upsertCatalogService(env.DB,service(),"https://mpp.dev/api/services","2026-08-25T00:00:00.000Z");
    const changed=service({endpoints:[{method:"GET",path:"price",payment:{method:"tempo",intent:"charge",amount:"125",currency:"USDC",recipient:"0xtwo",methodDetails:{chainId:42431,decimals:6}}}]});
    await upsertCatalogService(env.DB,changed,"https://mpp.dev/api/services","2026-08-25T01:00:00.000Z");
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM payment_offers").first<{count:number}>())?.count).toBe(1);
    const offer=await env.DB.prepare("SELECT amount,recipient FROM payment_offers").first<{amount:string;recipient:string}>();
    expect(offer).toEqual({amount:"125",recipient:"0xtwo"});
    const fields=await env.DB.prepare("SELECT field_name,old_value,new_value FROM changes WHERE change_type='payment-offer-updated' ORDER BY field_name").all<{field_name:string;old_value:string;new_value:string}>();
    expect(fields.results).toEqual(expect.arrayContaining([{field_name:"amount",old_value:"100",new_value:"125"},{field_name:"recipient",old_value:"0xone",new_value:"0xtwo"}]));
  });

  it("filters and paginates deterministically with bounded cursors",async()=>{
    await upsertCatalogService(env.DB,service({id:"tempo-api",name:"Tempo Search"}),"https://mpp.dev/api/services","2026-08-26T00:00:00.000Z");
    await upsertCatalogService(env.DB,service({id:"evm-api",name:"EVM Search",serviceUrl:"https://evm.example.com/",endpoints:[{method:"GET",path:"data",payment:{method:"evm",intent:"charge",amount:"1",currency:"USDC",chainId:"8453"}}]}),"https://mpp.dev/api/services","2026-08-26T00:00:01.000Z");
    const filtered=await listServices(env.DB,parsePage(new URL("https://mpp.ninja/api/services?q=Tempo&method=tempo&limit=1")));
    expect(filtered.pagination).toMatchObject({limit:1,total:1,nextCursor:null});
    expect(filtered.limits).toEqual({paymentMethodsPerService:16});
    expect((filtered.data as Record<string,unknown>[])[0].name).toBe("Tempo Search");
    const page=await listServices(env.DB,parsePage(new URL("https://mpp.ninja/api/services?limit=1")));
    expect((page.pagination as Record<string,unknown>).nextCursor).toBeTypeOf("string");

    const longLiteral="%_".repeat(60);
    const longSearch=await listServices(env.DB,parsePage(new URL(`https://mpp.ninja/api/services?q=${encodeURIComponent(longLiteral)}`)));
    expect(longSearch.pagination).toMatchObject({total:0,nextCursor:null});
  });

  it("returns bounded active provenance with endpoint collection rows",async()=>{
    const sourceRef="https://mpp.dev/api/services";
    const {serviceId,endpointIds}=await upsertCatalogService(env.DB,service({id:"endpoint-provenance",serviceUrl:"https://endpoint-provenance.example/"}),sourceRef,"2026-08-27T00:00:00.000Z");
    await env.DB.prepare("INSERT INTO endpoint_sources (endpoint_id,source_type,source_ref,first_seen,last_seen,observed_at,active) VALUES (?,'openapi','https://endpoint-provenance.example/withdrawn.json','2026-08-26','2026-08-26','2026-08-26',0)").bind(endpointIds[0]).run();

    const result=await listEndpoints(env.DB,new URL(`https://mpp.ninja/api/endpoints?service=${serviceId}`));
    expect(result.pagination).toMatchObject({total:1,nextCursor:null});
    expect(result.data).toEqual([
      expect.objectContaining({
        id:endpointIds[0],
        activeSources:[{type:"catalog",ref:sourceRef,firstSeen:"2026-08-27T00:00:00.000Z",lastSeen:"2026-08-27T00:00:00.000Z"}],
        activeSourcePagination:{limit:32,total:1,truncated:false},
      }),
    ]);
  });
});
