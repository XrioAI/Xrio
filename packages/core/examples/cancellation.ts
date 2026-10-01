// From the repository root: vp node packages/core/examples/cancellation.ts
import { XrioClient } from "../src/client.ts";

const client = new XrioClient();

const url = "https://example.com";

const controller = new AbortController();

// Any caller can call controller.abort(); this timer simulates a cancellation after 100 ms.
const cancellation = setTimeout(() => {
  controller.abort();
}, 100);

try {
  const markdown = await client.scrape({ format: "markdown", signal: controller.signal, url });

  console.log(markdown);
} catch (error) {
  if (!controller.signal.aborted) {
    throw error;
  }

  console.log("Scrape cancelled.");
} finally {
  clearTimeout(cancellation);
}
