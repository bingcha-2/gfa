import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { BillingController } from "../billing.controller";

describe("BillingController", () => {
  it("rejects new online payment orders while preserving the billing service", () => {
    const billing = { createCatalogOrder: vi.fn() };
    const controller = new BillingController(billing as never);

    expect(() => controller.createCatalogOrder()).toThrow(ServiceUnavailableException);
    expect(billing.createCatalogOrder).not.toHaveBeenCalled();
  });
});
