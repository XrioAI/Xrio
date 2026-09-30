import { defaultServerConditions, defineConfig } from "vite-plus";

import oxfmtConfig from "./oxfmt.config.ts";
import oxlintConfig from "./oxlint.config.ts";

export default defineConfig({
  fmt: oxfmtConfig,
  lint: {
    ...oxlintConfig,
    options: { typeAware: true, typeCheck: true },
  },
  // Workspace packages export a "source" condition so tests run against src/, not a stale dist/.
  ssr: { resolve: { conditions: ["source", ...defaultServerConditions] } },
  staged: { "*": "vp check --fix" },
  test: {
    coverage: {
      exclude: ["**/*.test.ts"],
      include: ["packages/**/src/**/*.ts"],
      provider: "v8",
      thresholds: { branches: 90, functions: 90, lines: 90, statements: 90 },
    },
  },
});
