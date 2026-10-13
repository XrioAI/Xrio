// Run: XRIO_PROXY=http://user:password@proxy.example:8080 node proxy.ts
import { XrioClient } from "@xrio/core";

const proxy = process.env.XRIO_PROXY;

if (proxy === undefined || proxy === "") {
  throw new Error("Set XRIO_PROXY to your provider's concrete proxy URL.");
}

// XRIO_PROXY is read by this example, not automatically by Xrio.
// Pass a config path as the first argument, or use xrio.config.json in the working directory.
const client = new XrioClient({ configFile: process.argv[2], mode: "http", proxy });

try {
  const result = await client.scrape({ format: "markdown", url: "https://example.com" });

  console.log(result.data);

  console.log(result.block.verdict, result.attempts);
} finally {
  await client.close();
}
