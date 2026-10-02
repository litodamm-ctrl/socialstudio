import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Use the installed TypeScript compiler API for serverless builds.
  experimental: { useTypeScriptCli: false },
};

export default nextConfig;
