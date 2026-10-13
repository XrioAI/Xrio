// Run: XRIO_BROWSER_PATH=/absolute/path/to/chrome node modes.ts
import { XrioClient } from "@xrio/core";

const browserPath = process.env.XRIO_BROWSER_PATH;

if (browserPath === undefined || browserPath === "") {
  throw new Error("Set XRIO_BROWSER_PATH to a Chrome/Chromium 150+ executable.");
}

const client = new XrioClient({ browserPath, mode: "headless" });

try {
  const url = "https://example.com";

  // Inherit the client's mode and path; wait for rendered content before capture.
  const rendered = await client.scrape({
    format: "json",
    url,
    waitFor: { selector: "p" },
  });

  console.log(rendered.data.metadata.title, rendered.block.verdict);

  // An explicit browser-mode override supplies its own path. Headed needs a display.
  const visible = await client.scrape({ browserPath, format: "markdown", mode: "headed", url });

  console.log(visible.data);

  // An HTTP override does not change the client's headless default.
  const direct = await client.scrape({ format: "html", mode: "http", url });

  console.log(direct.data);
} finally {
  await client.close();
}
