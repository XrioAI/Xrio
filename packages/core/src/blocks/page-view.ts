import { decodeHTML } from "entities";

import { gates } from "./rules.ts";

export type PageKind =
  | "over_html_limit"
  | "over_text_limit"
  | "interstitial_with_prose"
  | "interstitial_no_prose"
  | "interstitial_heavy_script";

export interface PageView {
  kind: PageKind;
  targets: Record<"html" | "title" | "text", string>;
  characters: Record<"html" | "text" | "script", number>;
}

interface PageMeasure {
  html: string;
  text: string;
  title: string;
  htmlChars: number;
  textChars: number;
  scriptChars: number;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

const SCRIPT_OPENER = /<(?<tag>script)\b/giu;

const NON_TEXT_OPENER = /<(?<tag>style|noscript|template|svg|head)\b/giu;

const closingTag = (tag: string): RegExp => new RegExp(`</${tag}\\s*>`, "giu");

const CLOSING_TAGS = new Map(
  ["script", "style", "noscript", "template", "svg", "head"].map((tag) => [tag, closingTag(tag)]),
);

const TITLE_OPENER = /<title/iu;

const TITLE_CLOSER = /<\/title\s*>/iu;

const ASTRAL = /[\u{10000}-\u{10FFFF}]/gu;

const WHITESPACE = /\s+/gu;

const visibleText = (markup: string): string =>
  decodeHTML(markup).replaceAll(WHITESPACE, " ").trim();

const codePointLength = (text: string): number => text.length - (text.match(ASTRAL)?.length ?? 0);

const titleOf = (html: string): string => {
  const opener = html.search(TITLE_OPENER);
  const contentStart = opener === -1 ? 0 : html.indexOf(">", opener) + 1;

  if (contentStart === 0) {
    return "";
  }

  const rest = html.slice(contentStart);
  const contentLength = rest.search(TITLE_CLOSER);

  return contentLength === -1 ? "" : visibleText(rest.slice(0, contentLength));
};

const charactersIn = (html: string): number =>
  html.length > 2 * gates.interstitialMaxHtmlChars ? html.length : codePointLength(html);

const matchEndFrom = (markup: string, pattern: RegExp, from: number): number | undefined => {
  const search = new RegExp(pattern, "giu");

  search.lastIndex = from;
  const match = search.exec(markup);

  return match === null ? undefined : match.index + match[0].length;
};

const elementSpans = (markup: string, opener: RegExp): Span[] => {
  const spans: Span[] = [];
  const unclosed = new Set<string>();
  let position = 0;

  for (const match of markup.matchAll(opener)) {
    const tag = match.groups?.tag?.toLowerCase() ?? "";
    const closer = CLOSING_TAGS.get(tag);

    if (match.index >= position && closer !== undefined && !unclosed.has(tag)) {
      const openEnd = markup.indexOf(">", match.index + match[0].length);

      if (openEnd === -1) {
        break;
      }

      const end = matchEndFrom(markup, closer, openEnd + 1);

      if (end === undefined) {
        unclosed.add(tag);
      } else {
        spans.push({ end, start: match.index });
        position = end;
      }
    }
  }

  return spans;
};

const openingTagSpans = (markup: string, opener: RegExp): Span[] => {
  const spans: Span[] = [];
  let position = 0;

  for (const match of markup.matchAll(opener)) {
    if (match.index >= position) {
      const openEnd = markup.indexOf(">", match.index + match[0].length);

      if (openEnd === -1) {
        break;
      }

      position = openEnd + 1;
      spans.push({ end: position, start: match.index });
    }
  }

  return spans;
};

const delimitedSpans = (markup: string, opener: string, closer: string): Span[] => {
  const spans: Span[] = [];
  let start = markup.indexOf(opener);

  while (start !== -1) {
    const close = markup.indexOf(closer, start + opener.length);

    if (close === -1) {
      break;
    }

    const end = close + closer.length;

    spans.push({ end, start });
    start = markup.indexOf(opener, end);
  }

  return spans;
};

const withoutSpans = (markup: string, spans: readonly Span[]): string => {
  const kept: string[] = [];
  let position = 0;

  for (const { end, start } of spans) {
    kept.push(markup.slice(position, start));
    position = end;
  }

  kept.push(markup.slice(position));

  return kept.join(" ");
};

const charactersInSpans = (markup: string, spans: readonly Span[]): number => {
  let characters = 0;

  for (const { end, start } of spans) {
    characters += codePointLength(markup.slice(start, end));
  }

  return characters;
};

const measurePage = (html: string): PageMeasure => {
  const htmlChars = charactersIn(html);
  const scanned = { html: html.slice(0, gates.domScanMaxChars), htmlChars, title: titleOf(html) };

  if (htmlChars > gates.interstitialMaxHtmlChars) {
    return { ...scanned, scriptChars: 0, text: "", textChars: 0 };
  }

  const scripts = elementSpans(html, SCRIPT_OPENER);
  const withoutScripts = withoutSpans(html, scripts);
  const scriptTags = openingTagSpans(withoutScripts, SCRIPT_OPENER);
  const withoutScriptTags = withoutSpans(withoutScripts, scriptTags);
  const prose = withoutSpans(withoutScriptTags, elementSpans(withoutScriptTags, NON_TEXT_OPENER));
  const uncommented = withoutSpans(prose, delimitedSpans(prose, "<!--", "-->"));
  const text = visibleText(withoutSpans(uncommented, delimitedSpans(uncommented, "<", ">")));

  return {
    ...scanned,
    scriptChars: charactersInSpans(html, scripts) + charactersInSpans(withoutScripts, scriptTags),
    text,
    textChars: codePointLength(text),
  };
};

const isThinTextHeavyScript = (page: PageMeasure): boolean =>
  page.htmlChars <= gates.smallPageChars &&
  page.textChars < gates.minProseChars &&
  page.scriptChars >= gates.minScriptChars &&
  page.scriptChars >= page.textChars * gates.scriptToTextRatio;

const pageKindOf = (page: PageMeasure): PageKind => {
  if (page.htmlChars > gates.interstitialMaxHtmlChars) {
    return "over_html_limit";
  }

  if (page.textChars > gates.interstitialMaxTextChars) {
    return "over_text_limit";
  }

  if (page.textChars >= gates.minProseChars) {
    return "interstitial_with_prose";
  }

  return isThinTextHeavyScript(page) ? "interstitial_heavy_script" : "interstitial_no_prose";
};

export const viewPage = (html: string): PageView => {
  const page = measurePage(html);

  return {
    characters: { html: page.htmlChars, script: page.scriptChars, text: page.textChars },
    kind: pageKindOf(page),
    targets: { html: page.html, text: page.text, title: page.title },
  };
};
