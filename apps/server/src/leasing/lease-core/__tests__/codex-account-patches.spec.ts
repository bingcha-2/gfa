import { describe, expect, it } from "vitest";
import { CodexAccountPatches } from "../codex-account-patches";

const account = () => ({
  id: 1, email: "test@example.invalid", codexCredentialVersion: "generation-1",
  accessToken: "access-1", accessTokenExpiresAt: 100, refreshToken: "refresh-1", sessionToken: "session-1",
  alias: "original", quotaStatus: "ok", nested: { remaining: 10 },
});

describe("CodexAccountPatches", () => {
  it("merges only changed fields into the latest disk account", () => {
    const patches = new CodexAccountPatches();
    const before = account();
    patches.record(before, { ...before, quotaStatus: "error", blockedUntil: 123 });
    const disk = { ...before, alias: "admin edit", enabled: false };
    expect(patches.apply([disk])).toEqual([{ ...disk, quotaStatus: "error", blockedUntil: 123 }]);
    expect(disk).toEqual({ ...before, alias: "admin edit", enabled: false });
  });

  it("keeps the first baseline and latest target across repeated edits", () => {
    const patches = new CodexAccountPatches();
    const before = account();
    const first = { ...before, quotaStatus: "cooling" };
    patches.record(before, first);
    patches.record(first, { ...first, quotaStatus: "error" });
    expect(patches.apply([before])).toEqual([{ ...before, quotaStatus: "error" }]);
    expect(patches.apply([{ ...before, quotaStatus: "admin hold" }])).toEqual([{ ...before, quotaStatus: "admin hold" }]);
  });

  it("drops a patch when a later edit returns to the original value", () => {
    const patches = new CodexAccountPatches();
    const before = account();
    const edited = { ...before, quotaStatus: "error" };
    patches.record(before, edited);
    patches.record(edited, before);
    const disk = { ...before, quotaStatus: "admin hold" };
    expect(patches.apply([disk])).toEqual([disk]);
  });

  it("rebases a fresh update after a disk conflict without replacing other pending baselines", () => {
    const patches = new CodexAccountPatches();
    const before = account();
    patches.record(before, { ...before, nested: { remaining: 20 }, quotaStatus: "error" });
    const disk = { ...before, nested: { remaining: 30 } };
    const reloaded = patches.apply([disk])[0] as ReturnType<typeof account>;
    expect(reloaded).toEqual({ ...disk, quotaStatus: "error" });
    patches.record(reloaded, { ...reloaded, nested: { remaining: 40 } });
    expect(patches.apply([disk])).toEqual([{ ...disk, nested: { remaining: 40 }, quotaStatus: "error" }]);
    // The rebased CAS still cannot overwrite a newer competing disk change.
    expect(patches.apply([{ ...disk, nested: { remaining: 50 } }])).toEqual([
      { ...disk, nested: { remaining: 50 }, quotaStatus: "error" },
    ]);
  });

  it("preserves quota and hold patches across normal OAuth rotation but rejects stale token clears", () => {
    const patches = new CodexAccountPatches();
    const before = account();
    patches.record(before, { ...before, accessToken: "", accessTokenExpiresAt: 0, quotaStatus: "error", nested: { remaining: 3 } });
    const rotated = { ...before, accessToken: "access-2", accessTokenExpiresAt: 200, refreshToken: "refresh-2" };
    expect(patches.apply([rotated])).toEqual([{ ...rotated, quotaStatus: "error", nested: { remaining: 3 } }]);
  });

  it.each(["refreshToken", "accessToken", "accessTokenExpiresAt", "sessionToken", "idToken"])(
    "rejects every pending credential field when %s changed externally", (key) => {
      const patches = new CodexAccountPatches();
      const before = account();
      patches.record(before, { ...before, accessToken: "", accessTokenExpiresAt: 0 });
      const disk = { ...before, [key]: key === "accessTokenExpiresAt" ? 200 : "new-value" };
      expect(patches.apply([disk])).toEqual([disk]);
    },
  );

  it.each([{ email: "replacement@example.invalid" }, { codexCredentialVersion: "generation-2" }])(
    "drops all pending changes when the account identity or authorization generation changed: %j", (change) => {
      const patches = new CodexAccountPatches();
      const before = account();
      patches.record(before, { ...before, quotaStatus: "error", accessToken: "" });
      const disk = { ...before, ...change };
      expect(patches.apply([disk])).toEqual([disk]);
    },
  );

  it("does not re-add deleted accounts or modify unrelated accounts", () => {
    const patches = new CodexAccountPatches();
    const before = account();
    patches.record(before, { ...before, quotaStatus: "error" });
    const other = { ...before, id: 2 };
    expect(patches.apply([other])).toEqual([other]);
    expect(patches.apply([])).toEqual([]);
  });

  it("deeply snapshots inputs and can replay without consuming patches or sharing output references", () => {
    const patches = new CodexAccountPatches();
    const before = account();
    const after = { ...before, nested: { remaining: 5 } };
    patches.record(before, after);
    before.nested.remaining = 999;
    after.nested.remaining = 888;
    const disk = account();
    const applied = patches.apply([disk]) as Array<ReturnType<typeof account>>;
    expect(applied[0].nested.remaining).toBe(5);
    expect(disk.nested.remaining).toBe(10);
    applied[0].nested.remaining = 777;
    expect(patches.apply([disk])).toEqual([{ ...disk, nested: { remaining: 5 } }]);
    expect(patches.apply(patches.apply([disk]))).toEqual([{ ...disk, nested: { remaining: 5 } }]);
  });

  it("handles deleted fields and preserves a conflicting administrator edit", () => {
    const patches = new CodexAccountPatches();
    const before: Record<string, unknown> = account();
    const after = { ...before };
    delete after.alias;
    patches.record(before, after);
    expect(patches.apply([before])).toEqual([after]);
    expect(patches.apply([{ ...before, alias: "new alias" }])).toEqual([{ ...before, alias: "new alias" }]);
  });

  it("groups separate credential edits against the same initial credential stamp", () => {
    const patches = new CodexAccountPatches();
    const before = account();
    const first = { ...before, accessToken: "" };
    patches.record(before, first);
    patches.record(first, { ...first, accessTokenExpiresAt: 0 });
    expect(patches.apply([before])).toEqual([{ ...before, accessToken: "", accessTokenExpiresAt: 0 }]);
  });

  it("accepts a new credential mutation based on a newly rotated token without losing pending quota changes", () => {
    const patches = new CodexAccountPatches();
    const before = account();
    patches.record(before, { ...before, accessToken: "", accessTokenExpiresAt: 0, quotaStatus: "error" });
    const rotated = { ...before, accessToken: "access-2", accessTokenExpiresAt: 200, refreshToken: "refresh-2", quotaStatus: "error" };
    patches.record(rotated, { ...rotated, accessToken: "", accessTokenExpiresAt: 0 });
    const disk = { ...rotated, quotaStatus: "ok" };
    expect(patches.apply([disk])).toEqual([{ ...rotated, accessToken: "", accessTokenExpiresAt: 0 }]);
  });

  it("forgets persisted changes only when explicitly cleared", () => {
    const patches = new CodexAccountPatches();
    const before = account();
    patches.record(before, { ...before, quotaStatus: "error" });
    patches.clear();
    expect(patches.apply([before])).toEqual([before]);
  });
});
