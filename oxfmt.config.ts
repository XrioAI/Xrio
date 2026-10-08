import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: ["packages/core/xrio.schema.json"],
  sortImports: true,
});
