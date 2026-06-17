import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Self-contained build for a small Docker image: emits .next/standalone with
  // its own minimal server.js + node_modules subset (supported in Next 16).
  // The admin is served at the domain ROOT (NO basePath) on port 3001; the API
  // lives under /api and /fe on the SAME domain, routed by Nginx.
  output: "standalone",
  // This admin app lives INSIDE the ecf-api repo. Without pinning the tracing
  // root, Next walks up to the repo root and nests the output under
  // .next/standalone/admin/. Pin it to THIS folder so server.js lands flat at
  // .next/standalone/server.js (what the Dockerfile copies).
  outputFileTracingRoot: path.resolve(__dirname),
  // Allow images from the backend domain
  images: { remotePatterns: [] },
  // Run on port 3001 to avoid conflict with the NestJS backend (port 3000)
  serverExternalPackages: [],
};

export default nextConfig;
