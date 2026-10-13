// Run: node errors.ts
import { isXrioError, XrioClient } from "@xrio/core";

const client = new XrioClient({ mode: "http" });

try {
  const result = await client.scrape({
    format: "html",
    timeoutMs: 60_000,
    url: process.argv[2] ?? "https://example.com",
  });

  // HTTP errors and block pages return results, even when status is 200.
  console.log(result.status, result.block.verdict, result.block.vendor);

  if (result.status >= 400 || result.block.verdict !== "ok") {
    console.error("Inspect the response before treating it as successful content.");
    process.exitCode = 1;
  } else {
    console.log(result.data);
  }
} catch (error) {
  if (!isXrioError(error)) {
    throw error;
  }

  console.error(error.code, error.message);

  if (isXrioError(error, "UNSUPPORTED_CONTENT_TYPE")) {
    console.error("Expected HTML; received status", error.details.status);
  }

  process.exitCode = 1;
} finally {
  await client.close();
}
