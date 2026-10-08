import type { ResponseDetails } from "../types.ts";
import { viewPage } from "./page-view.ts";
import type { PageKind, PageView } from "./page-view.ts";
import { rules } from "./rules.ts";
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
  challenge?: ChallengeReport | null;
  response: ResponseDetails;
  html: string | undefined;
  requestUrls: readonly string[];
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

const WHITESPACE = /\s+/gu;

const shorten = (text: string): string => {
  const collapsed = text.replaceAll(WHITESPACE, " ").trim();

  return collapsed.length <= DETAIL_LIMIT ? collapsed : `${collapsed.slice(0, DETAIL_LIMIT - 1)}…`;
};

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

const looksLikeXml = (body: string): boolean =>
  body.trimStart().slice(0, 5).toLowerCase() === "<?xml" && !body.toLowerCase().includes("<html");

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

const PAGE_GATES = {
  interstitial_heavy_script: { interstitial: true, noProse: true },
  interstitial_no_prose: { interstitial: true, noProse: true },
  interstitial_with_prose: { interstitial: true, noProse: false },
  over_html_limit: { interstitial: false, noProse: false },
  over_text_limit: { interstitial: false, noProse: false },
} as const satisfies Record<PageKind, { interstitial: boolean; noProse: boolean }>;

const couldBeInterstitial = (kind: PageKind): boolean => PAGE_GATES[kind].interstitial;

const DOM_GATES = {
  interstitial: couldBeInterstitial,
  no_prose: (kind) => PAGE_GATES[kind].noProse,
  none: () => true,
} satisfies Record<RuleOf<"dom">["gate"], (kind: PageKind) => boolean>;

const domEvidence = (view: PageView): BlockEvidence[] =>
  rulesFrom("dom").flatMap((rule) => {
    if (!DOM_GATES[rule.gate](view.kind)) {
      return [];
    }

    const match = rule.pattern.exec(view.targets[rule.target]);

    return match === null
      ? []
      : [evidenceFor(rule, `${rule.target} matched ${JSON.stringify(match[0])}`)];
  });

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
  const view = viewPage(html);
  const evidence = isHtml ? domEvidence(view) : [];
  const suppressors: BuiltinKind[] = [];

  if (isHtml && view.kind === "interstitial_heavy_script") {
    evidence.push(
      evidenceFor(
        builtin("thin_text_heavy_script"),
        `${view.characters.html} char document, ${view.characters.text} char text, ${view.characters.script} char script`,
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
    interstitial: couldBeInterstitial(view.kind),
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

const classify = ({ html, requestUrls, response, challenge = null }: BlockInput): BlockReport => {
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
    challenge,
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
      challenge: input.challenge ?? null,
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

export const challengeCandidate = (input: BlockInput): BlockEvidence | undefined => {
  const report = classifyResponse(input);

  return report.evidence.find(
    (entry) => isChallengeIssued(entry) && !report.passedChallenges.includes(entry.rule),
  );
};
