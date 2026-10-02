// From the repository root: vp node packages/core/examples/html.ts
import { XrioClient } from "../src/client.ts";

// HTTP is the default mode; no browserPath is needed.
const client = new XrioClient({ mode: "http" });

const url = "https://example.com";

const result = await client.scrape({ format: "html", url });

console.log(result.data);
