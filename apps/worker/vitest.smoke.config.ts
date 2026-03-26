import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    include: ["src/**/*.smoke.spec.ts"],
    testTimeout: 60000,
    hookTimeout: 15000,
    fileParallelism: false,
    env: {
      DATABASE_URL: `file:${resolve(__dirname, "../../prisma/dev.db")}`
    }
  },
  resolve: {
    alias: {
      "@gfa/shared": resolve(__dirname, "../../packages/shared/src")
    }
  }
});
