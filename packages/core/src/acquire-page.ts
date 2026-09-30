import type { AcquiredPage, ModeOptions, ScrapeOptions } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

const MAX_TIMEOUT_MS = 2_147_483_647;

const requestUrl = (url: string): URL => {
  const parsed = new URL(url);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("url must use HTTP or HTTPS.");
  }

  return parsed;
};

const requireHtmlResponse = async (response: Response): Promise<void> => {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status} while scraping ${response.url}.`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const [mediaType] = contentType.split(";");

  // ponytail: HTML input only; add plain-text and JSON parsing when needed.
  if (mediaType.trim().toLowerCase() !== "text/html") {
    await response.body?.cancel();
    throw new Error(
      `Expected HTML from ${response.url}; received ${contentType || "no content type"}.`,
    );
  }
};

export const acquirePage = async (
  {
    url,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  }: Pick<ScrapeOptions, "url" | "timeoutMs" | "signal">,
  mode: ModeOptions,
): Promise<AcquiredPage> => {
  if (mode.mode === "headless" || mode.mode === "headed") {
    throw new Error(`The ${mode.mode} mode is not implemented.`);
  }

  const target = requestUrl(url);

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(target, { signal: requestSignal });

  await requireHtmlResponse(response);

  return { html: await response.text(), url: response.url };
};
