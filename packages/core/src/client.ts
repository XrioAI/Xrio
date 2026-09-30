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
  SourceDocument,
  StructuredContent,
} from "./types.ts";

export type { ModeOptions, ScrapeFormat, ScrapeOptions, StructuredContent } from "./types.ts";

const sources = {
  headed: loadHeadedDocument,
  headless: loadHeadlessDocument,
  http: loadHttpDocument,
} satisfies Record<ResolvedMode["mode"], (request: DocumentRequest) => Promise<SourceDocument>>;

const formats = {
  html: getHtml,
  json: extractContent,
  markdown: renderMarkdown,
} satisfies Record<ScrapeFormat, (document: SourceDocument) => string | StructuredContent>;

export class XrioClient {
  readonly #mode: ResolvedMode;

  constructor(options: ModeOptions = {}) {
    this.#mode = resolveClientOptions(options);
  }

  scrape(options: ScrapeOptions<"html" | "markdown">): Promise<string>;
  scrape(options: ScrapeOptions<"json">): Promise<StructuredContent>;
  scrape(options: ScrapeOptions): Promise<string | StructuredContent>;
  async scrape(options: ScrapeOptions): Promise<string | StructuredContent> {
    const request = resolveScrapeOptions(options, this.#mode);
    const loadDocument = sources[request.mode];
    const renderContent = formats[request.format];

    const document = await loadDocument(request);

    return renderContent(document);
  }
}
