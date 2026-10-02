import { existsSync } from "node:fs";

import { defineConfig } from "vite-plus";

import oxfmtConfig from "./oxfmt.config.ts";
import oxlintConfig from "./oxlint.config.ts";

const BLOCK_FIXTURES = new URL("packages/core/src/blocks/fixtures/", import.meta.url);

const BLOCK_TESTS_MISSING_FIXTURES = existsSync(BLOCK_FIXTURES)
  ? []
  : ["packages/core/src/blocks/*.test.ts"];

const BROWSER_TESTS = "**/*.browser.test.ts";

export default defineConfig({
  fmt: oxfmtConfig,
  lint: {
    ...oxlintConfig,
    options: { typeAware: true, typeCheck: true },
  },
  staged: { "*": "vp check --fix" },
  test: {
    projects: [
      {
        extends: true,
        test: {
          exclude: [
            BROWSER_TESTS,
            "**/node_modules/**",
            "chromium-fork/**",
            ...BLOCK_TESTS_MISSING_FIXTURES,
          ],
          name: "unit",
        },
      },
      {
        extends: true,
        test: {
          fileParallelism: false,
          include: [BROWSER_TESTS],
          name: "browser",
          testTimeout: 120_000,
        },
      },
    ],
  },
});
