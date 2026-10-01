export type ScrapeFormat = "html" | "markdown" | "json";

export type ModeOptions =
  | { mode?: "http"; browserPath?: never }
  | { mode: "headless" | "headed"; browserPath: string };

export type ScrapeOptions<Format extends ScrapeFormat = ScrapeFormat> = ModeOptions & {
  url: string;
  format: Format;
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

interface ResponseDetails {
  headers: Record<string, string | string[]>;
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

export type DocumentRequest = ResolvedMode & {
  url: URL;
  timeoutMs: number;
  signal?: AbortSignal;
};
