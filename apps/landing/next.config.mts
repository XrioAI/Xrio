import { copyFile } from "node:fs/promises";
import path from "node:path";

import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants.js";

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

export default async function configureLanding(phase: string): Promise<NextConfig> {
  if (phase === PHASE_DEVELOPMENT_SERVER || phase === PHASE_PRODUCTION_BUILD) {
    await copyFile(
      new URL("../../packages/core/xrio.schema.json", import.meta.url),
      new URL("public/xrio.schema.json", import.meta.url),
    );
  }

  return nextConfig;
}
