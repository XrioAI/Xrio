import { describe, expect, it } from "vite-plus/test";

import type { ResponseDetails } from "../types.ts";
import { classifyResponse } from "./classify.ts";
import { rules } from "./rules.ts";
import type { Rule } from "./rules.ts";

type NonSignal =
  | { kind: "header"; name: Lowercase<string>; reason: string; value: string }
  | { kind: "cookie"; cookie: string; reason: string }
  | { kind: "dom"; markup: string; reason: string }
  | { kind: "request"; reason: string; url: string };

const nonSignals: readonly NonSignal[] = [
  {
    kind: "header",
    name: "cf-ray",
    reason: "Present on every response from a Cloudflare-fronted origin, blocked or not.",
    value: "8f3a1c2d4e5f6789-FRA",
  },
  {
    kind: "header",
    name: "server",
    reason: "Names the CDN in front of the origin and says nothing about the verdict.",
    value: "cloudflare",
  },
  {
    kind: "header",
    name: "cf-cache-status",
    reason: "Cache metadata from the edge, unrelated to any mitigation decision.",
    value: "HIT",
  },
  {
    kind: "header",
    name: "x-iinfo",
    reason: "Imperva stamps it on all traffic it fronts.",
    value: "12-34567890-34567891 NNNY CT(0 0 0) RT(1712345678 99) q(0 0 0 -1) r(2 2) U6",
  },
  {
    kind: "header",
    name: "x-akamai-transformed",
    reason: "Akamai front-end optimization marker, present on delivered content.",
    value: "9 12345 0 pmb=mRUM,1",
  },
  {
    cookie: "__cf_bm=Xk3nT9pQ7wLm2vR8sYbN1cZd0hF4jG6a-1712345678-1.0.1.1-abcdef; Path=/; Secure",
    kind: "cookie",
    reason: "Cloudflare's bot-management cookie is set on normal traffic.",
  },
  {
    cookie: "cf_clearance=1a2b3c4d5e6f7g8h9i0j-1712345678-1.2.1.1-xyz; Path=/; Secure",
    kind: "cookie",
    reason: "It proves a challenge was already passed, which is the opposite of a block signal.",
  },
  {
    cookie: "datadome=9fLk2mQpXr7sT4vY1bN8cZd0hG6jA3wE5uI; Path=/; Secure",
    kind: "cookie",
    reason: "DataDome's client cookie is set on every response it handles.",
  },
  {
    kind: "header",
    name: "x-datadome",
    reason:
      "It reports that DataDome fronts the origin and is identical on a delivered page and on a captcha block.",
    value: "protected",
  },
  {
    kind: "header",
    name: "x-datadome-cid",
    reason:
      "It marks a response DataDome generated, which separates generated pages from origin-served ones and never blocked from served.",
    value: "REDACTED",
  },
  {
    cookie: "_abck=7F3A1C2D4E5F6789~0~YAAQwF8vLm2vR8sYbN1cZd0hG6jA~-1~-1~-1; Path=/",
    kind: "cookie",
    reason: "The resolved sensor state means the Akamai sensor validated the client.",
  },
  {
    cookie: "_abck=7F3A1C2D4E5F6789~-1~YAAQwF8vLm2vR8sYbN1cZd0hG6jA~-1~-1~-1; Path=/",
    kind: "cookie",
    reason:
      "The unvalidated sensor state also rides delivered content, so it cannot count as a block signal.",
  },
  {
    cookie: "visid_incap_1234567=Xk3nT9pQ7wLm2vR8sYbN1c; Path=/",
    kind: "cookie",
    reason: "Imperva's visitor id is set on all traffic.",
  },
  {
    kind: "dom",
    markup: '<div class="cf-turnstile" data-sitekey="1x00000000000000000000AA"></div>',
    reason:
      "A site owner's own Turnstile widget on their own form, which a managed challenge never renders.",
  },
  {
    kind: "dom",
    markup:
      '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>',
    reason:
      "The public Turnstile widget bundle, loaded by the page author; the challenge platform path is the block signal.",
  },
  {
    kind: "request",
    reason: "The same Turnstile bundle seen from the request log.",
    url: "https://challenges.cloudflare.com/turnstile/v0/api.js",
  },
  {
    kind: "request",
    reason:
      "Cloudflare JS Detections is passive and loads on pages that render fine, so the challenge rules require the orchestrate, cv or flow paths instead.",
    url: "https://shop.example.com/cdn-cgi/challenge-platform/scripts/jsd/main.js",
  },
  {
    kind: "request",
    reason: "The JS Detections beacon, for the same reason.",
    url: "https://shop.example.com/cdn-cgi/challenge-platform/h/b/jsd/r/0.123456789/1786518862",
  },
  {
    kind: "dom",
    markup: '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>',
    reason: "The JS Detections script tag as it appears in normal page markup.",
  },
  {
    kind: "request",
    reason: "PerimeterX telemetry runs on pages that render perfectly.",
    url: "https://collector-pxABC123.px-cloud.net/api/v2/collector",
  },
  {
    kind: "request",
    reason: "The Kasada SDK bootstrap loads on protected pages whether or not they challenge.",
    url: "https://target.example/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000/p.js",
  },
  {
    kind: "request",
    reason:
      "The Monocle interstitial posts its assessment on the pass and on the denial alike, so the request says only that a challenge ran.",
    url: "https://target.example/validate_spur_captcha",
  },
  {
    kind: "dom",
    markup: '<script src="https://mcl.target.example/d/mcl.js?tk=REDACTED"></script>',
    reason:
      "The Monocle loader tag is deployment, not a decision: the interstitial that hands over the real page carries the identical tag.",
  },
];

const markerOf = (nonSignal: NonSignal): string => {
  if (nonSignal.kind === "header") {
    return `${nonSignal.name}: ${nonSignal.value}`;
  }

  if (nonSignal.kind === "cookie") {
    return nonSignal.cookie;
  }

  return nonSignal.kind === "dom" ? nonSignal.markup : nonSignal.url;
};

const nonSignalCases = nonSignals.map((nonSignal) => ({
  marker: markerOf(nonSignal),
  nonSignal,
}));

const ruleList: readonly Rule[] = rules;

const ids = (selected: readonly Rule[]) => selected.map((rule) => rule.id).toSorted();

const SENSOR_RULES = ["imperva_resource", "kasada_script_start", "perimeterx_app_id"];

const article = `<!doctype html><html><head><title>Store</title></head><body><main>${"<p>Plenty of ordinary prose about the things this store sells, for its customers.</p>".repeat(20)}</main>`;

const inputFor = (nonSignal: NonSignal) => {
  const headers: ResponseDetails["headers"] = { "content-type": "text/html; charset=utf-8" };

  if (nonSignal.kind === "header") {
    headers[nonSignal.name] = nonSignal.value;
  }

  return {
    html:
      nonSignal.kind === "dom"
        ? `${article}${nonSignal.markup}</body></html>`
        : `${article}</body></html>`,
    requestUrls:
      nonSignal.kind === "request"
        ? ["https://shop.example/", nonSignal.url]
        : ["https://shop.example/"],
    response: {
      cookies: nonSignal.kind === "cookie" ? [nonSignal.cookie] : [],
      headers,
      status: 200,
      url: "https://shop.example/",
    },
  };
};

const sameSource = (nonSignal: NonSignal, rule: Rule): boolean =>
  (nonSignal.kind === "request" && rule.source === "request_log") ||
  (nonSignal.kind === "dom" && rule.source === "dom");

describe("ruleset v9", () => {
  it("holds all 46 rules except the three driven by options Xrio does not have", () => {
    expect(rules).toHaveLength(43);
    expect(new Set(ids(ruleList)).size).toBe(rules.length);
    expect(ruleList.every((rule) => rule.detail.length > 0)).toBeTruthy();
  });

  it("keeps challenge_issued on E0 rules, and every request-log rule proves one", () => {
    expect(
      ruleList.filter((rule) => rule.proves === "challenge_issued" && rule.tier !== "E0"),
    ).toStrictEqual([]);
    expect(
      ruleList.filter(
        (rule) => rule.source === "request_log" && rule.proves !== "challenge_issued",
      ),
    ).toStrictEqual([]);
  });

  it("gates structural DOM rules by page size, and sensors by the absence of prose", () => {
    const domRules = ruleList.filter((rule) => rule.source === "dom");

    expect(domRules.filter((rule) => rule.tier === "E1" && rule.gate === "none")).toStrictEqual([]);
    expect(ids(domRules.filter((rule) => rule.gate === "no_prose"))).toStrictEqual(SENSOR_RULES);
    expect(
      domRules.filter((rule) => rule.family === "captcha_widget" && rule.gate !== "interstitial"),
    ).toStrictEqual([]);
    expect(domRules.filter((rule) => rule.target === "title" && rule.tier !== "E2")).toStrictEqual(
      [],
    );
  });

  it("treats status as weak evidence and lets only queue-it override the verdict", () => {
    expect(ruleList.filter((rule) => rule.source === "status" && rule.tier !== "E2")).toStrictEqual(
      [],
    );
    expect(
      ids(ruleList.filter((rule) => rule.source === "final_url" && rule.verdict !== undefined)),
    ).toStrictEqual(["queue_it_waiting_room"]);
    expect(
      ruleList.filter(
        (rule) =>
          rule.source === "builtin" && rule.kind !== "thin_text_heavy_script" && rule.tier !== "E3",
      ),
    ).toStrictEqual([]);
  });

  it("shares no stateful regular expression", () => {
    const patterns = ruleList.flatMap((rule) =>
      "pattern" in rule && rule.pattern ? [rule.pattern] : [],
    );

    expect(patterns.filter((pattern) => pattern.global || pattern.sticky)).toStrictEqual([]);
  });
});

describe("declared non-signals", () => {
  it.each(nonSignalCases)("$marker classifies as ok on a delivered page", ({ nonSignal }) => {
    const report = classifyResponse(inputFor(nonSignal));

    expect(report).toMatchObject({ evidence: [], verdict: "ok" });
  });

  it("matches no request-log or DOM rule pattern", () => {
    const matched = nonSignalCases.flatMap(({ marker, nonSignal }) =>
      ruleList.flatMap((rule) =>
        sameSource(nonSignal, rule) && "pattern" in rule && rule.pattern?.test(marker) === true
          ? [`${rule.id} ~ ${marker}`]
          : [],
      ),
    );

    expect(matched).toStrictEqual([]);
  });
});
