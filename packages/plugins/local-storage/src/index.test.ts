import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Xrio, definePlugin } from "@xrio/core";
import type { Engine, Logger, ScrapeRequest, ScrapeResult } from "@xrio/core";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { localStoragePlugin } from "./index.ts";

const silent = (): void => undefined;

const logger: Logger = { debug: silent, error: silent, info: silent, warn: silent };

const request: ScrapeRequest = { format: "html", mode: "http", url: "https://example.com/" };

const browser: Engine = {
  fetch: async () =>
    await Promise.resolve({ finalUrl: "https://example.com/a", html: "<h1>Hi</h1>", status: 200 }),
  mode: "headless",
};

const resultFor = (url: string): ScrapeResult => ({
  content: "<p>x</p>",
  contentType: "text/html; charset=utf-8",
  fetchedAt: "2026-01-02T03:04:05.678Z",
  finalUrl: url,
  format: "html",
  mode: "http",
  status: 200,
  url,
});

describe(localStoragePlugin, () => {
  const directories: string[] = [];
  const running: Xrio[] = [];

  const freshDirectory = async (): Promise<string> => {
    const directory = await mkdtemp(path.join(tmpdir(), "xrio-storage-"));
    directories.push(directory);

    return directory;
  };

  afterEach(async () => {
    await Promise.all(
      running.splice(0).map(async (xrio) => {
        await xrio.stop();
      }),
    );
    await Promise.all(
      directories.splice(0).map(async (directory) => {
        await rm(directory, { force: true, recursive: true });
      }),
    );
  });

  const savedFilesFor = async (url: string): Promise<string[]> => {
    const directory = await freshDirectory();
    const plugin = localStoragePlugin({ directory });
    await plugin.hooks.start?.({ logger });
    await plugin.hooks.afterScrape?.({ logger, request, result: resultFor(url) });

    return await readdir(directory);
  };

  it("declares only the steps it uses", () => {
    const xrio = Xrio.create({ log: { enabled: false } }).use(
      localStoragePlugin({ directory: "unused" }),
    );

    expect(xrio.plugins).toStrictEqual([
      { name: "local-storage", steps: ["start", "afterScrape"] },
    ]);
  });

  it("writes each finished scrape into the configured directory, creating it if needed", async () => {
    const target = path.join(await freshDirectory(), "nested", "out");

    const xrio = Xrio.create({ log: { enabled: false } })
      .use(definePlugin({ engines: [browser], hooks: {}, name: "browser" }))
      .use(localStoragePlugin({ directory: target }));

    running.push(xrio);
    await xrio.start();

    await xrio.scrape({ format: "json", mode: "headless", url: "https://example.com/a" });
    await xrio.scrape({ format: "html", mode: "headless", url: "https://example.com/a" });

    const listing = await readdir(target);
    const files = listing.toSorted();
    const jsonFile = files.find((file) => file.endsWith(".json")) ?? "";
    const saved = await readFile(path.join(target, jsonFile), "utf-8");

    expect(files).toHaveLength(2);
    expect(files.every((file) => file.includes("example.com"))).toBeTruthy();
    expect(JSON.parse(saved)).toMatchObject({ html: "<h1>Hi</h1>" });
  });

  it("names files by timestamp, host and format, with colons made filename-safe", async () => {
    const [file] = await savedFilesFor("https://example.com/page");

    expect(file).toMatch(/^2026-01-02T03-04-05\.678Z-example\.com-[0-9a-f]{8}\.html$/u);
  });

  it("falls back to an 'unknown' host when the url cannot be parsed", async () => {
    const [file] = await savedFilesFor("not a url");

    expect(file).toContain("-unknown-");
  });
});
