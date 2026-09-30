import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { definePlugin } from "@xrio/core";
import type { Plugin, ScrapeResult } from "@xrio/core";

const UNSAFE_FILENAME_CHARACTERS = /[^a-z0-9.-]/giu;

const UNIQUE_SUFFIX_LENGTH = 8;

export interface LocalStorageOptions {
  /** Directory the scraped files are written to. Created on start if missing. */
  readonly directory: string;
}

const fileNameFor = (result: ScrapeResult): string => {
  const timestamp = result.fetchedAt.replaceAll(":", "-");

  const host = (URL.parse(result.url)?.hostname ?? "unknown").replaceAll(
    UNSAFE_FILENAME_CHARACTERS,
    "_",
  );

  const unique = randomUUID().slice(0, UNIQUE_SUFFIX_LENGTH);

  return `${timestamp}-${host}-${unique}.${result.format}`;
};

/** Saves every finished scrape as one file, named after when, where and in what format. */
export const localStoragePlugin = ({ directory }: LocalStorageOptions): Plugin =>
  definePlugin({
    hooks: {
      afterScrape: async ({ result }) => {
        await writeFile(path.join(directory, fileNameFor(result)), result.content, "utf-8");
      },
      start: async () => {
        await mkdir(directory, { recursive: true });
      },
    },
    name: "local-storage",
  });
