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

  // QUOTA-REDESIGN §7 / 决策7:超卖已放开 —— 满号不再阻断下单。该等级唯一的号即便占满,
  // 仍可超卖绑定,故预检返回 true(旧实现这里断言 false,已按决策7改写)。
  it("该等级唯一的号已占满(本单需 1)→ true(超卖:满号也能绑,§7/决策7)", () => {
    expect(svc.hasAvailableSeatFromShares("anthropic", 1, "pro", new Map([[1, CAP]]))).toBe(true);
  });

  it("该等级唯一的号余量刚好够(已占 CAP-1,本单需 1)→ true", () => {
    expect(svc.hasAvailableSeatFromShares("anthropic", 1, "pro", new Map([[1, CAP - 1]]))).toBe(true);
  });

  it("uses explicit sales capacity instead of ACCOUNT_SHARE_CAPACITY when provided", () => {
    const occupied = new Map([[1, 8]]);
    expect(svc.hasAvailableSeatFromShares("anthropic", 2, "pro", occupied, 10)).toBe(true);
    expect(svc.assignSeatForProductFromShares("anthropic", 2, "pro", occupied, new Map(), 10)).toBe(1);
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

describe("座位闸门:配额耗尽但会回血的号仍可绑", () => {
  const FUTURE = "2999-01-01T00:00:00Z";

  it("配额=0 但有未来重置时间 → 可绑(绑定卡跨多个配额窗,会回血)", () => {
    writePool("anthropic-accounts.json", [
      { id: 1, refreshToken: "rt", enabled: true, planType: "pro",
        modelQuotaFractions: { claude: 0 }, modelQuotaResetTimes: { claude: FUTURE } },
    ]);
    svc = new RosettaService({ dataDir: tempDir });
    expect(svc.hasAvailableSeatFromShares("anthropic", 1, "pro", new Map())).toBe(true);
  });

  it("配额=0 且已过重置点 → 可绑(过期窗口当满血)", () => {
    writePool("anthropic-accounts.json", [
      { id: 1, refreshToken: "rt", enabled: true, planType: "pro",
        modelQuotaFractions: { claude: 0 }, modelQuotaResetTimes: { claude: "2000-01-01T00:00:00Z" } },
    ]);
    svc = new RosettaService({ dataDir: tempDir });
    expect(svc.hasAvailableSeatFromShares("anthropic", 1, "pro", new Map())).toBe(true);
  });

  it("配额=0 且无任何重置时间(永久耗尽)→ 不可绑", () => {
    writePool("anthropic-accounts.json", [
      { id: 1, refreshToken: "rt", enabled: true, planType: "pro", modelQuotaFractions: { claude: 0 } },
    ]);
    svc = new RosettaService({ dataDir: tempDir });
    expect(svc.hasAvailableSeatFromShares("anthropic", 1, "pro", new Map())).toBe(false);
  });
});

describe("选号优先级:立刻能用 → 人数最多 → 回血最快 → id", () => {
  const FUTURE_EARLY = "2999-01-01T00:00:00Z";
  const FUTURE_LATE = "2999-12-31T00:00:00Z";

  it("① 立刻能用 压过 人多:有量号(人少)胜过将回血号(人多)", () => {
    writePool("anthropic-accounts.json", [
      { id: 1, refreshToken: "rt", enabled: true, planType: "pro", // 人多(2)但将回血
        modelQuotaFractions: { claude: 0 }, modelQuotaResetTimes: { claude: FUTURE_EARLY } },
      { id: 2, refreshToken: "rt", enabled: true, planType: "pro", modelQuotaFractions: { claude: 0.5 } }, // 人少(1)但此刻有量
    ]);
    svc = new RosettaService({ dataDir: tempDir });
    const occupied = new Map([[1, 2], [2, 1]]);
    const counts = new Map([[1, 2], [2, 1]]);
    // 旧序(人数优先)会选号1;新序(立刻能用优先)选号2。
    expect(svc.assignSeatForProductFromShares("anthropic", 1, "pro", occupied, counts)).toBe(2);
  });

  it("② 同为可用 → 人数最多优先(把拼车塞满、空号留给独享)", () => {
    writePool("anthropic-accounts.json", [
      { id: 1, refreshToken: "rt", enabled: true, planType: "pro" },
      { id: 2, refreshToken: "rt", enabled: true, planType: "pro" },
    ]);
    svc = new RosettaService({ dataDir: tempDir });
    // 都无配额数据 → usableNow 都为真 → 比人数:号1(2 人)> 号2(1 人),即便号1余量更多。
    const occupied = new Map([[1, 2], [2, 3]]);
    const counts = new Map([[1, 2], [2, 1]]);
    expect(svc.assignSeatForProductFromShares("anthropic", 1, "pro", occupied, counts)).toBe(1);
  });

  it("③ 同为将回血且人数相同 → 回血最快的优先", () => {
    writePool("anthropic-accounts.json", [
      { id: 1, refreshToken: "rt", enabled: true, planType: "pro",
        modelQuotaFractions: { claude: 0 }, modelQuotaResetTimes: { claude: FUTURE_LATE } }, // 回血晚
      { id: 2, refreshToken: "rt", enabled: true, planType: "pro",
        modelQuotaFractions: { claude: 0 }, modelQuotaResetTimes: { claude: FUTURE_EARLY } }, // 回血早
    ]);
    svc = new RosettaService({ dataDir: tempDir });
    const occupied = new Map([[1, 1], [2, 1]]);
    const counts = new Map([[1, 1], [2, 1]]);
    expect(svc.assignSeatForProductFromShares("anthropic", 1, "pro", occupied, counts)).toBe(2);
  });
});

// 独享重构:独享请求只落到「干净号」(occupied==0)且永不超卖;被独享锁定的号对所有人不可见;
// 拼车超卖封顶 = oversellCeiling(占用+本单 ≤ ceiling 才可超卖)。
describe("独享给干净号 / 拼车封顶超卖", () => {
  it("独享请求只落干净号(occupied==0),不抢已有占用的号", () => {
    writePool("anthropic-accounts.json", [
      { id: 1, refreshToken: "rt", enabled: true, planType: "pro" },
      { id: 4, refreshToken: "rt", enabled: true, planType: "pro" },
    ]);
    svc = new RosettaService({ dataDir: tempDir });
    // 号1 有人(还有余量)、号4 干净。旧逻辑按「人多」会选号1;独享必须选干净的号4。
    const occupied = new Map([[1, 1], [4, 0]]);
    const counts = new Map([[1, 1], [4, 0]]);
    const got = svc.assignSeatForProductFromShares("anthropic", 1, "pro", occupied, counts, CAP, { exclusive: true });
    expect(got).toBe(4);
  });

  it("独享请求无干净号 → null(不超卖、不抢占有人的号)", () => {
    // 唯一的 pro 号已有人 → 独享拿不到干净号 → null(旧逻辑会超卖塞进去)。
    const occupied = new Map([[1, 1]]);
    expect(
      svc.assignSeatForProductFromShares("anthropic", 1, "pro", occupied, new Map(), CAP, { exclusive: true }),
    ).toBeNull();
  });

  it("被独享锁定的号对拼车不可见(locked 排除)", () => {
    writePool("anthropic-accounts.json", [
      { id: 1, refreshToken: "rt", enabled: true, planType: "pro" },
      { id: 4, refreshToken: "rt", enabled: true, planType: "pro" },
    ]);
    svc = new RosettaService({ dataDir: tempDir });
    // 号1 人多(旧逻辑首选)但被独享锁定 → 拼车必须落到号4。
    const occupied = new Map([[1, 2], [4, 0]]);
    const counts = new Map([[1, 2], [4, 0]]);
    const got = svc.assignSeatForProductFromShares("anthropic", 1, "pro", occupied, counts, CAP, {
      exclusiveLocked: new Set([1]),
    });
    expect(got).toBe(4);
  });

  it("唯一的号被独享锁定 → 拼车 null(不超卖进独享号)", () => {
    const occupied = new Map([[1, 1]]);
    expect(
      svc.assignSeatForProductFromShares("anthropic", 1, "pro", occupied, new Map(), CAP, {
        exclusiveLocked: new Set([1]),
      }),
    ).toBeNull();
  });

  it("拼车超卖封顶:到达 ceiling 后再超卖被拒(null)", () => {
    // ceiling=CAP+1:占用 CAP(满)时还能超卖一份 → 落到号1;占用已达 CAP+1 → 超过封顶 → null。
    expect(
      svc.assignSeatForProductFromShares("anthropic", 1, "pro", new Map([[1, CAP]]), new Map(), CAP, {
        oversellCeiling: CAP + 1,
      }),
    ).toBe(1);
    expect(
      svc.assignSeatForProductFromShares("anthropic", 1, "pro", new Map([[1, CAP + 1]]), new Map(), CAP, {
        oversellCeiling: CAP + 1,
      }),
    ).toBeNull();
  });
});

// QUOTA-REDESIGN §7 / §14 决策7:停止硬禁超卖(Σw>N)。`N` 退化为「保底席位数」而非硬上限;
// 满号时绑定不再被拒,而是回退到「最闲」的号(超卖),使用层 D=max(N,Σw) 自动切薄、永不撞墙。
describe("超卖放开(§7/决策7):满号回退最闲号,Σw 可超 N", () => {
  it("唯一的号已占满(Σw=N)→ 仍能分到该号(超卖,不再返回 null)", () => {
    // 号 1(pro)占满 CAP 份;本单需 1 份 → 无 free≥need 的号 → 回退最闲(唯一的号 1)。
    const occupied = new Map([[1, CAP]]);
    expect(svc.assignSeatForProductFromShares("anthropic", 1, "pro", occupied)).toBe(1);
  });

  it("全部号已占满 → 选「最闲」(occupied 最小 = free 最大,可为负)", () => {
    // 号 1 占 CAP(free=0)、号 4 占 CAP+2(free=-2)→ 都满,选 free 最大的号 1。
    writePool("anthropic-accounts.json", [
      { id: 1, email: "pro-1@x.test", refreshToken: "rt", enabled: true, planType: "pro" },
      { id: 4, email: "pro-4@x.test", refreshToken: "rt", enabled: true, planType: "pro" },
    ]);
    svc = new RosettaService({ dataDir: tempDir });
    const occupied = new Map([[1, CAP], [4, CAP + 2]]);
    expect(svc.assignSeatForProductFromShares("anthropic", 1, "pro", occupied)).toBe(1);
  });

  it("有空号则先填空号(不超卖),不会无谓回退到满号", () => {
    // 号 1 满、号 4 空 → 应填空号 4,而非超卖号 1。
    writePool("anthropic-accounts.json", [
      { id: 1, email: "pro-1@x.test", refreshToken: "rt", enabled: true, planType: "pro" },
      { id: 4, email: "pro-4@x.test", refreshToken: "rt", enabled: true, planType: "pro" },
    ]);
    svc = new RosettaService({ dataDir: tempDir });
    const occupied = new Map([[1, CAP], [4, 0]]);
    expect(svc.assignSeatForProductFromShares("anthropic", 1, "pro", occupied)).toBe(4);
  });

  it("满号超卖后 Σw 可超过 N:连续两单都落到同一满号", () => {
    // 单一 pro 号、CAP 容量;模拟它已占满,两次绑定都回退到它 → Σw 超 N。
    const occupied = new Map([[1, CAP]]);
    const first = svc.assignSeatForProductFromShares("anthropic", 1, "pro", occupied);
    expect(first).toBe(1);
    // 调用方累加占用后再分配(模拟第二单):占用涨到 CAP+1,仍回退到号 1。
    occupied.set(1, CAP + 1);
    const second = svc.assignSeatForProductFromShares("anthropic", 1, "pro", occupied);
    expect(second).toBe(1);
    // 真·无可绑号(等级不存在)才返回 null —— 超卖不改变这一兜底。
    expect(svc.assignSeatForProductFromShares("anthropic", 1, "ultra", occupied)).toBeNull();
  });
});
