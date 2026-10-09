import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: ["chromium-fork/**", "packages/core/xrio.schema.json"],
  sortImports: true,
});
