/**
 * epay.sign.ts — pure sign/verify for 彩虹易支付 zhunfu **V2**(RSA / SHA256WithRSA)。
 *
 * V2 升级要点(见 vip1.zhunfu.cn/doc):V1 用 MD5 + submit.php,V2 全面改用 RSA 签名
 * + /api/pay/* 接口。本商户后台已生成 RSA 密钥对,故走 V2:
 *   - 下单/请求:用「商户私钥」做 RSA 签名(signParams)。
 *   - 回调/返回:用「平台公钥」做 RSA 验签(verifySign)。
 *
 * 待签名串构造(V1/V2 相同):取所有非空、非数组/字节参数,剔除 sign / sign_type,
 * 按 key ASCII 升序,组成 `k=v&k=v&...`(原始值,不 url-encode)。V2 与 V1 唯一的差别
 * 是最后一步:MD5(str+key) → RSA-SHA256(str, 私钥) 得 base64 签名。
 *
 * 密钥入参为「裸 base64 DER」(zhunfu 后台直接给的那串,无 PEM 头尾):私钥 PKCS#8、
 * 公钥 SPKI。toPem 给它套上 PEM 头尾再交给 node crypto。
 */
import * as crypto from "crypto";

/** 待签名串:剔除 sign/sign_type/空值,key ASCII 升序,k=v&… 拼接(原始值)。 */
export function buildSignString(params: Record<string, string>): string {
  return Object.entries(params)
    .filter(([k, v]) => v !== "" && v !== undefined && v !== null && k !== "sign" && k !== "sign_type")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/**
 * 裸 base64 DER → PEM。label: "PRIVATE KEY"(PKCS#8 私钥)/ "PUBLIC KEY"(SPKI 公钥)。
 *
 * 只保留 base64 字符(A-Za-z0-9+/=),去掉其余一切 —— 容忍首尾字面引号 / 空白 / 换行。
 * 原因:env 值经 shell 导出常被裹上一对字面引号(如 EPAY_MERCHANT_PRIVATE_KEY 继承自
 * 带引号的 export,@nestjs/config 又不覆盖已存在变量),那样 key 变成 `"MIIE…=="`,
 * createPrivateKey 会抛 `DECODER routines::unsupported`。base64 字符集不含引号/空白,
 * 剔除它们绝对安全。
 */
function toPem(b64: string, label: "PRIVATE KEY" | "PUBLIC KEY"): string {
  const body = b64.replace(/[^A-Za-z0-9+/=]/g, "").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/**
 * V2 RSA 签名(SHA256WithRSA),用商户私钥,返回 base64。
 * privateKeyB64: 商户私钥裸 base64(PKCS#8)。
 */
export function signParams(params: Record<string, string>, privateKeyB64: string): string {
  const data = buildSignString(params);
  const key = crypto.createPrivateKey({ key: toPem(privateKeyB64, "PRIVATE KEY"), format: "pem" });
  return crypto.sign("sha256", Buffer.from(data, "utf8"), key).toString("base64");
}

/**
 * V2 RSA 验签(SHA256WithRSA),用平台公钥。回调 / 接口返回数据验签。
 * 非字符串 / 空 sign(含 sign=a&sign=b 污染成数组)、坏密钥、坏 base64 → false,绝不抛。
 * publicKeyB64: 平台公钥裸 base64(SPKI)。
 */
export function verifySign(params: Record<string, string>, publicKeyB64: string): boolean {
  const rawSign = (params as Record<string, unknown>).sign;
  if (typeof rawSign !== "string" || rawSign === "") return false;
  try {
    const data = buildSignString(params);
    const key = crypto.createPublicKey({ key: toPem(publicKeyB64, "PUBLIC KEY"), format: "pem" });
    return crypto.verify("sha256", Buffer.from(data, "utf8"), key, Buffer.from(rawSign, "base64"));
  } catch {
    return false;
  }
}
