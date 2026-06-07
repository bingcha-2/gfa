// Low-level JSON file store helpers shared across the rosetta domain services.
// Extracted verbatim from rosetta.service.ts (behavior-preserving).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function defaultDataDir(): string {
  if (process.env.ROSETTA_DATA_DIR) return process.env.ROSETTA_DATA_DIR;
  const base =
    process.platform === "win32"
      ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "Antigravity", "rosetta");
}

export function readJson(filePath: string, fallback: any): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

/** mtime-based file cache: skips re-read if file hasn't changed on disk. */
export class CachedJsonFile {
  private cache: any = null;
  private mtimeMs = 0;

  constructor(private readonly filePath: string, private readonly fallback: any) {}

  read(): any {
    try {
      const stat = fs.statSync(this.filePath);
      if (this.cache !== null && stat.mtimeMs === this.mtimeMs) {
        return this.cache;
      }
      this.mtimeMs = stat.mtimeMs;
    } catch {
      return this.fallback;
    }
    this.cache = readJson(this.filePath, this.fallback);
    return this.cache;
  }

  /** Invalidate cache so next read() re-reads from disk. */
  invalidate(): void {
    this.cache = null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
