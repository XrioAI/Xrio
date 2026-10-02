import { existsSync } from "node:fs";

import { configDefaults, defineConfig } from "vite-plus";

import oxfmtConfig from "./oxfmt.config.ts";
import oxlintConfig from "./oxlint.config.ts";

const BLOCK_FIXTURES = new URL("packages/core/src/blocks/fixtures/", import.meta.url);

const BLOCK_TESTS_MISSING_FIXTURES = existsSync(BLOCK_FIXTURES)
  ? []
  : ["packages/core/src/blocks/*.test.ts"];

export default defineConfig({
  fmt: oxfmtConfig,
  lint: {
    ...oxlintConfig,
    options: { typeAware: true, typeCheck: true },
  },
  staged: { "*": "vp check --fix" },
  test: { exclude: [...configDefaults.exclude, ...BLOCK_TESTS_MISSING_FIXTURES] },
});
