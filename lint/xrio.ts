import { definePlugin } from "vite-plus/lint/plugins";

import identityOwner from "./identity-owner.ts";

export default definePlugin({
  meta: { name: "xrio" },
  rules: { "identity-owner": identityOwner },
});
