import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import next from "ultracite/oxlint/next";
import react from "ultracite/oxlint/react";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, react, next, vitest, antiSlop],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: [
    "oxlint-plugin-complexity",
    { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
  ],
  options: { typeAware: true },
  overrides: [
    {
      files: ["packages/core/examples/**/*.ts"],
      rules: { "no-console": "off" },
    },
  ],
  rules: {
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/require-readable-spacing": "error",
    // The patched plugin exempts JSX components and checks their handlers separately.
    complexity: "off",
    "complexity/complexity": ["error", { cognitive: 15, cyclomatic: 20, minLines: 0 }],
    "vite-plus/prefer-vite-plus-imports": "error",
  },
  settings: { next: { rootDir: ["apps/landing/"] } },
});
