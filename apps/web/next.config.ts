import type { NextConfig } from "next";

const outputMode =
  process.env.GFA_WEB_OUTPUT_MODE === "standalone" ? "standalone" : undefined;

// Normalize ADMIN_PATH_PREFIX: strip leading/trailing slashes, default to "console"
const adminPathPrefix = (process.env.ADMIN_PATH_PREFIX ?? "console").replace(/^\/|\/$/g, "") || "console";

const apiBaseUrl = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";
// Extract just the origin (e.g., http://localhost:3001)
const apiOrigin = apiBaseUrl.replace(/\/api\/?$/, "");

const nextConfig: NextConfig = {
  transpilePackages: ["@gfa/shared"],
  // Skip type-checking during build (done separately by tsc / IDE)
  typescript: { ignoreBuildErrors: true },
  ...(outputMode ? { output: outputMode } : {}),
  // Expose admin path prefix to both server (middleware) and client components.
  // NEXT_PUBLIC_ prefix makes it available in client bundles.
  env: {
    ADMIN_PATH_PREFIX: adminPathPrefix,
    NEXT_PUBLIC_ADMIN_PATH_PREFIX: adminPathPrefix,
  },
  // Increase body size limit for API route handlers (FAQ image uploads)
  experimental: {
    serverActions: {
      bodySizeLimit: "20mb",
    },
  },
  // Proxy FAQ images to the backend API server
  async rewrites() {
    const backendPrefixes = [
      "auth",
      "stats",
      "family-groups",
      "orders",
      "tasks",
      "accounts",
      "agent-accounts",
      "redeem-codes",
      "scheduler",
      "queue",
      "admin",
      "expire-scan",
      "audit-logs",
      "users",
      "public",
      "automation",
      "faq",
      "phone-pool",
      "remote-token",
      "remote-codex",
      "remote-stats",
      "rosetta",
    ];

    return [
      {
        source: "/remote-token/:path*",
        destination: `${apiOrigin}/api/remote-token/:path*`,
      },
      {
        source: "/remote-codex/:path*",
        destination: `${apiOrigin}/api/remote-codex/:path*`,
      },
      {
        source: "/api/faq-images/:path*",
        destination: `${apiOrigin}/api/faq-images/:path*`,
      },
      ...backendPrefixes.map((prefix) => ({
        source: `/api/${prefix}/:path*`,
        destination: `${apiOrigin}/api/${prefix}/:path*`,
      })),
    ];
  },
};

export default nextConfig;
