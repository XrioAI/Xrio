import { hostCacheRoot } from "./cache-dir.ts";
import { extractContent, getHtml, renderMarkdown } from "./content/formats.ts";
import { startDeadline } from "./deadline.ts";
import { clientClosed } from "./errors.ts";
import type { ClientDefaults } from "./intent.ts";
import { resolveClientOptions, resolveScrapeIntent } from "./options.ts";
import { createBrowsers } from "./sources/browser/browsers.ts";
import type { Browsers } from "./sources/browser/browsers.ts";
import { cdpDriver } from "./sources/browser/cdp/driver.ts";
import { createFontEvidenceStore } from "./sources/browser/font-evidence.ts";
import { hostFactsFor } from "./sources/browser/host-facts.ts";
import type { ClientHostFacts } from "./sources/browser/host-facts.ts";
import { loadHttpDocument } from "./sources/http.ts";
import type {
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

export type {
  BrowserIdentityReport,
  Coverage,
  CoverageReason,
  CoveredSurface,
  HttpIdentityReport,
  IdentityCoverage,
  IdentityReport,
  ObservedIdentity,
} from "./humanizer/report.ts";

export type { SurfaceChoices } from "./humanizer/surfaces.ts";

export type { IdentityMismatch, IdentityTell } from "./humanizer/verify.ts";

export type { ErrorCode, InvalidOptionsError, XrioErrorCode } from "./errors.ts";

export type {
  ClientOptions,
  DisplayOptions,
  ModeOptions,
  ScrapeFormat,
  ScrapeOptions,
  ScrapeResult,
  ScreenSize,
  StructuredContent,
  Taskbar,
  WindowSize,
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
  readonly #hostFacts: ClientHostFacts;
  readonly #inFlight = new Set<Promise<unknown>>();
  #closed = false;

  constructor(options: ClientOptions) {
    this.#defaults = resolveClientOptions(options);
    this.#hostFacts = hostFactsFor(this.#defaults.cacheDir);
    this.#browsers = createBrowsers(cdpDriver, this.#defaults.maxBrowsers, {
      fontEvidence: createFontEvidenceStore({ root: hostCacheRoot(this.#defaults.cacheDir) }),
      hostCapabilities: this.#hostFacts.snapshotFor,
    });
  }

  scrape<Format extends ScrapeFormat>(
    options: ScrapeOptions<Format>,
  ): Promise<ScrapeResult<Format>>;
  async scrape(options: ScrapeOptions): Promise<ScrapeResult> {
    if (this.#closed) {
      throw clientClosed();
    }

    const { format, identity, route, signal, source, timeoutMs, url } = resolveScrapeIntent(
      options,
      this.#defaults,
    );

    using deadline = startDeadline(timeoutMs, signal);

    const document = await this.#loadDocument({
      ...source,
      deadline,
      pins: identity,
      proxy: route,
      url,
    });

    deadline.throwIfExpired();
    const content = formats[format](document);
    deadline.throwIfExpired();

    return {
      ...content,
      block: document.block,
      cookies: document.cookies,
      headers: document.headers,
      identity: document.identity,
      status: document.status,
      url: document.url,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([this.#browsers.close(), ...this.#inFlight]);
    await this.#hostFacts.settle();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async #loadDocument(request: DocumentRequest): Promise<SourceDocument> {
    const loading =
      request.mode === "http"
        ? loadHttpDocument(request, this.#hostFacts, this.#defaults.browser.browserPath)
        : this.#browsers.load(request);

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
