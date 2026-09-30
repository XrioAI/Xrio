import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: true,
    entry: ["src/client.ts"],
    format: "esm",
    platform: "node",
    target: "node24",
  },
});
