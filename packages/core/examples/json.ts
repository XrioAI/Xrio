// From the repository root: vp node packages/core/examples/json.ts
import { XrioClient } from "../src/client.ts";

const client = new XrioClient();

const url = "https://example.com";

const page = await client.scrape({ format: "json", url });

// JSON mode returns an object. Descriptive metadata fields may be null.
// page.content includes Markdown, text, links, and images.
console.log(JSON.stringify(page, null, 2));
