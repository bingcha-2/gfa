import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

import { AccountLevelsController } from "../account-levels.controller";
import { ROLES_KEY } from "../../../../shared/auth/roles.decorator";

function makeController(overrides: { service?: any; auditLog?: any } = {}) {
  const service = {
    listLevels: vi.fn().mockReturnValue({ ok: true, product: "anthropic", levels: ["max-20x", "pro"] }),
    ...overrides.service,
  };
  const auditLog = { log: vi.fn().mockResolvedValue(undefined), ...overrides.auditLog };
  const controller = new AccountLevelsController(service as any, auditLog as any);
  return { controller, service, auditLog };
}

const req = { user: { id: "op-1" } } as any;

describe("AccountLevelsController.list", () => {
  it("把 product 透传给 service 并返回去重等级列表", async () => {
    const { controller, service } = makeController();

    const result = await controller.list("anthropic", req);

    expect(service.listLevels).toHaveBeenCalledWith("anthropic");
    expect(result).toMatchObject({ ok: true, levels: ["max-20x", "pro"] });
  });

  it("审计 READ_ACCOUNT_LEVELS + operatorId + product", async () => {
    const { controller, auditLog } = makeController();

    await controller.list("codex", req);

    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "op-1",
        action: "READ_ACCOUNT_LEVELS",
        targetType: "AccountPool",
        targetId: "codex",
      }),
    );
  });
});

describe("AccountLevelsController guards", () => {
  it("类上限定 @Roles('ADMIN','OPERATIONS')(对齐 console controller 风格)", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AccountLevelsController);
    expect(roles).toEqual(["ADMIN", "OPERATIONS"]);
  });
});
