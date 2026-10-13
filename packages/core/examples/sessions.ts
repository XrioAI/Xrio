// Run: XRIO_BROWSER_PATH=/absolute/path/to/chrome node sessions.ts
import { XrioClient } from "@xrio/core";

const browserPath = process.env.XRIO_BROWSER_PATH;

if (browserPath === undefined || browserPath === "") {
  throw new Error("Set XRIO_BROWSER_PATH to a Chrome/Chromium 150+ executable.");
}

const client = new XrioClient({
  browserPath,
  mode: "headless",
  stateDir: "./xrio-example-state",
});

try {
  // Reuse the same profile and identity, including on the next run of this script.
  await client.scrape({
    format: "json",
    session: "example-catalog",
    url: "https://example.com",
  });

  const second = await client.scrape({
    format: "markdown",
    session: "example-catalog",
    url: "https://example.com",
  });

  console.log(second.data);

  console.log(await client.sessions.visits("example-catalog", { limit: 2 }));

  // A pool selects a reusable member, growing up to the requested size as needed.
  const pooled = await client.scrape({
    format: "markdown",
    session: { pool: "example-pool", size: 2 },
    url: "https://example.com",
  });

  console.log(pooled.session?.name, pooled.session?.warmth);

  // To remove this example's saved profiles later, use client.sessions.delete(name).
} finally {
  await client.close();
}
