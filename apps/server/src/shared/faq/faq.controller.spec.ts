import { describe, expect, it, vi } from "vitest";

import { FaqController } from "./faq.controller";

describe("FaqController contact settings", () => {
  it("returns the public contact name, WeChat id, and QR URL", async () => {
    const prisma = {
      siteSetting: {
        findMany: vi.fn().mockResolvedValue([
          { key: "contact_name", value: "Mr. 淦" },
          { key: "contact_wechat", value: "18339526286" },
          { key: "contact_qrcode_url", value: "/api/faq-images/mr-gan-wechat-qr.jpg" },
        ]),
      },
    };
    const controller = new FaqController(prisma as never);

    await expect(controller.getSettings()).resolves.toEqual({
      contact_name: "Mr. 淦",
      contact_wechat: "18339526286",
      contact_qrcode_url: "/api/faq-images/mr-gan-wechat-qr.jpg",
    });
    expect(prisma.siteSetting.findMany).toHaveBeenCalledWith({
      where: {
        key: {
          in: ["contact_name", "contact_wechat", "contact_qrcode_url"],
        },
      },
    });
  });

  it("updates only allowlisted public contact settings", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const prisma = { siteSetting: { upsert } };
    const controller = new FaqController(prisma as never);

    await expect(controller.updateSettings({
      contact_name: "Mr. 淦",
      contact_wechat: "18339526286",
      private_api_key: "must-not-be-written",
    })).resolves.toEqual({
      contact_name: "Mr. 淦",
      contact_wechat: "18339526286",
    });
    expect(upsert).toHaveBeenCalledTimes(2);
  });
});
