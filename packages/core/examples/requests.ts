// Run: node requests.ts
import { XrioClient } from "@xrio/core";

const client = new XrioClient({ mode: "http" });

try {
  const result = await client.scrape({
    cookies: ["preference=compact; Path=/; Secure; SameSite=Lax"],
    format: "html",
    headers: { "x-example-request": "xrio" },
    // Explicit HTTP mode is required for custom headers, even on an HTTP client.
    mode: "http",
    url: "https://example.com",
  });

  console.log(result.status, result.headers["content-type"]);

  console.log(result.data);
  // result.cookies contains raw Set-Cookie values; avoid logging real session cookies.
} finally {
  await client.close();
}
