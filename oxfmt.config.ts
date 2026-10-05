import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: ["packages/core/src/blocks/fixtures/**"],
  sortImports: true,
});
