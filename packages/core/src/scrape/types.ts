export const SCRAPE_MODES = ["http", "headless", "headful"] as const;

export type ScrapeMode = (typeof SCRAPE_MODES)[number];

export const OUTPUT_FORMATS = ["html", "md", "xml", "json", "csv"] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Where the scrape should appear to come from. Every field is optional targeting. */
export interface Location {
  readonly country?: string;
  readonly state?: string;
  readonly city?: string;
}

/** What callers hand to `xrio.scrape()`. Only `url` is required. */
export interface ScrapeInput {
  readonly url: string;
  readonly mode?: ScrapeMode;
  readonly location?: Location;
  readonly format?: OutputFormat;
}

/** A validated request with defaults applied. Hooks and engines only ever see this. */
export interface ScrapeRequest {
  readonly url: string;
  readonly mode: ScrapeMode;
  readonly location?: Location;
  readonly format: OutputFormat;
}

/** The raw page an engine fetched, before formatting. */
export interface Page {
  readonly finalUrl: string;
  readonly status: number;
  readonly html: string;
}

export interface ScrapeResult {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly mode: ScrapeMode;
  readonly format: OutputFormat;
  readonly contentType: string;
  readonly content: string;
  readonly fetchedAt: string;
}

/** How an engine should reach the target. Supplied by routing plugins (proxies). */
export interface Route {
  readonly proxyUrl?: string;
}

/** Fetches pages for one scrape mode. Browser modes ship as plugins that contribute an engine. */
export interface Engine {
  readonly mode: ScrapeMode;
  fetch: (request: ScrapeRequest, route: Route) => Promise<Page>;
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
}
