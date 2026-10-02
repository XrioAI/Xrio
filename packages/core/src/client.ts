import { extractContent, getHtml, renderMarkdown } from "./content/formats.ts";
import { startDeadline } from "./deadline.ts";
import { resolveClientOptions, resolveScrapeOptions } from "./options.ts";
import { loadHeadedDocument, loadHeadlessDocument } from "./sources/browser.ts";
import { loadHttpDocument } from "./sources/http.ts";
import type {
  ClientDefaults,
  ClientOptions,
  DocumentRequest,
  ResolvedMode,
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

export type { ErrorCode, InvalidOptionsError, XrioErrorCode } from "./errors.ts";

export type {
  ClientOptions,
  ModeOptions,
  ScrapeFormat,
  ScrapeOptions,
  ScrapeResult,
  StructuredContent,
} from "./types.ts";

const sources = {
  headed: loadHeadedDocument,
  headless: loadHeadlessDocument,
  http: loadHttpDocument,
} satisfies Record<ResolvedMode["mode"], (request: DocumentRequest) => Promise<SourceDocument>>;

const loadDocument = async (request: DocumentRequest): Promise<SourceDocument> => {
  try {
    return await sources[request.mode](request);
  } catch (error) {
    request.deadline.throwIfExpired();
    throw error;
  }
};

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

  constructor(options: ClientOptions = {}) {
    this.#defaults = resolveClientOptions(options);
  }

  scrape<Format extends ScrapeFormat>(
    options: ScrapeOptions<Format>,
  ): Promise<ScrapeResult<Format>>;
  async scrape(options: ScrapeOptions): Promise<ScrapeResult> {
    const { format, signal, source, timeoutMs } = resolveScrapeOptions(options, this.#defaults);
    using deadline = startDeadline(timeoutMs, signal);

    const document = await loadDocument({ ...source, deadline });

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
}
