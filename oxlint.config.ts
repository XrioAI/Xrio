import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, vitest, antiSlop],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: [
    "./lint/adapter-boundary.ts",
    "oxlint-plugin-complexity",
    { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
  ],
  options: { typeAware: true },
  overrides: [
    {
      files: ["packages/core/src/sources/browser/patchright/**/*.ts"],
      rules: { "no-restricted-imports": "error", "xrio/adapter-boundary": "error" },
    },
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
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            message:
              "Only sources/browser/patchright/ may use Patchright; go through the BrowserDriver port.",
            name: "patchright-core",
          },
        ],
      },
    ],
    "vite-plus/prefer-vite-plus-imports": "error",
  },
});
