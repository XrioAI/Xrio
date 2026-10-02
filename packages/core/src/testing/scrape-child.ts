import { subscribe } from "node:diagnostics_channel";

import { XrioClient } from "../client.ts";
import { isBrowserDriverName } from "../sources/browser/drivers.ts";
import { isLaunchEvent } from "./launch-events.ts";

const CHILD_TIMEOUT_MS = 60_000;

const [mode, browserPath, url, browserDriver = "patchright"] = process.argv.slice(2);

if (
  (mode !== "headless" && mode !== "headed") ||
  browserPath === undefined ||
  url === undefined ||
  !isBrowserDriverName(browserDriver)
) {
  throw new Error("Usage: scrape-child.ts <headless|headed> <browserPath> <url> [cdp|patchright]");
}

subscribe("xrio:event", (message) => {
  if (isLaunchEvent(message)) {
    process.stdout.write(`${JSON.stringify({ launched: Number(message.detail) })}\n`);
  }
});

await using client = new XrioClient({ browserDriver, browserPath, mode });

const result = await client.scrape({ format: "html", timeoutMs: CHILD_TIMEOUT_MS, url });

process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
