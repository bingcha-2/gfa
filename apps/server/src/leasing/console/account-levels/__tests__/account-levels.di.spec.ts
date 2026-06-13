/**
 * account-levels.di.spec.ts — 启动期 DI 防崩回归(无需 @nestjs/testing)。
 *
 * 复现并防回归一个「单测 + tsc 都抓不到、只在应用启动期炸」的坑:AccountLevelsService 的构造
 * 参数 `dataDir: string` 若不标 @Optional,NestJS 容器会把它当依赖去解析 String provider →
 * 启动失败(Nest can't resolve dependencies of AccountLevelsService [String at index 0])。
 * 既有单测直接 `new AccountLevelsService(dir)` 构造、绕过容器,故抓不到。这里直接断言容器据以
 * 判定可选参数的元数据,锁住 @Optional 不被误删。
 */
import "reflect-metadata";
import { describe, expect, it } from "vitest";

import { AccountLevelsService } from "../account-levels.service";

describe("AccountLevelsService — 构造参数 dataDir 标 @Optional(启动期 DI 防崩)", () => {
  it("参数 0(dataDir)标记为 @Optional → 容器不把它当 String 依赖解析(否则启动崩)", () => {
    // NestJS 用 "optional:paramtypes" 元数据记录可选构造参数下标;@Optional() 会写入 0。
    const optionalParams: number[] =
      Reflect.getMetadata("optional:paramtypes", AccountLevelsService) || [];
    expect(optionalParams).toContain(0);
  });

  it("默认 dataDir 构造(容器解析不到 String 时等效于传 undefined)→ 实例可用", () => {
    expect(new AccountLevelsService().listLevels("unknown")).toEqual({
      ok: false,
      product: "unknown",
      levels: [],
    });
  });
});
