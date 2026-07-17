import { describe, expect, it } from "vitest";

import { boundCustomerEmailMatches, filterAccountPools } from "./account-pool-search";

const accounts = [
  {
    id: 7,
    email: "mother@example.com",
    alias: "主力号",
    quotaPool: { boundCustomerEmails: ["buyer@example.com", "team@example.net"] },
  },
  {
    id: 8,
    email: "other@example.com",
    alias: "",
    quotaPool: { boundCustomerEmails: ["another@example.com"] },
  },
];

describe("account pool search", () => {
  it("可通过绑定订阅的用户邮箱定位母号", () => {
    expect(filterAccountPools(accounts, "BUYER@EXAMPLE")).toEqual([accounts[0]]);
    expect(boundCustomerEmailMatches(accounts[0], "buyer")).toEqual(["buyer@example.com"]);
  });

  it("同时支持母号邮箱、别名和精确账号 ID", () => {
    expect(filterAccountPools(accounts, "mother@")).toEqual([accounts[0]]);
    expect(filterAccountPools(accounts, "主力")).toEqual([accounts[0]]);
    expect(filterAccountPools(accounts, "#8")).toEqual([accounts[1]]);
  });
});
