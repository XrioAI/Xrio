import { XrioClient } from "../client.ts";

const [url] = process.argv.slice(2);

if (url === undefined) {
  throw new Error("Usage: unclosed-http-child.ts <url>");
}

const client = new XrioClient({ mode: "http" });

const result = await client.scrape({ format: "html", url });

process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
