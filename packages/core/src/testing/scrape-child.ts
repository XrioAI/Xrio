import { subscribe } from "node:diagnostics_channel";

import { startDeadline } from "../deadline.ts";
import { createBrowsers } from "../sources/browser/browsers.ts";
import { DRIVERS, isDriverName } from "./drivers.ts";
import { isLaunchEvent } from "./launch-events.ts";

const CHILD_TIMEOUT_MS = 60_000;

const [mode, browserPath, url, driver = "patchright"] = process.argv.slice(2);

if (
  (mode !== "headless" && mode !== "headed") ||
  browserPath === undefined ||
  url === undefined ||
  !isDriverName(driver)
) {
  throw new Error("Usage: scrape-child.ts <headless|headed> <browserPath> <url> [cdp|patchright]");
}

subscribe("xrio:event", (message) => {
  if (isLaunchEvent(message)) {
    process.stdout.write(`${JSON.stringify({ launched: Number(message.detail) })}\n`);
  }
});

const browsers = createBrowsers(DRIVERS[driver], 1);

try {
  using deadline = startDeadline(CHILD_TIMEOUT_MS);

  const document = await browsers.load({
    browserPath,
    deadline,
    mode,
    proxy: undefined,
    url: new URL(url),
  });

  process.stdout.write(`${JSON.stringify({ status: document.status })}\n`);
} finally {
  await browsers.close();
}
