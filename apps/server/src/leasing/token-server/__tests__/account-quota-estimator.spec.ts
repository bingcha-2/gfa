import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_QUOTA_ESTIMATOR_TOMBSTONE_TTL_SECONDS,
  ACCOUNT_QUOTA_ESTIMATOR_TTL_SECONDS,
  AccountQuotaEstimator,
  quotaEstimatorAccountKey,
  quotaEstimatorSnapshotFromInputs,
} from "../account-quota-estimator";

type Command = { name: "eval" | "hgetall"; args: any[] };

class FakeRedis {
  commands: Command[] = [];
  pipelineExecutions = 0;
  hashes = new Map<string, Record<string, string>>();
  deleted: string[] = [];
  tombstones: Array<{ key: string; ttl: string }> = [];
  initialized = new Set<string>();
  evalResults: unknown[] = [];
  on = vi.fn();
  quit = vi.fn(async () => "OK");
  disconnect = vi.fn();

  pipeline() {
    const queued: Command[] = [];
    const chain = {
      eval: (...args: any[]) => { queued.push({ name: "eval", args }); return chain; },
      hgetall: (...args: any[]) => { queued.push({ name: "hgetall", args }); return chain; },
      exec: async () => {
        this.pipelineExecutions++;
        this.commands.push(...queued);
        return queued.map((command): [Error | null, unknown] => {
          if (command.name === "hgetall") {
            return [null, this.hashes.get(String(command.args[0])) || {}];
           }
           const key = String(command.args[2]);
          const tombstone = String(command.args[3]);
          const hourlyRemainingBps = Number(command.args[11]);
          const weeklyRemainingBps = Number(command.args[15]);
          if (this.evalResults.length) return [null, this.evalResults.shift()];
          if (this.tombstones.some((entry) => entry.key === tombstone)) {
            return [null, [0, 0, 0, 0, 0]];
          }
          if (!this.initialized.has(key) && hourlyRemainingBps < 0 && weeklyRemainingBps < 0) {
            return [null, [0, 0, 0, 0, 0]];
          }
          this.initialized.add(key);
          return [null, [1, 1, 1, 1, 1]];
        });
      },
    };
    return chain;
  }

  async del(key: string) {
    this.deleted.push(key);
    this.hashes.delete(key);
    this.initialized.delete(key);
    return 1;
  }

  async eval(_script: string, _keyCount: number, key: string, tombstone: string, ttl: string) {
    this.deleted.push(key);
    this.hashes.delete(key);
    this.initialized.delete(key);
    this.tombstones.push({ key: tombstone, ttl });
    return 1;
  }
}

const snapshot = quotaEstimatorSnapshotFromInputs([{
  modelKey: "codex",
  hourlyPercent: 80,
  weeklyPercent: 60,
  hourlyResetAt: new Date("2030-01-01T05:00:00Z"),
  weeklyResetAt: new Date("2030-01-07T00:00:00Z"),
}], Date.parse("2030-01-01T00:00:00Z"))!;

describe("AccountQuotaEstimator", () => {
  it("builds a deterministic privacy-safe account key", () => {
    const first = quotaEstimatorAccountKey("CODEX", " Mother@Example.com ", "test-secret");
    const second = quotaEstimatorAccountKey("codex", "mother@example.com", "test-secret");

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{32}$/);
    expect(first).not.toContain("mother");
  });

  it("does not initialize a missing Redis account from usage alone", async () => {
    const redis = new FakeRedis();
    const estimator = new AccountQuotaEstimator(redis as any, { autoStart: false });
    estimator.recordReport({
      provider: "codex",
      accountKey: "account-a",
      accountId: 1,
      apiValueUsd: 1.25,
    });

    await estimator.flush();

    expect(redis.initialized.size).toBe(0);
    expect(redis.commands[0].args[4]).toBe(String(ACCOUNT_QUOTA_ESTIMATOR_TTL_SECONDS));
  });

  it("initializes from a snapshot and carries returned epochs into later usage", async () => {
    const redis = new FakeRedis();
    const estimator = new AccountQuotaEstimator(redis as any, { autoStart: false });
    estimator.recordSnapshot({
      provider: "codex",
      accountKey: "account-a",
      accountId: 1,
      snapshot,
    });
    await estimator.flush();

    estimator.recordReport({
      provider: "codex",
      accountKey: "account-a",
      accountId: 1,
      apiValueUsd: 2,
    });
    await estimator.flush();

    const usageCommand = redis.commands[1];
    expect(usageCommand.args[9]).toBe("1");
    expect(usageCommand.args[10]).toBe("1");
    expect(usageCommand.args[8]).toBe("2000000");
  });

  it("keeps request cost after a cached snapshot that predates the request", async () => {
    const redis = new FakeRedis();
    const estimator = new AccountQuotaEstimator(redis as any, { autoStart: false });
    estimator.recordReport({
      provider: "codex",
      accountKey: "account-a",
      accountId: 1,
      apiValueUsd: 2,
      usageOccurredAt: snapshot.observedAt + 1_000,
      snapshot,
    });

    await estimator.flush();

    const command = redis.commands[0];
    expect(command.args[7]).toBe("0");
    expect(command.args[8]).toBe("2000000");
  });

  it("moves cached-snapshot usage through a newer snapshot in the same batch", async () => {
    const redis = new FakeRedis();
    const estimator = new AccountQuotaEstimator(redis as any, { autoStart: false });
    estimator.recordReport({
      provider: "codex",
      accountKey: "account-a",
      accountId: 1,
      apiValueUsd: 2,
      usageOccurredAt: snapshot.observedAt + 1_000,
      snapshot,
    });
    estimator.recordSnapshot({
      provider: "codex",
      accountKey: "account-a",
      accountId: 1,
      snapshot: { ...snapshot, observedAt: snapshot.observedAt + 2_000 },
    });

    await estimator.flush();

    const command = redis.commands[0];
    expect(command.args[7]).toBe("2000000");
    expect(command.args[8]).toBe("0");
  });

  it("splits usage around an intermediate snapshot even when an older snapshot arrives late", async () => {
    const redis = new FakeRedis();
    const estimator = new AccountQuotaEstimator(redis as any, { autoStart: false });
    estimator.recordReport({
      provider: "codex",
      accountKey: "account-a",
      accountId: 1,
      apiValueUsd: 1,
      usageOccurredAt: snapshot.observedAt + 100,
    });
    estimator.recordSnapshot({
      provider: "codex",
      accountKey: "account-a",
      accountId: 1,
      snapshot: { ...snapshot, observedAt: snapshot.observedAt + 200 },
    });
    estimator.recordReport({
      provider: "codex",
      accountKey: "account-a",
      accountId: 1,
      apiValueUsd: 2,
      usageOccurredAt: snapshot.observedAt + 300,
      snapshot,
    });

    await estimator.flush();

    const command = redis.commands[0];
    expect(command.args[7]).toBe("1000000");
    expect(command.args[8]).toBe("2000000");
    expect(command.args[13]).toBe(String(snapshot.observedAt + 200));
  });

  it("passes an explicit Codex reset to the five-hour scope only", async () => {
    const redis = new FakeRedis();
    const estimator = new AccountQuotaEstimator(redis as any, { autoStart: false });
    estimator.recordSnapshot({
      provider: "codex",
      accountKey: "account-a",
      accountId: 1,
      snapshot: { ...snapshot, forceFiveHourReset: true },
    });

    await estimator.flush();

    expect(redis.commands[0].args[14]).toBe("1");
    expect(redis.commands[0].args[18]).toBe("0");
  });

  it("holds a successful manual reset until a post-reset snapshot", async () => {
    const redis = new FakeRedis();
    const estimator = new AccountQuotaEstimator(redis as any, { autoStart: false });
    estimator.markReset({
      provider: "codex",
      accountKey: "account-a",
      fiveHour: true,
      resetOccurredAt: snapshot.observedAt + 1,
    });
    estimator.recordSnapshot({
      provider: "codex", accountKey: "account-a", accountId: 1, snapshot,
    });
    await estimator.flush();

    estimator.recordSnapshot({
      provider: "codex",
      accountKey: "account-a",
      accountId: 1,
      snapshot: { ...snapshot, observedAt: snapshot.observedAt + 1 },
    });
    await estimator.flush();

    estimator.recordSnapshot({
      provider: "codex",
      accountKey: "account-a",
      accountId: 1,
      snapshot: { ...snapshot, observedAt: snapshot.observedAt + 2 },
    });
    await estimator.flush();

    expect(redis.commands[0].args[14]).toBe("0");
    expect(redis.commands[1].args[14]).toBe("1");
    expect(redis.commands[2].args[14]).toBe("0");
  });

  it("re-anchors only the scope whose usage missed a changed epoch", async () => {
    const redis = new FakeRedis();
    const estimator = new AccountQuotaEstimator(redis as any, { autoStart: false });
    estimator.recordSnapshot({ provider: "codex", accountKey: "account-a", accountId: 1, snapshot });
    await estimator.flush();

    redis.evalResults.push([1, 2, 1, 0, 1]);
    estimator.recordReport({
      provider: "codex", accountKey: "account-a", accountId: 1, apiValueUsd: 2,
    });
    await estimator.flush();

    estimator.recordSnapshot({ provider: "codex", accountKey: "account-a", accountId: 1, snapshot: {
      ...snapshot,
      observedAt: snapshot.observedAt + 1,
      fiveHourRemainingBps: snapshot.fiveHourRemainingBps! - 500,
      weeklyRemainingBps: snapshot.weeklyRemainingBps! - 500,
    } });
    await estimator.flush();

    const recoveryCommand = redis.commands[2];
    expect(recoveryCommand.args[19]).toBe("1");
    expect(recoveryCommand.args[20]).toBe("0");
    expect(estimator.diagnostics().epochMismatches).toBe(1);
  });

  it("reads fixed hash state without issuing a TTL-renewing command", async () => {
    const redis = new FakeRedis();
    const estimator = new AccountQuotaEstimator(redis as any, { autoStart: false });
    const key = "gfa:quota-estimator:v1:{codex:account-a}";
    redis.hashes.set(key, {
      h_epoch: "2",
      h_last_remaining_bps: "7500",
      h_reset_at: "1234",
      h_epoch_used_micros: "12500000",
      h_estimate_micros: "50000000",
      h_sample_count: "3",
      h_sample_burn_bps: "3000",
      h_observed_at: "2000",
      h_last_sample_at: "1900",
    });

    const states = await estimator.readMany([{ provider: "codex", accountKey: "account-a" }]);

    expect(states.get("codex:account-a")?.fiveHour).toMatchObject({
      epoch: 2,
      remainingPercent: 75,
      trackedUsedUsd: 12.5,
      inferredTotalUsd: 50,
      confidence: "high",
    });
    expect(redis.commands.map((command) => command.name)).toEqual(["hgetall"]);
  });

  it("chunks large reads without dropping account states", async () => {
    const redis = new FakeRedis();
    const estimator = new AccountQuotaEstimator(redis as any, { autoStart: false });
    const accounts = Array.from({ length: 251 }, (_, index) => ({
      provider: "codex" as const,
      accountKey: `account-${index}`,
    }));
    for (const account of accounts) {
      redis.hashes.set(`gfa:quota-estimator:v1:{codex:${account.accountKey}}`, {
        h_epoch: "1",
        h_last_remaining_bps: "5000",
        h_observed_at: "2000",
      });
    }

    const states = await estimator.readMany(accounts);

    expect(redis.pipelineExecutions).toBe(2);
    expect(redis.commands).toHaveLength(251);
    expect(states).toHaveLength(251);
  });

  it("deletes local state and the single Redis hash for a removed account", async () => {
    const redis = new FakeRedis();
    const estimator = new AccountQuotaEstimator(redis as any, { autoStart: false });
    estimator.recordSnapshot({
      provider: "anthropic",
      accountKey: "account-b",
      accountId: 2,
      snapshot,
    });

    await estimator.deleteAccount("anthropic", "account-b");
    await estimator.flush();

    expect(redis.deleted).toEqual(["gfa:quota-estimator:v1:{anthropic:account-b}"]);
    expect(redis.tombstones).toEqual([{
      key: "gfa:quota-estimator-deleted:v1:{anthropic:account-b}",
      ttl: String(ACCOUNT_QUOTA_ESTIMATOR_TOMBSTONE_TTL_SECONDS),
    }]);
    expect(redis.commands).toHaveLength(0);
  });

  it("does not let a late snapshot recreate an account during the deletion grace period", async () => {
    const redis = new FakeRedis();
    const estimator = new AccountQuotaEstimator(redis as any, { autoStart: false });

    await estimator.deleteAccount("codex", "account-a");
    estimator.recordSnapshot({ provider: "codex", accountKey: "account-a", accountId: 1, snapshot });
    await estimator.flush();

    expect(redis.initialized).not.toContain("gfa:quota-estimator:v1:{codex:account-a}");
  });
});
