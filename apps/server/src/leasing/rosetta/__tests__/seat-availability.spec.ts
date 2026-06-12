/**
 * seat-availability.spec.ts — 下单前座位预检的底座(spec §10)。
 *
 * hasAvailableSeatFromShares(product, weight, level, occupiedShares):该 product+level
 * 有没有任一上游号还剩 ≥ weight 份(占用份额由调用方按 DB ACTIVE 订阅 config 算好传入,
 * 不读 access-keys.json 文件)。与 assignSeatForProductFromShares 同样的选号口径(等级匹配、
 * 可绑、配额未耗尽),只回答「有没有」,不实际分配、不写文件。
 *
 * 注:容量 ACCOUNT_SHARE_CAPACITY 在测试环境由 vitest.config env 设为 4(见配置),且
 * cardWeight 会把 weight clamp 到 [1, CAP]。故用例一律以导入的常量算余量,避免硬编码 8。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RosettaService } from "../rosetta.service";
import { ACCOUNT_SHARE_CAPACITY } from "../../token-server/token-billing";

const CAP = ACCOUNT_SHARE_CAPACITY;

let tempDir: string;
let svc: RosettaService;

function writePool(file: string, accounts: any[]) {
  fs.writeFileSync(path.join(tempDir, file), JSON.stringify({ accounts }));
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-seat-avail-"));
  // anthropic 池:号 1 (pro)、号 2 (max-20x)、号 3 (pro 但 disabled)。
  writePool("anthropic-accounts.json", [
    { id: 1, email: "pro-1@x.test", refreshToken: "rt", enabled: true, planType: "pro" },
    { id: 2, email: "max-2@x.test", refreshToken: "rt", enabled: true, planType: "max-20x" },
    { id: 3, email: "pro-3@x.test", refreshToken: "rt", enabled: false, planType: "pro" },
  ]);
  svc = new RosettaService({ dataDir: tempDir });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("RosettaService.hasAvailableSeatFromShares", () => {
  it("该等级有空号且余量足(独享=满容量)→ true", () => {
    expect(svc.hasAvailableSeatFromShares("anthropic", CAP, "pro", new Map())).toBe(true);
  });

  it("该等级无号(等级不存在)→ false", () => {
    expect(svc.hasAvailableSeatFromShares("anthropic", 1, "ultra", new Map())).toBe(false);
  });

  it("该等级唯一的号余量不足(已占满,本单需 1)→ false", () => {
    expect(svc.hasAvailableSeatFromShares("anthropic", 1, "pro", new Map([[1, CAP]]))).toBe(false);
  });

  it("该等级唯一的号余量刚好够(已占 CAP-1,本单需 1)→ true", () => {
    expect(svc.hasAvailableSeatFromShares("anthropic", 1, "pro", new Map([[1, CAP - 1]]))).toBe(true);
  });

  it("满员号被排除,但同等级另有空号 → true", () => {
    // 号 1(pro)满,新增号 4(pro)空 → 仍 true。
    writePool("anthropic-accounts.json", [
      { id: 1, email: "pro-1@x.test", refreshToken: "rt", enabled: true, planType: "pro" },
      { id: 4, email: "pro-4@x.test", refreshToken: "rt", enabled: true, planType: "pro" },
    ]);
    svc = new RosettaService({ dataDir: tempDir });
    expect(svc.hasAvailableSeatFromShares("anthropic", CAP, "pro", new Map([[1, CAP]]))).toBe(true);
  });

  it("disabled 号不算可用(号 3 pro 但 enabled=false)→ 该等级仅它时 false", () => {
    writePool("anthropic-accounts.json", [
      { id: 3, email: "pro-3@x.test", refreshToken: "rt", enabled: false, planType: "pro" },
    ]);
    svc = new RosettaService({ dataDir: tempDir });
    expect(svc.hasAvailableSeatFromShares("anthropic", 1, "pro", new Map())).toBe(false);
  });

  it("非法 product → false", () => {
    expect(svc.hasAvailableSeatFromShares("bogus", 1, "pro", new Map())).toBe(false);
  });

  it("空 level → false", () => {
    expect(svc.hasAvailableSeatFromShares("anthropic", 1, "", new Map())).toBe(false);
  });

  it("与 assignSeatForProductFromShares 口径一致:能分到号 ⇔ 有可用座位", () => {
    const occupied = new Map<number, number>();
    const assigned = svc.assignSeatForProductFromShares("anthropic", CAP, "max-20x", occupied);
    const has = svc.hasAvailableSeatFromShares("anthropic", CAP, "max-20x", occupied);
    expect(Boolean(assigned)).toBe(has);
    expect(has).toBe(true);
  });
});
