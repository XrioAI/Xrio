import type { BlockReport } from "./blocks/classify.ts";
import type { IdentityReport } from "./humanizer/report.ts";

export type ScrapeFormat = "html" | "markdown" | "json";

interface HttpMode {
  mode: "http";
  browserPath?: never;
  waitFor?: never;
}

interface BrowserMode {
  mode: "headless" | "headed";
  browserPath: string;
}

export interface WaitFor {
  selector: string;
}

export type ModeOptions = HttpMode | BrowserMode | { mode?: never; browserPath: string };

type ModeOverride =
  | HttpMode
  | (BrowserMode & { waitFor?: WaitFor })
  | { mode?: never; browserPath?: never; waitFor?: WaitFor };

export type ClientOptions = (
  | { mode: "http"; browserPath?: string }
  | BrowserMode
  | { mode?: never; browserPath: string }
) & {
  browserArgs?: readonly string[];
  proxy?: string;
  maxBrowsers?: number;
  cacheDir?: string;
};

export type ScrapeOptions<Format extends ScrapeFormat = ScrapeFormat> = ModeOverride & {
  url: string;
  format: Format;
  proxy?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export interface StructuredContent {
  metadata: {
    url: string;
    title: string | null;
    description: string | null;
    language: string | null;
  };
  content: {
    markdown: string;
    text: string;
    links: { text: string; href: string }[];
    images: { alt: string; src: string }[];
  };
}

export interface ResponseDetails {
  cookies: string[];
  headers: Record<string, string | undefined>;
  status: number;
  url: string;
}

export type ScrapeResult<Format extends ScrapeFormat = ScrapeFormat> = {
  [Selected in Format]: ResponseDetails & {
    data: Selected extends "json" ? StructuredContent : string;
    format: Selected;
    block: BlockReport;
    identity: IdentityReport;
  };
}[Format];

export interface SourceDocument extends ResponseDetails {
  scriptsRan: boolean;
  html: string;
  block: BlockReport;
  requestUrls: readonly string[];
  identity: IdentityReport;
}

export type RenderedDocument = Pick<SourceDocument, "html" | "url"> &
  Partial<Pick<SourceDocument, "scriptsRan">>;

export type ResolvedMode = HttpMode | BrowserMode;

export interface ProxyEndpoint {
  protocol: "http" | "https" | "socks5";
  hostname: string;
  port: number;
  credentials: { username: string; password: string } | undefined;
  redactedUrl: string;
}
