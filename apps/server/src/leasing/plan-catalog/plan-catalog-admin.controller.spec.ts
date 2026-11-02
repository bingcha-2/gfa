import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

import { PlanCatalogAdminController } from "./plan-catalog-admin.controller";
import { ROLES_KEY } from "../../shared/auth/roles.decorator";

function makeController(overrides: { service?: any; auditLog?: any } = {}) {
  const service = {
    createDraft: vi.fn().mockResolvedValue({ id: "cat-9", version: 4, status: "DRAFT" }),
    publish: vi.fn().mockResolvedValue({ id: "cat-9", version: 4, status: "PUBLISHED" }),
    ...overrides.service,
  };
  const auditLog = { log: vi.fn().mockResolvedValue(undefined), ...overrides.auditLog };
  const controller = new PlanCatalogAdminController(service as any, auditLog as any);
  return { controller, service, auditLog };
}

const req = { user: { id: "op-1" } } as any;

describe("PlanCatalogAdminController.createDraft", () => {
  it("把 config 对象序列化成 JSON 字符串存草稿(SQLite 无 Json 类型)", async () => {
    const { controller, service } = makeController();
    const config = { durationDays: 30, products: ["anthropic"] };

    const result = await controller.createDraft({ config } as any, req);

    expect(service.createDraft).toHaveBeenCalledWith(JSON.stringify(config));
    expect(result).toMatchObject({ id: "cat-9", status: "DRAFT" });
  });

  it("审计日志记录 CREATE_PLAN_CATALOG + operatorId + 新版本号", async () => {
    const { controller, auditLog } = makeController();

    await controller.createDraft({ config: { durationDays: 30 } } as any, req);

    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "op-1",
        action: "CREATE_PLAN_CATALOG",
        targetType: "PlanCatalog",
        targetId: "cat-9",
        detail: expect.objectContaining({ version: 4 }),
      }),
    );
  });
});

describe("PlanCatalogAdminController.publish", () => {
  it("发布指定版本并审计 PUBLISH_PLAN_CATALOG", async () => {
    const { controller, service, auditLog } = makeController();

    const result = await controller.publish("cat-9", req);

    expect(service.publish).toHaveBeenCalledWith("cat-9");
    expect(result).toMatchObject({ status: "PUBLISHED" });
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "op-1",
        action: "PUBLISH_PLAN_CATALOG",
        targetType: "PlanCatalog",
        targetId: "cat-9",
      }),
    );
  });
});

describe("PlanCatalogAdminController guards", () => {
  it("类上限定 @Roles('ADMIN','OPERATIONS')(对齐 console controller 风格)", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, PlanCatalogAdminController);
    expect(roles).toEqual(["ADMIN", "OPERATIONS"]);
  });
});
