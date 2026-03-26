import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    include: ["src/**/*.spec.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    env: {
      DATABASE_URL: `file:${resolve(__dirname, "../../prisma/test.db")}`
    }
  },
  resolve: {
    alias: {
      "@gfa/shared": resolve(__dirname, "../../packages/shared/src")
    }
  }
});
