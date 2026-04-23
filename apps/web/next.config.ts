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
    return [
      {
        source: "/api/faq-images/:path*",
        destination: `${apiOrigin}/api/faq-images/:path*`,
      },
    ];
  },
};

export default nextConfig;
