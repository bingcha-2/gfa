/**
 * llm.module.spec.ts — 防回归。
 *
 * LlmClient 构造函数带可选 config 形参;若以普通类形式注册(providers:[LlmClient]),
 * Nest 会把该形参当依赖解析、启动崩溃(UnknownDependenciesException)。
 * 必须用 useFactory 注册。本测试锁住这一点,并验证工厂能产出可用实例。
 */
import "reflect-metadata";
import { describe, it, expect } from "vitest";

import { SupportLlmModule } from "../llm.module";
import { LlmClient } from "../llm.client";

describe("SupportLlmModule", () => {
  it("LlmClient 必须用 useFactory 注册,且工厂产出实例", () => {
    const providers =
      (Reflect.getMetadata("providers", SupportLlmModule) as unknown[]) ?? [];
    const entry = providers.find(
      (p): p is { provide: unknown; useFactory?: () => unknown } =>
        typeof p === "object" && p !== null && (p as any).provide === LlmClient,
    );
    expect(entry).toBeDefined();
    expect(typeof entry!.useFactory).toBe("function");
    expect(entry!.useFactory!()).toBeInstanceOf(LlmClient);
  });
});
