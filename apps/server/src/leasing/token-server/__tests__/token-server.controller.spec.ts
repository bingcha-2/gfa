import { describe, expect, it, vi } from "vitest";

import { TokenServerController } from "../token-server.controller";
import { TokenServerHttpError } from "../token-server.service";

function makeResponse() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

describe("TokenServerController", () => {
  it("maps lease-token to TokenServerService.leaseToken", async () => {
    const service = {
      leaseToken: vi.fn().mockResolvedValue({ ok: true, leaseId: "lease-1" }),
      reportResult: vi.fn(),
      getStatus: vi.fn(),
      reloadAccessKeys: vi.fn(),
    };
    const controller = new TokenServerController(service as any);
    const response = makeResponse();

    await controller.post("lease-token", { headers: {} }, { clientId: "c1" }, response);

    expect(service.leaseToken).toHaveBeenCalledWith({ headers: {} }, { clientId: "c1" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, leaseId: "lease-1" });
  });

  it("maps service HTTP errors to their status code", async () => {
    const service = {
      leaseToken: vi.fn().mockRejectedValue(new TokenServerHttpError(401, "Invalid access key")),
      reportResult: vi.fn(),
      getStatus: vi.fn(),
      reloadAccessKeys: vi.fn(),
    };
    const controller = new TokenServerController(service as any);
    const response = makeResponse();

    await controller.post("lease-token", { headers: {} }, {}, response);

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ ok: false, error: "Invalid access key" });
  });

  it("maps shadow report to TokenServerService.shadowReport", async () => {
    const service = {
      leaseToken: vi.fn(),
      reportResult: vi.fn(),
      shadowReport: vi.fn().mockResolvedValue({ ok: true }),
      getStatus: vi.fn(),
      reloadAccessKeys: vi.fn(),
    };
    const controller = new TokenServerController(service as any);
    const response = makeResponse();

    await controller.post("sr", { headers: {} }, { lid: "lease-1" }, response);

    expect(service.shadowReport).toHaveBeenCalledWith({ headers: {} }, { lid: "lease-1" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("rejects unknown routes", async () => {
    const controller = new TokenServerController({} as any);
    const response = makeResponse();

    await controller.post("unknown", { headers: {} }, {}, response);

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ ok: false, error: "Not found" });
  });
});
