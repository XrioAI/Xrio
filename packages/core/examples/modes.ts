// From the repository root: vp node packages/core/examples/modes.ts
import { XrioClient } from "../src/client.ts";

// All modes accept html, markdown, and json. Replace the paths with real Chrome executables.
await using client = new XrioClient({ browserPath: "/path/to/chrome", mode: "headless" });

const url = "https://example.com";

try {
  // Omitting mode inherits BOTH headless mode and the client's browserPath.
  await client.scrape({ format: "json", url });
} catch (error) {
  console.error(error);
}

try {
  // An explicit browser-mode override must provide its own browserPath.
  await client.scrape({
    browserPath: "/path/to/another/chrome",
    format: "markdown",
    mode: "headed",
    url,
  });
} catch (error) {
  console.error(error);
}

// An HTTP override does not change the client's headless default.
const result = await client.scrape({ format: "html", mode: "http", url });

console.log(result.data);

// TypeScript rejects these configurations:
// new XrioClient({ mode: "headless" }); // browserPath is required.
// new XrioClient({ mode: "http", browserPath: "/path/to/chrome" }); // HTTP has no browserPath.
// client.scrape({ url }); // format is required.
// client.scrape({ url, format: "html", mode: "headed" }); // Overrides require their own path.
