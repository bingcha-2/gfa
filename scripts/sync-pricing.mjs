import { copyFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["quota-rates.json", "api-pricing.json"];
const check = process.argv.includes("--check");
for (const file of files) {
  const source = resolve(root, "packages/shared/src", file);
  const target = resolve(root, "apps/app", file);
  if (check) {
    let actual = "";
    try { actual = readFileSync(target, "utf8"); } catch { /* reported below */ }
    if (actual !== readFileSync(source, "utf8")) {
      console.error(`[sync-pricing] ${file} is out of sync`);
      process.exitCode = 1;
    }
  } else {
    copyFileSync(source, target);
    console.log(`[sync-pricing] copied ${file} → apps/app/`);
  }
}
