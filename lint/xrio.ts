import { definePlugin } from "vite-plus/lint/plugins";

import callsGoDown from "./calls-go-down.ts";
import identityOwner from "./identity-owner.ts";

export default definePlugin({
  meta: { name: "xrio" },
  rules: { "calls-go-down": callsGoDown, "identity-owner": identityOwner },
});
