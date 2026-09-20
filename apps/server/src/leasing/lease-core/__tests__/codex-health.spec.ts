import { describe,it,expect } from "vitest";
import { readCodexDiagnostic,codexHealthKind } from "../codex-health";

describe("Codex health classification",()=>{
  it.each([
    [200,"failed","invalid_prompt","invalid_prompt"],
    [200,"failed","server_is_overloaded","capacity"],
    [200,"failed","rate_limit_exceeded","rate_limit"],
    [429,"failed","usage_limit_reached","quota"],
    [200,"failed","invalid_encrypted_content","context_error"],
    [200,"missing_completion","","transport"],
    [200,"incomplete","max_output_tokens","incomplete"],
  ])("classifies %s/%s/%s",(status,result,errorCode,expected)=>{
    expect(codexHealthKind(Number(status),readCodexDiagnostic({result,errorCode})!)).toBe(expected);
  });
  it("only accepts bounded metadata and treats absent models as unknown",()=>{
    const d=readCodexDiagnostic({result:"completed",sentModel:"gpt-6-astra",upstreamModel:"",requestId:"unsafe\ncontent",sessionHash:"raw-session",state:"SECRET"})!;
    expect(d.requestId).toBe(""); expect(d.sessionHash).toBe(""); expect(JSON.stringify(d)).not.toContain("SECRET");
    expect(codexHealthKind(200,d)).toBe("completed");
    expect(codexHealthKind(200,{...d,upstreamModel:"gpt-5.6-luna"})).toBe("model_mismatch");
    expect(codexHealthKind(200,{...d,result:"missing_completion",observationLimited:true})).toBe("observation_limited");
  });
});
