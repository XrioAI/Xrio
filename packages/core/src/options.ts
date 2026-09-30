import type {
  DocumentRequest,
  ModeOptions,
  ResolvedMode,
  ScrapeFormat,
  ScrapeOptions,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

const MAX_TIMEOUT_MS = 2_147_483_647;

export const resolveClientOptions = ({ mode = "http", browserPath }: ModeOptions): ResolvedMode => {
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

export const resolveScrapeOptions = (
  options: ScrapeOptions,
  clientMode: ResolvedMode,
): DocumentRequest & { format: ScrapeFormat } => {
  const { format, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;

  if (format !== "html" && format !== "markdown" && format !== "json") {
    throw new TypeError("Unknown scrape format.");
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
  }

  const url = new URL(options.url);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("url must use HTTP or HTTPS.");
  }

  const mode = options.mode === undefined ? clientMode : resolveClientOptions(options);

  return { ...mode, format, signal, timeoutMs, url };
};
