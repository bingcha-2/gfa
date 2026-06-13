/**
 * epay.sign.spec.ts — zhunfu V2 RSA(SHA256WithRSA)签名/验签单测。
 *
 * 用自生成的 RSA 测试密钥对做往返:商户私钥签名 → 平台公钥验签。
 * 待签名串规则与 V1 一致(剔除 sign/sign_type/空值,ASCII 升序,k=v&)。
 */
import * as crypto from "crypto";
import { describe, expect, it } from "vitest";

import { buildSignString, signParams, verifySign } from "../epay.sign";

// 测试密钥对(模拟「商户私钥」+「平台公钥」),导出成 zhunfu 那种「裸 base64 DER」。
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIV_B64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const PUB_B64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");

describe("buildSignString", () => {
  it("剔除 sign/sign_type/空值,按 key ASCII 升序,k=v& 拼接", () => {
    expect(buildSignString({ b: "2", a: "1", sign: "x", sign_type: "RSA", e: "" })).toBe("a=1&b=2");
  });

  it("大写字母排在小写前(纯 ASCII 序)", () => {
    expect(buildSignString({ z: "z", A: "A", a: "a" })).toBe("A=A&a=a&z=z");
  });
});

describe("signParams / verifySign — RSA SHA256 往返", () => {
  const params = {
    pid: "1224",
    type: "alipay",
    out_trade_no: "gfa-1",
    money: "1.00",
    timestamp: "1721206072",
    sign_type: "RSA",
  };

  it("商户私钥签名 → base64;平台公钥验签通过", () => {
    const sign = signParams(params, PRIV_B64);
    expect(sign).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64
    expect(verifySign({ ...params, sign }, PUB_B64)).toBe(true);
  });

  it("篡改参数值 → 验签失败", () => {
    const sign = signParams(params, PRIV_B64);
    expect(verifySign({ ...params, money: "9999.00", sign }, PUB_B64)).toBe(false);
  });

  it("用别的内容签出的 sign(有效 base64 但内容不符)→ 验签失败", () => {
    const wrong = signParams({ ...params, out_trade_no: "other" }, PRIV_B64);
    expect(verifySign({ ...params, sign: wrong }, PUB_B64)).toBe(false);
  });

  it("sign_type 不参与签名:改它不影响验签结果", () => {
    const sign = signParams(params, PRIV_B64);
    expect(verifySign({ ...params, sign, sign_type: "MD5" }, PUB_B64)).toBe(true);
  });

  it("平台新增扩展回调字段:验签用实际全部字段,天然支持", () => {
    const withExtra = { ...params, api_trade_no: "4200xxx", buyer: "openid-1" };
    const sign = signParams(withExtra, PRIV_B64);
    expect(verifySign({ ...withExtra, sign }, PUB_B64)).toBe(true);
  });

  // 真实坑:env 经 shell 导出常被裹上一对字面引号(`"MIIE…=="`),或带首尾空白/换行,
  // @nestjs/config 不覆盖已存在变量 → server 拿到带引号的 key → createPrivateKey 抛
  // DECODER::unsupported。toPem 只保留 base64 字符,应对此免疫。
  it("私钥/公钥含字面引号或首尾空白(被 shell 加引号导出)仍能签 / 验", () => {
    const quotedPriv = `"${PRIV_B64}"`; // shell 导出带引号
    const messyPub = `  ${PUB_B64}\n`; // 带首尾空白 / 换行
    const sign = signParams(params, quotedPriv);
    expect(sign).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(verifySign({ ...params, sign }, messyPub)).toBe(true);
  });
});

describe("verifySign — 防御(绝不抛)", () => {
  it("sign 缺失 / 空 / 非字符串(sign=a&sign=b 污染成数组)/ 数字 → false", () => {
    expect(verifySign({ a: "1" } as any, PUB_B64)).toBe(false);
    expect(verifySign({ a: "1", sign: "" }, PUB_B64)).toBe(false);
    expect(() => verifySign({ a: "1", sign: ["x", "y"] } as any, PUB_B64)).not.toThrow();
    expect(verifySign({ a: "1", sign: ["x", "y"] } as any, PUB_B64)).toBe(false);
    expect(verifySign({ a: "1", sign: 123 } as any, PUB_B64)).toBe(false);
  });

  it("坏 base64 sign → false,不抛", () => {
    expect(() => verifySign({ a: "1", sign: "!!!not-base64!!!" }, PUB_B64)).not.toThrow();
    expect(verifySign({ a: "1", sign: "!!!not-base64!!!" }, PUB_B64)).toBe(false);
  });

  it("坏公钥 → false,不抛(回调验签 fail-closed)", () => {
    const sign = signParams({ a: "1" }, PRIV_B64);
    expect(() => verifySign({ a: "1", sign }, "not-a-real-key")).not.toThrow();
    expect(verifySign({ a: "1", sign }, "not-a-real-key")).toBe(false);
  });
});

describe("signParams — 配置错应显式失败", () => {
  it("坏私钥 → 抛(下单时配置错就该 fail-loud,不静默)", () => {
    expect(() => signParams({ a: "1" }, "not-a-real-key")).toThrow();
  });
});
