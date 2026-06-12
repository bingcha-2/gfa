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
  // Legacy portal URL shim.
  //
  // The toC user-center lived under /app/* before the marketing / account /
  // console split renamed it to /account/* (commit f4ccf54). Already-delivered
  // emails (verify-email / password-reset links) and desktop client builds
  // deployed before the rename still point at /app/*, so keep a permanent
  // (308) redirect in place. Query strings (?token=...) are preserved
  // automatically.
  //
  // ⚠️  This CANNOT shadow the desktop-client API at /api/app/* — redirect
  //     sources are rooted at "/", so "/app/:path*" matches only "/app" and
  //     "/app/...", never "/api/app/...". Do not "simplify" the source to a
  //     non-rooted pattern.
  async redirects() {
    return [
      // Bare /app → /account (also covered by :path* below since the `*`
      // modifier matches zero segments — kept explicit for clarity).
      {
        source: "/app",
        destination: "/account",
        permanent: true,
      },
      {
        source: "/app/:path*",
        destination: "/account/:path*",
        permanent: true,
      },
    ];
  },
  // Proxy the surviving backend API surfaces to the NestJS server.
  //
  // The legacy bare prefixes (auth, rosetta, accounts, family-groups, orders,
  // tasks, stats, remote-token, remote-codex, remote-anthropic, …) were
  // removed server-side — everything admin now lives under /api/console/*,
  // everything toC under /api/account/* and the desktop client under
  // /api/app/*.
  //
  // ⚠️  DO NOT add /api/account, /api/account-session or /api/console-session
  //     to this rewrite list. Those paths are handled by Next.js route
  //     handlers in src/app/api/{account,account-session,console-session}/
  //     which perform cookie→Bearer (and cookie set/clear) conversion.
  //     Adding them here would bypass the route handlers and send
  //     unauthenticated requests directly to the NestJS backend.
  async rewrites() {
    const backendPrefixes = [
      // Admin Bearer/cookie API. Required for the split-domain deploy: the
      // admin subdomain (Caddyfile.migration) proxies ONLY to Next.js, so
      // /api/console/* must flow NestJS-ward through this rewrite.
      "console",
      // Desktop-client surface; the console lease pages also consume the
      // @Public lease-pool ops at /api/app/lease/* (status / announcement /
      // reload-access-keys).
      "app",
      // Payment provider callbacks.
      "epay",
      // Backend health check.
      "health",
      // @Public usage dashboard (bare backend path, not console-namespaced),
      // consumed by /console/usage-stats.
      "remote-stats",
    ];

    return [
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
