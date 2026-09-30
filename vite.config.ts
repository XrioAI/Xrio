import { defineConfig } from "vite-plus";

import oxfmtConfig from "./oxfmt.config.ts";
import oxlintConfig from "./oxlint.config.ts";

export default defineConfig({
  fmt: oxfmtConfig,
  lint: {
    ...oxlintConfig,
    options: { typeAware: true, typeCheck: true },
  },
  staged: { "*": "vp check --fix" },
});
