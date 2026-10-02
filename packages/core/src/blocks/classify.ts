import { decodeHTML } from "entities";

import type { ResponseDetails } from "../types.ts";
import { gates, rules } from "./rules.ts";
import type { BuiltinKind, Rule, Tier } from "./rules.ts";

export type BlockVerdict = "ok" | "suspect" | "blocked" | "queued" | "unknown";

export interface BlockEvidence {
  rule: string;
  tier: Tier;
  family: string;
  vendor: string | null;
  detail: string;
}

export type ChallengeOutcome =
  | "passed"
  | "passed_in_place"
  | "rounds_exhausted"
  | "budget_exhausted"
  | "deadline";

export interface ChallengeRound {
  vendor: string | null;
  rule: string;
  waitedMs: number;
}

export interface ChallengeReport {
  outcome: ChallengeOutcome;
  rounds: ChallengeRound[];
}

export interface BlockReport {
  verdict: BlockVerdict;
  vendor: string | null;
  evidence: BlockEvidence[];
  passedChallenges: string[];
  challenge: ChallengeReport | null;
}

export interface BlockInput {
  response: ResponseDetails;
  html: string | undefined;
  requestUrls: readonly string[];
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

type RuleOf<Source extends Rule["source"]> = Extract<Rule, { source: Source }>;

const DETAIL_LIMIT = 160;

const TIER_ORDER = { E0: 0, E1: 1, E2: 2, E3: 3 } as const satisfies Record<Tier, number>;

const HTML_MEDIA_TYPES = new Set(["text/html", "application/xhtml+xml"]);

const SUPPRESSING_KINDS = new Set<BuiltinKind>([
  "content_type_not_html",
  "body_is_json",
  "body_is_xml",
]);

const HTML_ROOTS = new Set([
  "!doctype",
  "html",
  "head",
  "body",
  "meta",
  "title",
  "script",
  "style",
]);

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

const FIRST_TAG = /^\s*(?:<!--.*?-->\s*)*<(?<root>[!A-Z_a-z][\w.:-]*)/su;

const shorten = (text: string): string => {
  const collapsed = text.replaceAll(WHITESPACE, " ").trim();

  return collapsed.length <= DETAIL_LIMIT ? collapsed : `${collapsed.slice(0, DETAIL_LIMIT - 1)}…`;
};

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

const couldBeInterstitial = (page: PageMeasure): boolean =>
  page.htmlChars <= gates.interstitialMaxHtmlChars &&
  page.textChars <= gates.interstitialMaxTextChars;

const isHtmlType = (contentType: string | undefined): boolean =>
  contentType !== undefined &&
  HTML_MEDIA_TYPES.has(contentType.split(";", 1)[0].trim().toLowerCase());

const looksLikeJson = (body: string): boolean => {
  const trimmed = body.trim();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return false;
  }

  try {
    JSON.parse(trimmed);

    return true;
  } catch {
    return false;
  }
};

const looksLikeXml = (body: string): boolean => {
  const trimmed = body.trimStart();

  if (trimmed.slice(0, 5).toLowerCase() === "<?xml") {
    return true;
  }

  const root = FIRST_TAG.exec(trimmed)?.groups?.root?.toLowerCase();

  return root !== undefined && !HTML_ROOTS.has(root) && !trimmed.toLowerCase().includes("<html");
};

const isCoveredHost = (host: string, suffix: string): boolean => {
  const bareHost = host.toLowerCase().replace(/\.$/u, "");
  const bareSuffix = suffix.toLowerCase().replaceAll(/^\.|\.$/gu, "");

  return (
    bareHost !== "" &&
    bareSuffix !== "" &&
    (bareHost === bareSuffix || bareHost.endsWith(`.${bareSuffix}`))
  );
};

const isFromSource = <Source extends Rule["source"]>(
  rule: Rule,
  source: Source,
): rule is RuleOf<Source> => rule.source === source;

const rulesFrom = <Source extends Rule["source"]>(source: Source): RuleOf<Source>[] =>
  rules.flatMap((rule) => (isFromSource(rule, source) ? [rule] : []));

const builtin = (kind: BuiltinKind): Rule => {
  const rule = rules.find((candidate) => candidate.source === "builtin" && candidate.kind === kind);

  if (rule === undefined) {
    throw new Error(`The ruleset has no ${kind} rule.`);
  }

  return rule;
};

const evidenceFor = (rule: Rule, detail: string): BlockEvidence => ({
  detail: shorten(detail),
  family: rule.family,
  rule: rule.id,
  tier: rule.tier,
  vendor: rule.vendor ?? null,
});

const withoutValues = (url: string): string => {
  const parsed = URL.parse(url);

  if (parsed === null) {
    return "an unparsable URL";
  }

  const pairs = parsed.search.slice(1).split("&");

  const names = [
    ...new Set(pairs.flatMap((pair) => (pair.includes("=") ? [pair.split("=", 1)[0]] : []))),
  ];

  const query = names.length === 0 ? "" : `?${names.join("&")}`;

  return `${parsed.origin}${parsed.pathname}${query}`;
};

const requestLogEvidence = (requestUrls: readonly string[]): BlockEvidence[] =>
  rulesFrom("request_log").flatMap((rule) => {
    const url = requestUrls.find((candidate) => rule.pattern.test(candidate));

    return url === undefined ? [] : [evidenceFor(rule, `requested ${withoutValues(url)}`)];
  });

const headerEvidence = (response: ResponseDetails): BlockEvidence[] =>
  rulesFrom("response_header").flatMap((rule) => {
    const pattern = "pattern" in rule ? rule.pattern : undefined;

    const match = Object.entries(response.headers).find(([name, value]) => {
      const namesMatch =
        "header" in rule ? name === rule.header : name.startsWith(rule.headerPrefix);

      return value !== undefined && namesMatch && (pattern === undefined || pattern.test(value));
    });

    if (match === undefined) {
      return [];
    }

    const [name, value] = match;

    return [
      evidenceFor(rule, pattern === undefined ? `${name} present` : `${name}: ${value ?? ""}`),
    ];
  });

const cookieEvidence = (response: ResponseDetails, isHtml: boolean): BlockEvidence[] =>
  rulesFrom("set_cookie").flatMap((rule) => {
    if (rule.requiresHtml && !isHtml) {
      return [];
    }

    const index = response.cookies.findIndex((cookie) => rule.pattern.test(cookie));

    if (index === -1) {
      return [];
    }

    const name = response.cookies[index].split("=", 1)[0].trim();

    return [
      evidenceFor(
        rule,
        `set-cookie #${index + 1} of ${response.cookies.length}: ${name} (value redacted)`,
      ),
    ];
  });

const finalUrlEvidence = (response: ResponseDetails): BlockEvidence[] => {
  const host = URL.parse(response.url)?.hostname ?? "";

  return rulesFrom("final_url").flatMap((rule) =>
    isCoveredHost(host, rule.hostSuffix) ? [evidenceFor(rule, `final host ${host}`)] : [],
  );
};

const statusEvidence = (response: ResponseDetails): BlockEvidence[] =>
  rulesFrom("status").flatMap((rule) =>
    rule.statuses.includes(response.status) ? [evidenceFor(rule, `status ${response.status}`)] : [],
  );

const DOM_GATES = {
  interstitial: (_page, interstitial) => interstitial,
  no_prose: (page, interstitial) => interstitial && page.textChars < gates.minProseChars,
  none: () => true,
} satisfies Record<RuleOf<"dom">["gate"], (page: PageMeasure, interstitial: boolean) => boolean>;

const domEvidence = (page: PageMeasure, interstitial: boolean): BlockEvidence[] =>
  rulesFrom("dom").flatMap((rule) => {
    if (!DOM_GATES[rule.gate](page, interstitial)) {
      return [];
    }

    const match = rule.pattern.exec(page[rule.target]);

    return match === null
      ? []
      : [evidenceFor(rule, `${rule.target} matched ${JSON.stringify(match[0])}`)];
  });

const isThinTextHeavyScript = (page: PageMeasure): boolean =>
  page.htmlChars <= gates.smallPageChars &&
  page.textChars < gates.minProseChars &&
  page.scriptChars >= gates.minScriptChars &&
  page.scriptChars >= page.textChars * gates.scriptToTextRatio;

interface DocumentEvidence {
  evidence: BlockEvidence[];
  interstitial: boolean;
  suppressed: boolean;
}

const documentEvidence = (
  response: ResponseDetails,
  html: string,
  isHtml: boolean,
): DocumentEvidence => {
  const contentType = response.headers["content-type"];
  const page = measurePage(html);
  const interstitial = couldBeInterstitial(page);
  const evidence = isHtml ? domEvidence(page, interstitial) : [];
  const suppressors: BuiltinKind[] = [];

  if (isHtml && isThinTextHeavyScript(page)) {
    evidence.push(
      evidenceFor(
        builtin("thin_text_heavy_script"),
        `${page.htmlChars} char document, ${page.textChars} char text, ${page.scriptChars} char script`,
      ),
    );
  }

  if (!isHtml) {
    suppressors.push("content_type_not_html");
    evidence.push(
      evidenceFor(builtin("content_type_not_html"), `content-type ${contentType ?? "<absent>"}`),
    );
  }

  if (looksLikeJson(html)) {
    suppressors.push("body_is_json");
    evidence.push(evidenceFor(builtin("body_is_json"), "body parses as JSON"));
  } else if (looksLikeXml(html)) {
    suppressors.push("body_is_xml");
    evidence.push(evidenceFor(builtin("body_is_xml"), "body parses as XML"));
  }

  return {
    evidence,
    interstitial,
    suppressed: suppressors.some((kind) => SUPPRESSING_KINDS.has(kind)),
  };
};

const ruleById = new Map<string, Rule>(rules.map((rule) => [rule.id, rule]));

const isChallengeIssued = (entry: BlockEvidence): boolean =>
  ruleById.get(entry.rule)?.proves === "challenge_issued";

const isLoggedChallenge = (entry: BlockEvidence): boolean =>
  isChallengeIssued(entry) && ruleById.get(entry.rule)?.source === "request_log";

interface ChallengeSplit {
  deciding: BlockEvidence[];
  passed: BlockEvidence[];
}

interface Decision {
  verdict: BlockVerdict;
  decidedBy: BlockEvidence[];
}

const splitChallengeIssued = (
  e0: BlockEvidence[],
  captured: boolean,
  interstitial: boolean,
): ChallengeSplit => {
  if (!captured) {
    return { deciding: e0.filter((entry) => !isLoggedChallenge(entry)), passed: [] };
  }

  if (interstitial) {
    return { deciding: e0, passed: [] };
  }

  return {
    deciding: e0.filter((entry) => !isChallengeIssued(entry)),
    passed: e0.filter(isChallengeIssued),
  };
};

const decide = (e0: BlockEvidence[], e1: BlockEvidence[], e2: BlockEvidence[]): Decision => {
  if (e0.length > 0) {
    const overriding = e0.filter((entry) => {
      const rule = ruleById.get(entry.rule);

      return rule?.source === "final_url" && rule.verdict !== undefined;
    });

    return overriding.length === e0.length
      ? { decidedBy: overriding, verdict: "queued" }
      : { decidedBy: e0.filter((entry) => !overriding.includes(entry)), verdict: "blocked" };
  }

  if (e1.length > 0) {
    return { decidedBy: e1, verdict: "blocked" };
  }

  const families = new Set(e2.map((entry) => entry.family));

  if (families.size >= 2) {
    return { decidedBy: e2, verdict: "blocked" };
  }

  return e2.length > 0 ? { decidedBy: e2, verdict: "suspect" } : { decidedBy: [], verdict: "ok" };
};

const classify = ({ html, requestUrls, response }: BlockInput): BlockReport => {
  const captured = html !== undefined;
  const isHtml = captured && isHtmlType(response.headers["content-type"]);
  const document = documentEvidence(response, html ?? "", isHtml);

  const evidence = [
    ...requestLogEvidence(requestUrls),
    ...headerEvidence(response),
    ...cookieEvidence(response, isHtml),
    ...finalUrlEvidence(response),
    ...statusEvidence(response),
    ...document.evidence,
  ].toSorted((left, right) => TIER_ORDER[left.tier] - TIER_ORDER[right.tier]);

  const { deciding, passed } = splitChallengeIssued(
    evidence.filter((entry) => entry.tier === "E0"),
    captured,
    document.interstitial,
  );

  const weak = (tier: Tier) =>
    document.suppressed ? [] : evidence.filter((entry) => entry.tier === tier);

  const { decidedBy, verdict } = decide(deciding, weak("E1"), weak("E2"));

  return {
    challenge: null,
    evidence,
    passedChallenges: passed.map((entry) => entry.rule),
    vendor: decidedBy.find((entry) => entry.vendor !== null)?.vendor ?? null,
    verdict,
  };
};

export const classifyResponse = (input: BlockInput): BlockReport => {
  try {
    return classify(input);
  } catch (error) {
    const reason =
      error instanceof Error ? `${error.name}: ${error.message}` : "classification failed";

    return {
      challenge: null,
      evidence: [
        {
          detail: shorten(reason),
          family: "internal",
          rule: "classifier_failure",
          tier: "E3",
          vendor: null,
        },
      ],
      passedChallenges: [],
      vendor: null,
      verdict: "unknown",
    };
  }
};
