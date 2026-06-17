export type OrderActionKind = "refund" | "revoke" | "none";
export type OrderAction = { kind: OrderActionKind; label: string };

export function orderAction(o: { payChannel: string; status: string }): OrderAction {
  if (o.status !== "PAID") return { kind: "none", label: "" };
  if (o.payChannel === "GRANT") return { kind: "revoke", label: "撤销授权" };
  return { kind: "refund", label: "退款" };
}
