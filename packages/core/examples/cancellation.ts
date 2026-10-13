// Run: node cancellation.ts
import { XrioClient } from "@xrio/core";

const client = new XrioClient({ mode: "http" });

const url = "https://example.com";

const controller = new AbortController();

// Any caller can call controller.abort(); this timer simulates a cancellation after 100 ms.
const cancellation = setTimeout(() => {
  controller.abort();
}, 100);

try {
  const result = await client.scrape({ format: "markdown", signal: controller.signal, url });

  console.log(result.data);
} catch (error) {
  if (!controller.signal.aborted || error !== controller.signal.reason) {
    throw error;
  }

  console.log("Scrape cancelled.");
} finally {
  clearTimeout(cancellation);
  await client.close();
}
