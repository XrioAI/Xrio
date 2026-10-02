import { invalidOptions, redactUrl } from "./errors.ts";
import type {
  DocumentRequest,
  ModeOptions,
  ResolvedMode,
  ScrapeFormat,
  ScrapeOptions,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

const MAX_TIMEOUT_MS = 2_147_483_647;

const parseTargetUrl = (value: string): URL => {
  const url = URL.parse(value);

  if (url === null) {
    throw invalidOptions("url must be an absolute URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidOptions("url must use HTTP or HTTPS.");
  }

  if (url.username !== "" || url.password !== "") {
    throw invalidOptions(`url must not include credentials: ${redactUrl(url)}`);
  }

  return url;
};

export const resolveClientOptions = ({ mode = "http", browserPath }: ModeOptions): ResolvedMode => {
  switch (mode) {
    case "http": {
      return { mode };
    }

    case "headless":
    case "headed": {
      if (browserPath === undefined || browserPath.trim().length === 0) {
        throw invalidOptions(`browserPath is required for ${mode} mode.`);
      }

      return { browserPath, mode };
    }

    default: {
      throw invalidOptions("Unknown scrape mode.");
    }
  }
};

export const resolveScrapeOptions = (
  options: ScrapeOptions,
  clientMode: ResolvedMode,
): DocumentRequest & { format: ScrapeFormat } => {
  const { format, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;

  if (format !== "html" && format !== "markdown" && format !== "json") {
    throw invalidOptions("Unknown scrape format.");
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw invalidOptions(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
  }

  const url = parseTargetUrl(options.url);
  const mode = options.mode === undefined ? clientMode : resolveClientOptions(options);

  return { ...mode, format, signal, timeoutMs, url };
};
