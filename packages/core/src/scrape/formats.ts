import { XrioError } from "../errors.ts";
import type { OutputFormat, Page, ScrapeRequest, ScrapeResult } from "./types.ts";

interface PageRecord {
  readonly fetchedAt: string;
  readonly finalUrl: string;
  readonly html: string;
  readonly status: number;
  readonly url: string;
}

interface Rendering {
  readonly contentType: string;
  readonly render: (record: PageRecord) => string;
}

const CDATA_END = /\]\]>/gu;

const XML_SPECIALS = /[&<>"']/gu;

const XML_ENTITIES = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&apos;"],
]);

const escapeXml = (text: string): string =>
  text.replaceAll(XML_SPECIALS, (character) => XML_ENTITIES.get(character) ?? character);

const toCdata = (text: string): string =>
  `<![CDATA[${text.replaceAll(CDATA_END, "]]]]><![CDATA[>")}]]>`;

const toCsvField = (value: number | string): string => `"${String(value).replaceAll('"', '""')}"`;

const renderXml = (record: PageRecord): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<page>",
    `<url>${escapeXml(record.url)}</url>`,
    `<finalUrl>${escapeXml(record.finalUrl)}</finalUrl>`,
    `<status>${record.status}</status>`,
    `<fetchedAt>${record.fetchedAt}</fetchedAt>`,
    `<html>${toCdata(record.html)}</html>`,
    "</page>",
  ].join("");

const renderCsv = (record: PageRecord): string =>
  [
    "url,final_url,status,fetched_at,html",
    [record.url, record.finalUrl, record.status, record.fetchedAt, record.html]
      .map(toCsvField)
      .join(","),
  ].join("\n");

/** Markdown needs an HTML-to-Markdown converter, which is not part of the scaffold yet. */
const renderings: Record<OutputFormat, Rendering | undefined> = {
  csv: { contentType: "text/csv; charset=utf-8", render: renderCsv },
  html: { contentType: "text/html; charset=utf-8", render: (record) => record.html },
  json: {
    contentType: "application/json; charset=utf-8",
    render: (record) => JSON.stringify(record),
  },
  md: undefined,
  xml: { contentType: "application/xml; charset=utf-8", render: renderXml },
};

const renderingFor = (format: OutputFormat): Rendering => {
  const rendering = renderings[format];

  if (!rendering) {
    throw new XrioError("format_unsupported", `Output format "${format}" is not implemented yet.`);
  }

  return rendering;
};

/** Lets callers fail before spending a network request on a format that cannot be produced. */
export const assertFormatSupported = (format: OutputFormat): void => {
  renderingFor(format);
};

/** Builds the final result: the fetched page rendered in the format the caller asked for. */
export const buildResult = (request: ScrapeRequest, page: Page): ScrapeResult => {
  const fetchedAt = new Date().toISOString();
  const rendering = renderingFor(request.format);

  const content = rendering.render({
    fetchedAt,
    finalUrl: page.finalUrl,
    html: page.html,
    status: page.status,
    url: request.url,
  });

  return {
    content,
    contentType: rendering.contentType,
    fetchedAt,
    finalUrl: page.finalUrl,
    format: request.format,
    mode: request.mode,
    status: page.status,
    url: request.url,
  };
};
