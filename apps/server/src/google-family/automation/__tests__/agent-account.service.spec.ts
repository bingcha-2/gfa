import { describe, expect, it, vi } from "vitest";

import { AgentAccountService } from "../agent-account.service";

function makeService(row: any) {
  const prisma = {
    agentAccount: {
      findUnique: vi.fn(async () => row),
    },
  };
  const service = new AgentAccountService(prisma as any, {} as any);
  return { service, prisma };
}

describe("AgentAccountService", () => {
  describe("getStoredCredentialsByEmail", () => {
    it("returns stored login credentials for an AdsPower-imported account", async () => {
      const { service, prisma } = makeService({
        loginEmail: "user@example.com",
        loginPassword: "pw",
        totpSecret: "SEC",
        recoveryEmail: "recovery@example.com",
      });

      const credentials = await (service as any).getStoredCredentialsByEmail(" user@example.com ");

      expect(prisma.agentAccount.findUnique).toHaveBeenCalledWith({
        where: { loginEmail: "user@example.com" },
        select: {
          loginEmail: true,
          loginPassword: true,
          totpSecret: true,
          recoveryEmail: true,
        },
      });
      expect(credentials).toEqual({
        loginEmail: "user@example.com",
        loginPassword: "pw",
        totpSecret: "SEC",
        recoveryEmail: "recovery@example.com",
      });
    });

    it("returns null when the account has no stored password", async () => {
      const { service } = makeService({
        loginEmail: "user@example.com",
        loginPassword: "",
        totpSecret: "SEC",
        recoveryEmail: null,
      });

      await expect((service as any).getStoredCredentialsByEmail("user@example.com")).resolves.toBeNull();
    });
  });
});
