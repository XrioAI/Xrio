import { acquirePage } from "./acquire-page.ts";
import { transformPage } from "./transform-page.ts";
import type { JsonPage, ModeOptions, ScrapeOptions } from "./types.ts";

export type { JsonPage, ModeOptions, ScrapeFormat, ScrapeOptions } from "./types.ts";

const resolveMode = ({ mode = "http", browserPath }: ModeOptions): ModeOptions => {
  switch (mode) {
    case "http": {
      return { mode };
    }

    case "headless":
    case "headed": {
      if (browserPath === undefined || browserPath.trim().length === 0) {
        throw new TypeError(`browserPath is required for ${mode} mode.`);
      }

      return { browserPath, mode };
    }

    default: {
      throw new TypeError("Unknown scrape mode.");
    }
  }
};

export class XrioClient {
  readonly #mode: ModeOptions;

  constructor(options: ModeOptions = {}) {
    this.#mode = resolveMode(options);
  }

  scrape(options: ScrapeOptions<"html" | "markdown">): Promise<string>;
  scrape(options: ScrapeOptions<"json">): Promise<JsonPage>;
  scrape(options: ScrapeOptions): Promise<string | JsonPage>;
  async scrape(options: ScrapeOptions): Promise<string | JsonPage> {
    const { url, format, timeoutMs, signal } = options;

    if (format !== "html" && format !== "markdown" && format !== "json") {
      throw new TypeError("Unknown scrape format.");
    }

    const mode = options.mode === undefined ? this.#mode : resolveMode(options);
    const page = await acquirePage({ signal, timeoutMs, url }, mode);

    return transformPage(page, format);
  }
}
