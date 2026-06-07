import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
copyFileSync(resolve(root, "packages/shared/src/pricing.json"), resolve(root, "apps/bcai-wails/pricing.json"));
console.log("[sync-pricing] copied pricing.json → apps/bcai-wails/");
