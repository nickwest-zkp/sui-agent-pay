import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  distDir: process.env.NODE_ENV === "production" ? ".next" : ".next-dev",
  experimental: {
    externalDir: true,
  },
  serverExternalPackages: ["better-sqlite3"],
  typescript: {
    ignoreBuildErrors: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: config => {
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@sui-agent-pay/sdk": path.resolve(__dirname, "../../../../packages/sdk/src/index.ts"),
    };
    return config;
  },
};

export default nextConfig;
