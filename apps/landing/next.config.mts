import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  turbopack: {
    root: path.resolve(import.meta.dirname, "../.."),
    rules: {
      "*.wgsl": { as: "*.js", loaders: ["@vgpu/wgsl/loader-webpack"] },
    },
  },
};

export default nextConfig;
