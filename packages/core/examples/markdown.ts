// From the repository root: vp node packages/core/examples/markdown.ts
import { XrioClient } from "../src/client.ts";

const client = new XrioClient({ mode: "http" });

const url = "https://example.com";

const markdown = await client.scrape({ format: "markdown", url });

console.log(markdown);
