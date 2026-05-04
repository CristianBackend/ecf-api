import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow images from the backend domain
  images: { remotePatterns: [] },
  // Run on port 3001 to avoid conflict with the NestJS backend (port 3000)
  serverExternalPackages: [],
};

export default nextConfig;
