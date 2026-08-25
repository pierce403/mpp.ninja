import { describe,expect,it } from "vitest";

import { parseMppScanOriginUrls } from "../src/mppscan";
import { MAX_DISCOVERY_BYTES,ScanSafetyError } from "../src/security";

describe("MPPScan anonymous discovery parser",()=>{
  it("extracts only the exact escaped hydration array and deduplicates canonical public URLs",()=>{
    const payload=JSON.stringify({originUrls:["https://api.example.com","https://api.example.com/","https://other.example/mpp/","http://127.0.0.1/","ftp://bad.example/"]});
    const html=`<a href="https://must-not-crawl.example/">link</a><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;
    expect(parseMppScanOriginUrls(html)).toEqual(["https://api.example.com/","https://other.example/mpp/"]);
  });

  it("accepts a direct JSON marker while rejecting query-bearing and credentialed candidates",()=>{
    const html='<script type="application/json">{"originUrls":["https://safe.example/base","https://safe.example/base?token=secret","https://user:pass@safe.example/"]}</script>';
    expect(parseMppScanOriginUrls(html)).toEqual(["https://safe.example/base"]);
  });

  it("returns no targets for arbitrary links or malformed arrays",()=>{
    expect(parseMppScanOriginUrls('<a href="https://api.example/">API</a>')).toEqual([]);
    expect(parseMppScanOriginUrls('<script>{"originUrls":[not-json]}</script>')).toEqual([]);
  });

  it("fails closed when the public source exceeds the discovery limit",()=>{
    expect(()=>parseMppScanOriginUrls("x".repeat(MAX_DISCOVERY_BYTES+1))).toThrowError(ScanSafetyError);
  });
});
