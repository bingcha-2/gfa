import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@gfa/shared"],
  output: "standalone"
};

export default nextConfig;
