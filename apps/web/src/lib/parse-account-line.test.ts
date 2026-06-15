import { describe, expect, it } from "vitest";

import { parseAccountLine } from "./parse-account-line";

describe("parseAccountLine", () => {
  it("3 段 ----，sessionKey 同行", () => {
    const r = parseAccountLine(
      "pivrcarolinema3lcx@reincarnate.com----ry8r9TgzjA----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",
    );
    expect(r?.email).toBe("pivrcarolinema3lcx@reincarnate.com");
    expect(r?.password).toBe("ry8r9TgzjA");
    expect(r?.sessionKey).toBe(
      "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",
    );
  });

  it("4 段 ---，sessionKey 换行单独一行", () => {
    const r = parseAccountLine(
      "aaliyahfloy849@gmail.com---KX6DtN8DIE7pvS2---aaliyahfloy8495671@hotmail.com---nxuzam2vavbgluia36j3k4xpfuj3oamx\n" +
        "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",
    );
    expect(r?.email).toBe("aaliyahfloy849@gmail.com");
    expect(r?.password).toBe("KX6DtN8DIE7pvS2");
    expect(r?.recoveryEmail).toBe("aaliyahfloy8495671@hotmail.com");
    expect(r?.sessionKey).toBe(
      "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",
    );
  });

  it("5 段 ----，含恢复邮箱/口令/取码URL，sessionKey 同行末尾", () => {
    const r = parseAccountLine(
      "CardenasSilvio564@gmail.com----mzdii5xtzso----CardenasSilvio56434846@chuclong.xyz----mnxqpywjcbuk6bqrndrmfyebga6v7rzt----http://umlmail.site/Mail/GetCodeSMS?token=Sp4N7bVJ5906052006----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",
    );
    expect(r?.email).toBe("CardenasSilvio564@gmail.com");
    expect(r?.password).toBe("mzdii5xtzso");
    expect(r?.recoveryEmail).toBe("CardenasSilvio56434846@chuclong.xyz");
    expect(r?.sessionKey).toBe(
      "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",
    );
  });

  it("取码URL 不会被误当作 sessionKey 或恢复邮箱", () => {
    const r = parseAccountLine(
      "a@b.com----pw----http://x.site/Get?token=abc----sk-ant-sid02-AAA_BBB-CCC",
    );
    expect(r?.sessionKey).toBe("sk-ant-sid02-AAA_BBB-CCC");
    expect(r?.recoveryEmail).toBe("");
  });

  it("只切出 sid0x token，丢弃后面粘连的空白与杂质", () => {
    const r = parseAccountLine("a@b.com----pw----sk-ant-sid02-ABC123_x-y   trailing junk");
    expect(r?.sessionKey).toBe("sk-ant-sid02-ABC123_x-y");
  });

  it("空输入返回 null", () => {
    expect(parseAccountLine("")).toBeNull();
    expect(parseAccountLine("   \n  ")).toBeNull();
  });

  it("缺少 sessionKey 时仍能解析邮箱/密码(交给 magic-link 流程)", () => {
    const r = parseAccountLine("a@b.com----secretpw");
    expect(r?.email).toBe("a@b.com");
    expect(r?.password).toBe("secretpw");
    expect(r?.sessionKey).toBe("");
  });
});
