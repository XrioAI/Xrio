import { createAdmission } from "./admission.ts";
import { hostCacheRoot } from "./cache-dir.ts";
import { loadXrioConfig } from "./config.ts";
import { extractContent, getHtml, renderMarkdown } from "./content/formats.ts";
import { createScrapes } from "./coordinator.ts";
import type { Scrapes } from "./coordinator.ts";
import { startDeadline } from "./deadline.ts";
import type { ClientDefaults } from "./intent.ts";
import { resolveClientOptions, resolveScrapeIntent } from "./options.ts";
import type { SessionAdmin, SessionManager } from "./sessions/session.ts";
import { createSessions } from "./sessions/session.ts";
import { profileUse } from "./sources/browser/browser-process.ts";
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

export type { SessionAdmin } from "./sessions/session.ts";

export type { XrioConfig } from "./config.ts";

export type {
  DisplayOptions,
  HardwareOptions,
  HostConfig,
  ScreenSize,
  Taskbar,
  WindowSize,
} from "./host-config.ts";

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
  ModeOptions,
  ScrapeFormat,
  ScrapeOptions,
  ScrapeResult,
  SessionInfo,
  SessionOutcomes,
  SessionSummary,
  SessionVisit,
  SessionVisitFilter,
  StructuredContent,
  WaitFor,
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
  readonly #sessions: SessionManager;

  constructor(options: ClientOptions) {
    const config = loadXrioConfig(options?.configFile);

    this.#defaults = resolveClientOptions(options, config.host, config.scrape);
    this.#hostFacts = hostFactsFor(this.#defaults.cacheDir);

    this.#sessions = createSessions(this.#defaults.stateDir, {
      databaseDir: this.#defaults.databaseDir,
      profileUse,
      warmthMaxAgeMs: this.#defaults.warmthMaxAgeMs,
    });
    this.#scrapes = createScrapes({
      admission: createAdmission(this.#defaults.maxBrowsers),
      comparisonBinary: this.#defaults.browser.browserPath,
      config,
      fonts: createFontEvidenceStore({ root: hostCacheRoot(this.#defaults.cacheDir) }),
      host: this.#hostFacts,
      sessions: this.#sessions,
      sources: createSources(cdpDriver),
    });
  }

  get sessions(): SessionAdmin {
    const { admin } = this.#sessions;

    return {
      delete: async (name) => {
        this.#scrapes.assertOpen();
        await admin.delete(name);
      },
      list: async () => {
        this.#scrapes.assertOpen();

        return await admin.list();
      },
      prune: async (options) => {
        this.#scrapes.assertOpen();

        return await admin.prune(options);
      },
      visits: async (name, filter) => {
        this.#scrapes.assertOpen();

        return await admin.visits(name, filter);
      },
    };
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

    const result = {
      ...content,
      block: document.block,
      cookies: document.cookies,
      headers: document.headers,
      identity: document.identity,
      status: document.status,
      url: document.url,
    };

    return document.session === undefined ? result : { ...result, session: document.session };
  }

  async close(): Promise<void> {
    await this.#scrapes.close();
    await this.#sessions.close();
    await this.#hostFacts.settle();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
