import "reflect-metadata";
import { afterEach, expect, it, vi } from "vitest";
import { getApiPriceSnapshots, installApiPriceSnapshots } from "@gfa/shared";
import { PricingService } from "./pricing.module";
const model={modalities:{output:["text"]},cost:{input:1,output:5}};
const data={anthropic:{models:{claude:model}},openai:{models:{gpt:model}},google:{models:{gemini:model}}};
afterEach(()=>{vi.unstubAllGlobals();installApiPriceSnapshots([]);});
it("persists a validated snapshot before publishing, restores it and retains it offline",async()=>{
 let saved:any;
 const db={siteSetting:{findUnique:vi.fn(async()=>saved?{value:saved}:null),upsert:vi.fn(async(a:any)=>{saved=a.create.value;})}};
 const fetcher=vi.fn(async()=>new Response(JSON.stringify(data)));vi.stubGlobal("fetch",fetcher);
 const service=new PricingService(db as any);await service.onModuleInit();
 expect(getApiPriceSnapshots()).toHaveLength(1);expect(db.siteSetting.upsert).toHaveBeenCalledOnce();
 const old=JSON.stringify(getApiPriceSnapshots());installApiPriceSnapshots([]);
 await new PricingService(db as any).onModuleInit();expect(JSON.stringify(getApiPriceSnapshots())).toBe(old);
 expect(fetcher).toHaveBeenCalledOnce();
 const parsed=JSON.parse(saved);parsed.syncedAt=0;saved=JSON.stringify(parsed);
 fetcher.mockRejectedValueOnce(new Error("offline"));await new PricingService(db as any).onModuleInit();
 expect(JSON.stringify(getApiPriceSnapshots())).toBe(old);
});
it("does not publish data whose database write failed",async()=>{
 vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(data))));
 const db={siteSetting:{findUnique:vi.fn(async()=>null),upsert:vi.fn(async()=>{throw new Error("disk full");})}};
 await new PricingService(db as any).onModuleInit();expect(getApiPriceSnapshots()).toEqual([]);
});
