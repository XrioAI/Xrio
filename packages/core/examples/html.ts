// Run: node html.ts
import { XrioClient } from "@xrio/core";

// Select HTTP explicitly to scrape without a browser.
const client = new XrioClient({ mode: "http" });

try {
  const url = "https://example.com";

  const result = await client.scrape({ format: "html", url });

  console.log(result.data);
} finally {
  await client.close();
}
