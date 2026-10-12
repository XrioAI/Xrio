import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    copy: { from: "node_modules/@mdream/js/LICENSE.md", rename: "mdream-LICENSE.md" },
    deps: { alwaysBundle: ["@mdream/js"], onlyBundle: ["@mdream/js"] },
    dts: true,
    entry: ["src/client.ts"],
    format: "esm",
    platform: "node",
    target: "node24",
  },
});
