import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CachedJsonFile, defaultDataDir, nowIso, readJson, writeJson } from "../store";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-spec-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("readJson / writeJson", () => {
  it("round-trips an object and pretty-prints with a trailing newline", () => {
    const p = path.join(dir, "x.json");
    writeJson(p, { a: 1, b: [2, 3] });
    expect(readJson(p, null)).toEqual({ a: 1, b: [2, 3] });
    expect(fs.readFileSync(p, "utf8").endsWith("\n")).toBe(true);
  });

  it("creates parent directories on write", () => {
    const p = path.join(dir, "nested", "deep", "x.json");
    writeJson(p, { ok: true });
    expect(readJson(p, null)).toEqual({ ok: true });
  });

  it("returns the fallback for a missing or unparseable file", () => {
    expect(readJson(path.join(dir, "missing.json"), { fb: 1 })).toEqual({ fb: 1 });
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{not json");
    expect(readJson(bad, "FB")).toBe("FB");
  });
});

describe("CachedJsonFile", () => {
  it("serves the same cached reference while the file is unchanged", () => {
    const p = path.join(dir, "c.json");
    writeJson(p, { v: 1 });
    const c = new CachedJsonFile(p, { v: 0 });
    const r1 = c.read();
    expect(r1).toEqual({ v: 1 });
    expect(c.read()).toBe(r1); // cache hit → identical reference, no re-parse
  });

  it("re-reads when the file's mtime advances", () => {
    const p = path.join(dir, "c.json");
    writeJson(p, { v: 1 });
    const c = new CachedJsonFile(p, { v: 0 });
    expect(c.read()).toEqual({ v: 1 });
    fs.writeFileSync(p, JSON.stringify({ v: 2 }));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(p, future, future); // unambiguously newer mtime
    expect(c.read()).toEqual({ v: 2 });
  });

  it("invalidate() forces a fresh parse", () => {
    const p = path.join(dir, "c.json");
    writeJson(p, { v: 1 });
    const c = new CachedJsonFile(p, {});
    const r1 = c.read();
    c.invalidate();
    const r2 = c.read();
    expect(r2).toEqual({ v: 1 });
    expect(r2).not.toBe(r1); // re-parsed → new reference
  });

  it("returns the fallback when the file does not exist", () => {
    const c = new CachedJsonFile(path.join(dir, "nope.json"), { fb: true });
    expect(c.read()).toEqual({ fb: true });
  });
});

describe("nowIso / defaultDataDir", () => {
  it("nowIso returns an ISO-8601 timestamp", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("defaultDataDir honors ROSETTA_DATA_DIR override", () => {
    const prev = process.env.ROSETTA_DATA_DIR;
    process.env.ROSETTA_DATA_DIR = "/tmp/custom-rosetta";
    try {
      expect(defaultDataDir()).toBe("/tmp/custom-rosetta");
    } finally {
      if (prev === undefined) delete process.env.ROSETTA_DATA_DIR;
      else process.env.ROSETTA_DATA_DIR = prev;
    }
  });

  it("defaultDataDir falls back to a platform path ending in Antigravity/rosetta", () => {
    const prev = process.env.ROSETTA_DATA_DIR;
    delete process.env.ROSETTA_DATA_DIR;
    try {
      expect(defaultDataDir().replace(/\\/g, "/")).toMatch(/Antigravity\/rosetta$/);
    } finally {
      if (prev !== undefined) process.env.ROSETTA_DATA_DIR = prev;
    }
  });
});
