import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * 母号 key 的加解密。AES-256-GCM,每条记录独立随机 nonce。
 * 主密钥 GATEWAY_KEY_KEK 只从环境变量读取(32 字节,hex 或 base64),不入库、不入仓库。
 * 缺失或长度不对时直接抛错,不降级为明文存储。
 */
function loadKek(): Buffer {
  const raw = (process.env.GATEWAY_KEY_KEK || "").trim();
  if (!raw) throw new Error("GATEWAY_KEY_KEK is not configured");
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("GATEWAY_KEY_KEK must decode to 32 bytes");
  return buf;
}

/** 返回 base64(nonce(12) | tag(16) | ciphertext)。 */
export function encryptKey(plain: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKek(), nonce);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), enc]).toString("base64");
}

/** 仅供转发模块使用。其余代码不得调用。 */
export function decryptKey(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  if (buf.length < 29) throw new Error("invalid key ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", loadKek(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

/** 脱敏尾号,如 ****a1b2。 */
export function keyHint(plain: string): string {
  return `****${plain.slice(-4)}`;
}
