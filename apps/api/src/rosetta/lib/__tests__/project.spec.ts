import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../google-api", () => ({
  getAccessToken: vi.fn(),
  discoverProject: vi.fn(),
}));

import { discoverProject, getAccessToken } from "../../google-api";
import { runConcurrent, tryDiscoverProject } from "../project";

const ctx: any = { tokenCache: new Map(), logger: { log: vi.fn(), warn: vi.fn() } };

beforeEach(() => vi.clearAllMocks());

describe("runConcurrent", () => {
  it("processes every item", async () => {
    const seen: number[] = [];
    await runConcurrent([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n); });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never exceeds the concurrency limit in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await runConcurrent([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("handles an empty list without calling fn", async () => {
    const fn = vi.fn(async () => {});
    await runConcurrent([], 4, fn);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("tryDiscoverProject", () => {
  it("returns early (no token call) when the account has no refreshToken", async () => {
    const acc: any = { id: 1, email: "a@b.c" };
    await tryDiscoverProject(ctx, acc);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(acc.projectId).toBeUndefined();
  });

  it("writes projectId + planType on a successful discovery", async () => {
    vi.mocked(getAccessToken).mockResolvedValue("tok" as any);
    vi.mocked(discoverProject).mockResolvedValue({ projectId: "proj-1", planType: "pro" } as any);
    const acc: any = { id: 7, email: "x@y.z", refreshToken: "rt" };

    await tryDiscoverProject(ctx, acc);

    expect(getAccessToken).toHaveBeenCalledWith(7, "rt", ctx.tokenCache);
    expect(acc).toMatchObject({ projectId: "proj-1", projectIdSource: "api", planType: "pro" });
  });

  it("leaves the account untouched when no projectId comes back", async () => {
    vi.mocked(getAccessToken).mockResolvedValue("tok" as any);
    vi.mocked(discoverProject).mockResolvedValue({} as any);
    const acc: any = { id: 8, email: "x@y.z", refreshToken: "rt" };
    await tryDiscoverProject(ctx, acc);
    expect(acc.projectId).toBeUndefined();
  });

  it("swallows errors (logs a warning, does not throw)", async () => {
    vi.mocked(getAccessToken).mockRejectedValue(new Error("boom"));
    const acc: any = { id: 9, email: "x@y.z", refreshToken: "rt" };
    await expect(tryDiscoverProject(ctx, acc)).resolves.toBeUndefined();
    expect(ctx.logger.warn).toHaveBeenCalled();
    expect(acc.projectId).toBeUndefined();
  });
});
