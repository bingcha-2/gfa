import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CaptchaService } from "../captcha.service";
import { readJson, writeJson } from "../lib/store";

let dir: string;
let automation: any;
let logger: any;
let svc: CaptchaService;

const captchaFile = () => path.join(dir, "captcha-unblock.json");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "captcha-spec-"));
  automation = {
    startAutomation: vi.fn(async () => ({ taskId: "auto-1" })),
    getTaskStatus: vi.fn(async () => ({ status: "SUCCESS" })),
  };
  logger = { warn: vi.fn(), log: vi.fn() };
  svc = new CaptchaService({ dataDir: dir, automation, logger });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("createCaptchaUnblock", () => {
  it("rejects when email/password are missing", async () => {
    expect(await svc.createCaptchaUnblock({})).toEqual({ ok: false, error: "email and password required" });
    expect(automation.startAutomation).not.toHaveBeenCalled();
  });

  it("creates + persists a task, submits to automation, and marks it RUNNING", async () => {
    const r = await svc.createCaptchaUnblock({ credentials: { email: "u@x.com", password: "pw", totpSecret: "TOTP" } });
    expect(r.ok).toBe(true);
    expect(String(r.taskId)).toMatch(/^unblock_/);
    expect(r.email).toBe("u@x.com");

    expect(automation.startAutomation).toHaveBeenCalledWith(
      "oauth",
      expect.objectContaining({ email: "u@x.com", password: "pw", totpSecret: "TOTP" }),
      expect.anything(),
      undefined,
      expect.objectContaining({ source: "captcha-unblock", keepBrowserOpenOnChallenge: true }),
    );

    const data = readJson(captchaFile(), { tasks: [] });
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]).toMatchObject({ email: "u@x.com", taskId: "auto-1", status: "RUNNING" });
  });

  it("accepts the accounts[] payload shape (and its phone)", async () => {
    const r = await svc.createCaptchaUnblock({
      accounts: [{ email: "a@b.c", password: "pw", phone: "+1555", smsUrl: "http://sms" }],
    });
    expect(r.ok).toBe(true);
    const data = readJson(captchaFile(), { tasks: [] });
    expect(data.tasks[0].phones).toEqual([{ phoneNumber: "+1555", smsUrl: "http://sms" }]);
  });

  it("still creates the task (PENDING-ish) when there is no automation service", async () => {
    const solo = new CaptchaService({ dataDir: dir, automation: undefined, logger });
    const r = await solo.createCaptchaUnblock({ credentials: { email: "u@x.com", password: "pw" } });
    expect(r.ok).toBe(true);
    const data = readJson(captchaFile(), { tasks: [] });
    expect(data.tasks[0].status).toBe("PENDING"); // never submitted → stays PENDING
  });
});

describe("getCaptchaUnblockStatus", () => {
  it("syncs a RUNNING task to APPEAL_REQUIRED on upstream SUCCESS (first phase)", async () => {
    await svc.createCaptchaUnblock({ credentials: { email: "u@x.com", password: "pw" } });
    const res = await svc.getCaptchaUnblockStatus();
    expect(res.ok).toBe(true);
    expect(automation.getTaskStatus).toHaveBeenCalledWith("auto-1");
    expect(res.tasks[0].status).toBe("APPEAL_REQUIRED");
  });
});

describe("retryCaptchaUnblock", () => {
  it("returns not-found for an unknown task id", async () => {
    expect(await svc.retryCaptchaUnblock({ taskId: "nope" })).toEqual({ ok: false, error: "task not found" });
  });

  it("resets a known task and re-submits it", async () => {
    const created = await svc.createCaptchaUnblock({ credentials: { email: "u@x.com", password: "pw" } });
    automation.startAutomation.mockClear();
    const r = await svc.retryCaptchaUnblock({ taskId: created.taskId });
    expect(r).toEqual({ ok: true, taskId: created.taskId });
    expect(automation.startAutomation).toHaveBeenCalledTimes(1);
  });
});

describe("unblockLocation", () => {
  it("clears location_unsupported markers and counts them", () => {
    writeJson(path.join(dir, "accounts.json"), {
      accounts: [
        { id: 1, quotaStatusReason: "location_unsupported", quotaStatus: "blocked", blockedUntil: 123 },
        { id: 2, quotaStatusReason: "other" },
      ],
    });
    const r = svc.unblockLocation();
    expect(r).toEqual({ ok: true, unblocked: 1 });
    const data = readJson(path.join(dir, "accounts.json"), { accounts: [] });
    expect(data.accounts.find((a: any) => a.id === 1).quotaStatusReason).toBeUndefined();
    expect(data.accounts.find((a: any) => a.id === 2).quotaStatusReason).toBe("other");
  });
});
