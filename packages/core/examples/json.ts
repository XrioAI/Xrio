// Run: node json.ts
import { XrioClient } from "@xrio/core";

const client = new XrioClient({ mode: "http" });

try {
  const url = "https://example.com";

  const result = await client.scrape({ format: "json", url });

  // result.data contains structured content. Descriptive metadata fields may be null.
  // result.status, result.headers, and result.url describe the final HTTP response.
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}
