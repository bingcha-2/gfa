import type { NextConfig } from "next";

const outputMode =
  process.env.GFA_WEB_OUTPUT_MODE === "standalone" ? "standalone" : undefined;

// Normalize ADMIN_PATH_PREFIX: strip leading/trailing slashes, default to "console"
const adminPathPrefix = (process.env.ADMIN_PATH_PREFIX ?? "console").replace(/^\/|\/$/g, "") || "console";

const nextConfig: NextConfig = {
  transpilePackages: ["@gfa/shared"],
  ...(outputMode ? { output: outputMode } : {}),
  // Expose admin path prefix to both server (middleware) and client components.
  // NEXT_PUBLIC_ prefix makes it available in client bundles.
  env: {
    ADMIN_PATH_PREFIX: adminPathPrefix,
    NEXT_PUBLIC_ADMIN_PATH_PREFIX: adminPathPrefix,
  },
};

export default nextConfig;
