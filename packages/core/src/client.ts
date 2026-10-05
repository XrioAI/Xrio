import { createAdmission } from "./admission.ts";
import { hostCacheRoot } from "./cache-dir.ts";
import { extractContent, getHtml, renderMarkdown } from "./content/formats.ts";
import { createScrapes } from "./coordinator.ts";
import type { Scrapes } from "./coordinator.ts";
import { startDeadline } from "./deadline.ts";
import type { ClientDefaults } from "./intent.ts";
import { resolveClientOptions, resolveScrapeIntent } from "./options.ts";
import { anonymousSessions } from "./sessions/session.ts";
import { cdpDriver } from "./sources/browser/cdp/driver.ts";
import { createFontEvidenceStore } from "./sources/browser/font-evidence.ts";
import { hostFactsFor } from "./sources/browser/host-facts.ts";
import type { ClientHostFacts } from "./sources/browser/host-facts.ts";
import { createSources } from "./sources/source.ts";
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
  HardwareOptions,
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
  readonly #hostFacts: ClientHostFacts;
  readonly #scrapes: Scrapes;

  constructor(options: ClientOptions) {
    this.#defaults = resolveClientOptions(options);
    this.#hostFacts = hostFactsFor(this.#defaults.cacheDir);

    this.#scrapes = createScrapes({
      admission: createAdmission(this.#defaults.maxBrowsers),
      comparisonBinary: this.#defaults.browser.browserPath,
      fonts: createFontEvidenceStore({ root: hostCacheRoot(this.#defaults.cacheDir) }),
      host: this.#hostFacts,
      sessions: anonymousSessions(),
      sources: createSources(cdpDriver),
    });
  }

  scrape<Format extends ScrapeFormat>(
    options: ScrapeOptions<Format>,
  ): Promise<ScrapeResult<Format>>;
  async scrape(options: ScrapeOptions): Promise<ScrapeResult> {
    this.#scrapes.assertOpen();
    const intent = resolveScrapeIntent(options, this.#defaults);
    using deadline = startDeadline(intent.timeoutMs, intent.signal);
    const document = await this.#scrapes.start(intent, deadline).answer;

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
    await this.#scrapes.close();
    await this.#hostFacts.settle();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
