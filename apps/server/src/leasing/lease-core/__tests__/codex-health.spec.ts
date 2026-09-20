import { describe,it,expect } from "vitest";
import { readCodexDiagnostic,codexHealthKind, readCodexAccountRestriction, codexAccountRestrictionCode } from "../codex-health";

describe("Codex health classification",()=>{
  it.each([
    [200,"failed","invalid_prompt","invalid_prompt"],
    [200,"failed","account_deactivated","account_disabled"],
    [400,"failed","account_deactivated","account_disabled"],
    [403,"failed","account_verification_required","verification_required"],
    [200,"failed","phone_verification_required","verification_required"],
    [403,"failed","permission_denied","upstream_error"],
    [403,"failed","verification_failed","upstream_error"],
    [200,"failed","server_is_overloaded","capacity"],
    [200,"failed","rate_limit_exceeded","rate_limit"],
    [429,"failed","usage_limit_reached","quota"],
    [200,"failed","invalid_encrypted_content","context_error"],
    [200,"missing_completion","","transport"],
    [200,"incomplete","max_output_tokens","incomplete"],
  ])("classifies %s/%s/%s",(status,result,errorCode,expected)=>{
    expect(codexHealthKind(Number(status),readCodexDiagnostic({result,errorCode})!)).toBe(expected);
  });
  it("accepts exact legacy error wrappers but never prose or generic permission errors",()=>{
    expect(codexAccountRestrictionCode("http_403_account_deactivated")).toBe("account_deactivated");
    for (const value of ["<html>account_deactivated</html>", "possibly account_deactivated", "access_denied", "suspended", "permission_denied"]) {
      expect(codexAccountRestrictionCode(value)).toBe("");
    }
    expect(readCodexAccountRestriction({quotaStatus:"error",quotaStatusReason:"account_deactivated"})).toBe("account_disabled");
    expect(readCodexAccountRestriction({quotaStatus:"cooling",quotaStatusReason:"account_deactivated"})).toBeUndefined();
    expect(readCodexAccountRestriction({quotaStatus:"error",quotaStatusReason:"verification_required",blockedUntil:1})).toBe("verification_required");
    expect(codexHealthKind(200, readCodexDiagnostic({result:"completed",errorCode:"account_deactivated"})!)).toBe("completed");
  });
  it("only accepts bounded metadata and treats absent models as unknown",()=>{
    const d=readCodexDiagnostic({result:"completed",sentModel:"gpt-6-astra",upstreamModel:"",requestId:"unsafe\ncontent",sessionHash:"raw-session",state:"SECRET"})!;
    expect(d.requestId).toBe(""); expect(d.sessionHash).toBe(""); expect(JSON.stringify(d)).not.toContain("SECRET");
    expect(codexHealthKind(200,d)).toBe("completed");
    expect(codexHealthKind(200,{...d,upstreamModel:"gpt-5.6-luna"})).toBe("model_mismatch");
    expect(codexHealthKind(200,{...d,result:"missing_completion",observationLimited:true})).toBe("observation_limited");
  });
});
