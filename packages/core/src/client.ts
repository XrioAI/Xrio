import { extractContent, getHtml, renderMarkdown } from "./content/formats.ts";
import { startDeadline } from "./deadline.ts";
import { clientClosed } from "./errors.ts";
import { resolveClientOptions, resolveScrapeOptions } from "./options.ts";
import { createBrowsers } from "./sources/browser/browsers.ts";
import type { Browsers } from "./sources/browser/browsers.ts";
import { patchrightDriver } from "./sources/browser/patchright/driver.ts";
import { loadHttpDocument } from "./sources/http.ts";
import type {
  ClientDefaults,
  ClientOptions,
  DocumentRequest,
  ScrapeFormat,
  ScrapeOptions,
  ScrapeResult,
  SourceDocument,
} from "./types.ts";

export type {
  BlockEvidence,
  BlockReport,
  BlockVerdict,
  ChallengeOutcome,
  ChallengeReport,
  ChallengeRound,
} from "./blocks/classify.ts";

export { isXrioError, XrioError } from "./errors.ts";

export { loadXrioConfig } from "./config.ts";

export type { XrioConfig } from "./config.ts";

export { ProxyManager } from "./proxy/manager.ts";

export type { ScrapeOutcome } from "./proxy/manager.ts";

export type { ProxyConfig, SessionOptions, SessionTemplate } from "./proxy/config.ts";

export type { ProxyInfo } from "./proxy/info.ts";

export type { ErrorCode, InvalidOptionsError, XrioErrorCode } from "./errors.ts";

export type {
  ClientOptions,
  ModeOptions,
  ScrapeFormat,
  ScrapeOptions,
  ScrapeResult,
  StructuredContent,
} from "./types.ts";

const formats = {
  html: (document) => ({ data: getHtml(document), format: "html" }),
  json: (document) => ({ data: extractContent(document), format: "json" }),
  markdown: (document) => ({ data: renderMarkdown(document), format: "markdown" }),
} satisfies {
  [Format in ScrapeFormat]: (
    document: SourceDocument,
  ) => Pick<ScrapeResult<Format>, "data" | "format">;
};

export class XrioClient {
  readonly #defaults: ClientDefaults;
  readonly #browsers: Browsers;
  readonly #inFlight = new Set<Promise<unknown>>();
  #closed = false;

  constructor(options: ClientOptions) {
    this.#defaults = resolveClientOptions(options);
    this.#browsers = createBrowsers(patchrightDriver, this.#defaults.maxBrowsers);
  }

  scrape<Format extends ScrapeFormat>(
    options: ScrapeOptions<Format>,
  ): Promise<ScrapeResult<Format>>;
  async scrape(options: ScrapeOptions): Promise<ScrapeResult> {
    if (this.#closed) {
      throw clientClosed();
    }

    const { format, signal, source, timeoutMs } = resolveScrapeOptions(options, this.#defaults);
    using deadline = startDeadline(timeoutMs, signal);

    const document = await this.#loadDocument({ ...source, deadline });

    deadline.throwIfExpired();
    const content = formats[format](document);
    deadline.throwIfExpired();

    return {
      ...content,
      block: document.block,
      cookies: document.cookies,
      headers: document.headers,
      status: document.status,
      url: document.url,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([this.#browsers.close(), ...this.#inFlight]);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async #loadDocument(request: DocumentRequest): Promise<SourceDocument> {
    const loading =
      request.mode === "http" ? loadHttpDocument(request) : this.#browsers.load(request);

    this.#inFlight.add(loading);

    try {
      return await loading;
    } catch (error) {
      request.deadline.throwIfExpired();
      throw error;
    } finally {
      this.#inFlight.delete(loading);
    }
  }
}
