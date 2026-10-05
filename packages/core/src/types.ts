import type { BlockReport } from "./blocks/classify.ts";
import type { IdentityReport } from "./humanizer/report.ts";

export type ScrapeFormat = "html" | "markdown" | "json";

interface HttpMode {
  mode: "http";
  browserPath?: never;
}

interface BrowserMode {
  mode: "headless" | "headed";
  browserPath: string;
}

export interface ScreenSize {
  width: number;
  height: number;
}

export interface Taskbar {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface WindowSize {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

type Weighted<Value> = Value & { weight: number };

export interface DisplayOptions {
  screen?: ScreenSize | readonly Weighted<ScreenSize>[];
  taskbar?: Taskbar | readonly Weighted<Taskbar>[];
  window?:
    | "maximized"
    | WindowSize
    | readonly (Weighted<WindowSize> | { maximized: true; weight: number })[];
}

export type ModeOptions = HttpMode | BrowserMode | { mode?: never; browserPath: string };

interface BrowserChoices {
  timezone?: string;
  display?: DisplayOptions;
}

type ModeOverride =
  | (HttpMode & { timezone?: never; display?: never })
  | (BrowserMode & BrowserChoices)
  | ({ mode?: never; browserPath?: never } & BrowserChoices);

export type ClientOptions = (
  | {
      mode: "http";
      browserPath?: string;
      browserArgs?: readonly string[];
      timezone?: never;
      display?: never;
    }
  | ((BrowserMode | { mode?: never; browserPath: string }) &
      BrowserChoices & { browserArgs?: readonly string[] })
) & { proxy?: string; maxBrowsers?: number; locale?: string; cacheDir?: string };

export type ScrapeOptions<Format extends ScrapeFormat = ScrapeFormat> = ModeOverride & {
  url: string;
  format: Format;
  proxy?: string;
  locale?: string;
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
  html: string;
  block: BlockReport;
  requestUrls: readonly string[];
  identity: IdentityReport;
}

export type RenderedDocument = Pick<SourceDocument, "html" | "url">;

export type ResolvedMode = HttpMode | BrowserMode;

export interface ProxyEndpoint {
  protocol: "http" | "https" | "socks5";
  hostname: string;
  port: number;
  credentials: { username: string; password: string } | undefined;
  redactedUrl: string;
}
