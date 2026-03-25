import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@gfa/shared"],
  // Standalone mode produces a self-contained .next/standalone/ folder which
  // includes only the required server files and a minimal node_modules tree
  // (no symlinks). This is the correct packaging mode for production installers.
  output: "standalone"
};

export default nextConfig;
