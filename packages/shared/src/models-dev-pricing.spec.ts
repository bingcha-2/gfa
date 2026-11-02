import { afterEach, describe, expect, it } from "vitest";
import { modelsDevRegistry } from "./models-dev-pricing";
import { calculateApiValue, installApiPriceSnapshots, requireApiValue, type ApiValueUsage } from "./api-pricing";
const model = (input = 3) => ({modalities: {output:["text"]}, cost:{input,output:15,cache_read:.3,cache_write:3.75}});
const catalog = () => ({anthropic:{models:{"claude-test":model()}},openai:{models:{"gpt-test":model()}},google:{models:{"gemini-test":model()}}});
const base:ApiValueUsage={provider:"anthropic",modelId:"claude-test",pricingMode:"standard",inputTokens:1e6,outputTokens:0,cachedInputTokens:0,cacheWrite5mTokens:0,cacheWrite1hTokens:0,contextTokens:0,occurredAt:2000};
afterEach(()=>installApiPriceSnapshots([]));
describe("automatic reference prices",()=>{
 it("freezes version by occurrence time and never changes earlier records",()=>{
  const a=modelsDevRegistry(catalog(),"a",1000);const next=catalog();next.anthropic.models["claude-test"]=model(4);
  installApiPriceSnapshots([a,modelsDevRegistry(next,"b",3000)]);
  expect(requireApiValue(base)).toMatchObject({usd:3,pricingVersion:"a"});
  expect(requireApiValue({...base,occurredAt:4000})).toMatchObject({usd:4,pricingVersion:"b"});
 });
 it("keeps cached input and five-minute/one-hour writes distinct",()=>{
  installApiPriceSnapshots([modelsDevRegistry(catalog(),"a",1000)]);
  expect(requireApiValue({...base,inputTokens:0,cachedInputTokens:1e6,cacheWrite5mTokens:1e6,cacheWrite1hTokens:1e6}).usd).toBe(10.05);
 });
 it("uses the separately published flat priority table without standard-tier multipliers",()=>{
  const data:any=catalog();data.openai.models["gpt-test"].cost.tiers=[{input:6,output:30,cache_read:.6,tier:{type:"context",size:272000}}];
  data.openai.models["gpt-test"].experimental={modes:{fast:{cost:{input:7,output:35}}}};
  installApiPriceSnapshots([modelsDevRegistry(data,"a",1000)]);
  expect(requireApiValue({...base,provider:"codex",modelId:"gpt-test",contextTokens:272001}).usd).toBe(6);
  expect(requireApiValue({...base,provider:"codex",modelId:"gpt-test",pricingMode:"priority",contextTokens:272001}).usd).toBe(7);
 });
 it("rejects missing catalogs and zero placeholders, never substitutes another model",()=>{
  expect(()=>modelsDevRegistry({},"a",1000)).toThrow();
  const data=catalog();data.anthropic.models["claude-test"].cost.input=0;data.anthropic.models["claude-test"].cost.output=0;
  expect(()=>modelsDevRegistry(data,"a",1000)).toThrow();
  installApiPriceSnapshots([modelsDevRegistry(catalog(),"a",1000)]);
  expect(calculateApiValue({...base,modelId:"unknown"}).usd).toBe(0);
  expect(()=>requireApiValue({...base,modelId:"unknown"})).toThrow();
 });
});
