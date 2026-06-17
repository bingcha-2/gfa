import { describe, expect, it } from "vitest";
import { orderAction } from "@/lib/console/order-action";

describe("orderAction", () => {
  it("付费已支付单 → 退款", () => {
    expect(orderAction({ payChannel: "ALIPAY", status: "PAID" })).toEqual({ kind: "refund", label: "退款" });
    expect(orderAction({ payChannel: "WXPAY", status: "PAID" })).toEqual({ kind: "refund", label: "退款" });
  });
  it("GRANT 已支付单 → 撤销授权(不是退款)", () => {
    expect(orderAction({ payChannel: "GRANT", status: "PAID" })).toEqual({ kind: "revoke", label: "撤销授权" });
  });
  it("非 PAID 单 → 无动作", () => {
    expect(orderAction({ payChannel: "ALIPAY", status: "REFUNDED" })).toEqual({ kind: "none", label: "" });
    expect(orderAction({ payChannel: "GRANT", status: "PENDING" })).toEqual({ kind: "none", label: "" });
  });
});
