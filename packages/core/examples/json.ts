// From the repository root: vp node packages/core/examples/json.ts
import { XrioClient } from "../src/client.ts";

const client = new XrioClient({ mode: "http" });

const url = "https://example.com";

const result = await client.scrape({ format: "json", url });

// result.data contains structured content. Descriptive metadata fields may be null.
// result.status, result.headers, and result.url describe the final HTTP response.
console.log(JSON.stringify(result, null, 2));
