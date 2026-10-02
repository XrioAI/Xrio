import type { Deadline } from "./deadline.ts";

export type ScrapeFormat = "html" | "markdown" | "json";

export type ModeOptions =
  | { mode?: "http"; browserPath?: never }
  | { mode: "headless" | "headed"; browserPath: string };

export type ClientOptions = ModeOptions & { proxy?: string };

export type ScrapeOptions<Format extends ScrapeFormat = ScrapeFormat> = ModeOptions & {
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
  };
}[Format];

export interface SourceDocument extends ResponseDetails {
  html: string;
}

export type ResolvedMode = ModeOptions & { mode: NonNullable<ModeOptions["mode"]> };

export interface ProxyEndpoint {
  protocol: "http" | "https" | "socks5";
  hostname: string;
  port: number;
  credentials: { username: string; password: string } | undefined;
  redactedUrl: string;
}

export interface ClientDefaults {
  mode: ResolvedMode;
  proxy: ProxyEndpoint | undefined;
}

type SourceRequest = ResolvedMode & {
  url: URL;
  proxy: ProxyEndpoint | undefined;
};

export type DocumentRequest = SourceRequest & { deadline: Deadline };

export interface ScrapeRequest {
  format: ScrapeFormat;
  signal: AbortSignal | undefined;
  source: SourceRequest;
  timeoutMs: number;
}
