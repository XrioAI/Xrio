import { classifyResponse } from "../blocks/classify.ts";
import type { BlockInput, BlockVerdict } from "../blocks/classify.ts";
import { viewPage } from "../blocks/page-view.ts";
import type { PageKind, PageView } from "../blocks/page-view.ts";
import { rules } from "../blocks/rules.ts";
import type { Rule } from "../blocks/rules.ts";
import type { ResponseDetails } from "../types.ts";
import { akamaiCases } from "./block-cases/akamai.ts";
import { awsWafCases } from "./block-cases/aws-waf.ts";
import { cloudflareCases } from "./block-cases/cloudflare.ts";
import { datadomeCases } from "./block-cases/datadome.ts";
import { genericCases } from "./block-cases/generic.ts";
import { impervaCases } from "./block-cases/imperva.ts";
import { kasadaCases } from "./block-cases/kasada.ts";
import { linkedinCases } from "./block-cases/linkedin.ts";
import { perimeterxCases } from "./block-cases/perimeterx.ts";
import { queueItCases } from "./block-cases/queue-it.ts";
import { spurCases } from "./block-cases/spur.ts";
import { ticketmasterCases } from "./block-cases/ticketmaster.ts";
import { vercelCases } from "./block-cases/vercel.ts";

type RuleId = (typeof rules)[number]["id"];

type Vendor = Extract<(typeof rules)[number], { vendor: string }>["vendor"];

type HeaderRule = Extract<Rule, { source: "response_header" }>;

export interface ObservedPath {
  readonly decoys: readonly string[];
  readonly page: PageKind;
  readonly passedChallenges: readonly string[];
  readonly ruleIds: readonly string[];
  readonly vendor: string | null;
  readonly verdict: BlockVerdict;
}

export interface DecisionPath extends ObservedPath {
  readonly decoys: readonly RuleId[];
  readonly passedChallenges: readonly RuleId[];
  readonly ruleIds: readonly Exclude<RuleId, "classifier_failure">[];
  readonly vendor: Vendor | null;
  readonly verdict: Exclude<BlockVerdict, "unknown">;
}

interface ServedFacts {
  readonly cookies: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
  readonly html: string;
  readonly status: number;
  readonly url: string;
}

interface Explained {
  readonly why: string;
}

export interface CaseFacts extends ServedFacts {
  readonly requestUrls: readonly string[];
}

export interface ClassifiedCase extends CaseFacts, Explained {
  readonly expect: DecisionPath;
  readonly fault?: never;
}

export interface FailingCase extends ServedFacts, Explained {
  readonly expect?: never;
  readonly fault: "request_log_unreadable";
  readonly requestUrls?: never;
}

export type BlockCase = ClassifiedCase | FailingCase;

export interface NamedCase<Case extends BlockCase> {
  readonly blockCase: Case;
  readonly id: string;
}

const ruleList: readonly Rule[] = rules;

const responseOf = (facts: ServedFacts): ResponseDetails => ({
  cookies: [...facts.cookies],
  headers: { ...facts.headers },
  status: facts.status,
  url: facts.url,
});

const inputOf = (facts: CaseFacts): BlockInput => ({
  html: facts.html,
  requestUrls: facts.requestUrls,
  response: responseOf(facts),
});

export const blockInputOf = (blockCase: BlockCase): BlockInput => {
  if (blockCase.fault === undefined) {
    return inputOf(blockCase);
  }

  return {
    html: blockCase.html,
    get requestUrls(): string[] {
      throw new Error("The request log could not be read.");
    },
    response: responseOf(blockCase),
  };
};

const headerMarked = (rule: HeaderRule, headers: Readonly<Record<string, string>>): boolean => {
  const pattern = "pattern" in rule ? rule.pattern : undefined;

  return Object.entries(headers).some(([name, value]) => {
    const namesMatch = "header" in rule ? name === rule.header : name.startsWith(rule.headerPrefix);

    return namesMatch && (pattern === undefined || pattern.test(value));
  });
};

const markedRules = (facts: CaseFacts, view: PageView): readonly Rule[] =>
  Object.values({
    builtin: [],
    dom: ruleList.filter(
      (rule) => rule.source === "dom" && rule.pattern.test(view.targets[rule.target]),
    ),
    final_url: [],
    request_log: ruleList.filter(
      (rule) =>
        rule.source === "request_log" && facts.requestUrls.some((url) => rule.pattern.test(url)),
    ),
    response_header: ruleList.filter(
      (rule) => rule.source === "response_header" && headerMarked(rule, facts.headers),
    ),
    set_cookie: ruleList.filter(
      (rule) =>
        rule.source === "set_cookie" && facts.cookies.some((cookie) => rule.pattern.test(cookie)),
    ),
    status: [],
  } satisfies Record<Rule["source"], readonly Rule[]>).flat();

export const decisionPathOf = (facts: CaseFacts): ObservedPath => {
  const report = classifyResponse(inputOf(facts));
  const view = viewPage(facts.html);
  const counted = new Set(report.evidence.map((entry) => entry.rule));

  return {
    decoys: markedRules(facts, view)
      .filter((rule) => !counted.has(rule.id))
      .map((rule) => rule.id)
      .toSorted(),
    page: view.kind,
    passedChallenges: report.passedChallenges.toSorted(),
    ruleIds: [...counted].toSorted(),
    vendor: report.vendor,
    verdict: report.verdict,
  };
};

export const casesByVendor = {
  akamai: akamaiCases,
  aws_waf: awsWafCases,
  cloudflare: cloudflareCases,
  datadome: datadomeCases,
  generic: genericCases,
  imperva: impervaCases,
  kasada: kasadaCases,
  linkedin: linkedinCases,
  perimeterx: perimeterxCases,
  "queue-it": queueItCases,
  spur: spurCases,
  ticketmaster: ticketmasterCases,
  vercel: vercelCases,
} satisfies Record<Vendor | "generic", Record<string, BlockCase>>;

export const mergedCasesOf = (
  tables: readonly Record<string, BlockCase>[],
): readonly (readonly [string, BlockCase])[] => {
  const byId = new Map<string, BlockCase>();

  for (const table of tables) {
    for (const [id, blockCase] of Object.entries(table)) {
      if (byId.has(id)) {
        throw new Error(`The block case ${id} is defined in more than one vendor file.`);
      }

      byId.set(id, blockCase);
    }
  }

  return [...byId].toSorted(([left], [right]) => (left < right ? -1 : 1));
};

const namedCases = mergedCasesOf(Object.values(casesByVendor));

export const classifiedCases: readonly NamedCase<ClassifiedCase>[] = namedCases.flatMap(
  ([id, blockCase]) => (blockCase.fault === undefined ? [{ blockCase, id }] : []),
);

export const failingCases: readonly NamedCase<FailingCase>[] = namedCases.flatMap(
  ([id, blockCase]) => (blockCase.fault === undefined ? [] : [{ blockCase, id }]),
);
