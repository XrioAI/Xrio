import { extractContent, getHtml, renderMarkdown } from "./content/formats.ts";
import { resolveClientOptions, resolveScrapeOptions } from "./options.ts";
import { loadHeadedDocument, loadHeadlessDocument } from "./sources/browser.ts";
import { loadHttpDocument } from "./sources/http.ts";
import type {
  DocumentRequest,
  ModeOptions,
  ResolvedMode,
  ScrapeFormat,
  ScrapeOptions,
  ScrapeResult,
  SourceDocument,
} from "./types.ts";

export { isXrioError, XrioError } from "./errors.ts";

export type { ErrorCode, InvalidOptionsError, XrioErrorCode } from "./errors.ts";

export type {
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
  readonly #mode: ResolvedMode;

  constructor(options: ModeOptions = {}) {
    this.#mode = resolveClientOptions(options);
  }

  scrape<Format extends ScrapeFormat>(
    options: ScrapeOptions<Format>,
  ): Promise<ScrapeResult<Format>>;
  async scrape(options: ScrapeOptions): Promise<ScrapeResult> {
    const request = resolveScrapeOptions(options, this.#mode);
    const loadDocument = sources[request.mode];
    const renderContent = formats[request.format];

    const document = await loadDocument(request);

    return {
      ...renderContent(document),
      cookies: document.cookies,
      headers: document.headers,
      status: document.status,
      url: document.url,
    };
  }
}
