// Run: node markdown.ts
import { XrioClient } from "@xrio/core";

const client = new XrioClient({ mode: "http" });

try {
  const url = "https://example.com";

  const result = await client.scrape({ format: "markdown", url });

  console.log(result.data);
} finally {
  await client.close();
}
