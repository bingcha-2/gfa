import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeProxyUrl, readJson, setAccountProxyInPool, writeJson } from "../lib/store";

describe("normalizeProxyUrl", () => {
  it("passes through http(s):// and socks5(h):// URLs unchanged", () => {
    expect(normalizeProxyUrl("http://h:1")).toBe("http://h:1");
    expect(normalizeProxyUrl("https://u:p@h:2")).toBe("https://u:p@h:2");
    expect(normalizeProxyUrl("socks5://h:3")).toBe("socks5://h:3");
    expect(normalizeProxyUrl("socks5h://u:p@h:4")).toBe("socks5h://u:p@h:4");
  });

  it("expands host:port:user:pass shorthand into an authenticated http proxy URL", () => {
    expect(normalizeProxyUrl("1.2.3.4:8000:alice:secret")).toBe("http://alice:secret@1.2.3.4:8000");
  });

  it("expands bare host:port shorthand into an http proxy URL", () => {
    expect(normalizeProxyUrl("1.2.3.4:8000")).toBe("http://1.2.3.4:8000");
  });

  it("treats blank/whitespace as empty (= clear)", () => {
    expect(normalizeProxyUrl("")).toBe("");
    expect(normalizeProxyUrl("   ")).toBe("");
    expect(normalizeProxyUrl(null)).toBe("");
    expect(normalizeProxyUrl(undefined)).toBe("");
  });
});

describe("setAccountProxyInPool", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-proxy-store-"));
    file = path.join(dir, "codex-accounts.json");
    writeJson(file, { accounts: [{ id: 1, email: "a@b.c", refreshToken: "rt" }] });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("sets the normalized proxy on the account and persists it", () => {
    const res = setAccountProxyInPool(file, 1, "1.2.3.4:8000:alice:secret");
    expect(res).toEqual({ ok: true, email: "a@b.c", proxyUrl: "http://alice:secret@1.2.3.4:8000" });
    expect(readJson(file, {}).accounts[0].proxyUrl).toBe("http://alice:secret@1.2.3.4:8000");
  });

  it("clears the proxy (deletes the field) when given a blank value", () => {
    setAccountProxyInPool(file, 1, "socks5://h:1");
    const res = setAccountProxyInPool(file, 1, "");
    expect(res).toEqual({ ok: true, email: "a@b.c", proxyUrl: "" });
    expect("proxyUrl" in readJson(file, {}).accounts[0]).toBe(false);
  });

  it("rejects an unsupported scheme without mutating the pool", () => {
    const res = setAccountProxyInPool(file, 1, "ftp://h:1");
    expect(res.ok).toBe(false);
    expect("proxyUrl" in readJson(file, {}).accounts[0]).toBe(false);
  });

  it("returns an error when the account id does not exist", () => {
    const res = setAccountProxyInPool(file, 999, "socks5://h:1");
    expect(res).toEqual({ ok: false, error: "账号不存在" });
  });
});
