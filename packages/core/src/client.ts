import { createAdmission } from "./admission.ts";
import { hostCacheRoot } from "./cache-dir.ts";
import { extractContent, getHtml, renderMarkdown } from "./content/formats.ts";
import { createScrapes } from "./coordinator.ts";
import type { Scrapes } from "./coordinator.ts";
import { startDeadline } from "./deadline.ts";
import type { Deadline } from "./deadline.ts";
import { clientClosed } from "./errors.ts";
import type { ClientDefaults, ScrapeIntent } from "./intent.ts";
import { resolveClientOptions, resolveScrapeIntent } from "./options.ts";
import { anonymousSessions } from "./sessions/session.ts";
import { createBrowsers } from "./sources/browser/browsers.ts";
import { cdpDriver } from "./sources/browser/cdp/driver.ts";
import { createFontEvidenceStore } from "./sources/browser/font-evidence.ts";
import { hostFactsFor } from "./sources/browser/host-facts.ts";
import type { ClientHostFacts } from "./sources/browser/host-facts.ts";
import { loadHttpDocument } from "./sources/http.ts";
import type {
  ClientOptions,
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
  readonly #scrapes: Scrapes;
  readonly #hostFacts: ClientHostFacts;
  readonly #inFlight = new Set<Promise<unknown>>();
  #closed = false;

  constructor(options: ClientOptions) {
    this.#defaults = resolveClientOptions(options);
    this.#hostFacts = hostFactsFor(this.#defaults.cacheDir);

    this.#scrapes = createScrapes({
      admission: createAdmission(this.#defaults.maxBrowsers),
      fonts: createFontEvidenceStore({ root: hostCacheRoot(this.#defaults.cacheDir) }),
      host: this.#hostFacts,
      sessions: anonymousSessions(),
      sources: createBrowsers(cdpDriver),
    });
  }

  scrape<Format extends ScrapeFormat>(
    options: ScrapeOptions<Format>,
  ): Promise<ScrapeResult<Format>>;
  async scrape(options: ScrapeOptions): Promise<ScrapeResult> {
    if (this.#closed) {
      throw clientClosed();
    }

    const intent = resolveScrapeIntent(options, this.#defaults);
    using deadline = startDeadline(intent.timeoutMs, intent.signal);
    const document = await this.#loadDocument(intent, deadline);

    deadline.throwIfExpired();
    const content = formats[intent.format](document);
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
    await Promise.allSettled([this.#scrapes.close(), ...this.#inFlight]);
    await this.#hostFacts.settle();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async #loadDocument(intent: ScrapeIntent, deadline: Deadline): Promise<SourceDocument> {
    const { identity, route, source, url } = intent;

    const loading =
      source.mode === "http"
        ? loadHttpDocument(
            { ...source, deadline, pins: identity, proxy: route, url },
            this.#hostFacts,
            this.#defaults.browser.browserPath,
          )
        : this.#scrapes.start({ ...intent, source }, deadline).answer;

    this.#inFlight.add(loading);

    try {
      return await loading;
    } catch (error) {
      deadline.throwIfExpired();
      throw error;
    } finally {
      this.#inFlight.delete(loading);
    }
  }
}
