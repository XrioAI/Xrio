import { describe, expect, it } from "vite-plus/test";

import {
  blockInputOf,
  classifiedCases,
  decisionPathOf,
  failingCases,
} from "../testing/block-cases.ts";
import type { ResponseDetails } from "../types.ts";
import { classifyResponse } from "./classify.ts";
import type { BlockReport } from "./classify.ts";
import type { PageKind } from "./page-view.ts";
import { gates, rules } from "./rules.ts";

const everyCase = [...classifiedCases, ...failingCases];

const page = (body: string) =>
  `<!doctype html><html><head><title>Catalog</title></head><body>${body}</body></html>`;

const prose = `<main>${"<p>A long paragraph about the products this shop sells, written for people.</p>".repeat(80)}</main>`;

const challengeRequest = "https://geo.captcha-delivery.com/captcha/?initialCid=REDACTED";

const SELF_NAMING_RULES = new Set(["ticketmaster_eps_block", "linkedin_authwall_canonical"]);

const EMPTY_SHELL = "<!doctype html><html><head></head><body></body></html>";

const HOSTILE_DOCUMENT_BUDGET_MS = 250;

const MAXIMUM_INPUT_BUDGET_MS = 2000;

const CHROME_MAX_URL_CHARS = 2_097_152;

const COOKIE_HEADER_CHARS = 262_144;

const INTERSTITIAL_HTML_LIMIT = 50_000;

const INTERSTITIAL_TEXT_LIMIT = 5000;

const NO_PROSE_TEXT_LIMIT = 100;

const HEAVY_SCRIPT_HTML_LIMIT = 10_000;

const HEAVY_SCRIPT_MIN_CHARS = 200;

const HEAVY_SCRIPT_TEXT_RATIO = 10;

const DOM_SCAN_LIMIT = 1_048_576;

const EMPTY_SCRIPT_ELEMENT_CHARS = 17;

const AMPLE_SCRIPT_CHARS = 1000;

const RATIO_PROBE_TEXT_CHARS = 30;

const ABUSE_BLOCK_MARKER = '<abuse-component action="block"';

const atTextPassLimit = (unit: string, codePoints = unit.length): string =>
  unit.repeat(Math.floor(gates.interstitialMaxHtmlChars / codePoints));

const repeatedTo = (length: number, unit: string): string =>
  unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

const ruleIdsOf = (report: BlockReport): string[] => report.evidence.map((entry) => entry.rule);

const sensorPage = (text: string) =>
  `<html><head><script>window._pxAppId = 'PXtest';</script></head><body><p>${text}</p></body></html>`;

const paddedTo = (length: number, head: string): string => {
  const shell = `<html><head>${head}</head><body><!----></body></html>`;

  return shell.replace("<!---->", `<!--${"x".repeat(length - shell.length)}-->`);
};

const sensorPageAtHtmlLimit = (textChars: number): string => {
  const shell = sensorPage(`${"a".repeat(textChars)}<!---->`);

  return shell.replace("<!---->", `<!--${"x".repeat(INTERSTITIAL_HTML_LIMIT - shell.length)}-->`);
};

const scriptElementOf = (chars: number): string =>
  `<script>${"x".repeat(chars - EMPTY_SCRIPT_ELEMENT_CHARS)}</script>`;

const scriptAndTextPage = (scriptChars: number, textChars: number): string =>
  `<html><body><p>${"a".repeat(textChars)}</p>${scriptElementOf(scriptChars)}</body></html>`;

const blockMarkerEndingAt = (end: number): string => {
  const opener = "<html><body>";
  const filler = "x".repeat(end - opener.length - ABUSE_BLOCK_MARKER.length);

  return `${opener}${filler}${ABUSE_BLOCK_MARKER}</body></html>`;
};

const challengeRules = new Set(
  rules.flatMap((rule) =>
    "proves" in rule && rule.proves === "challenge_issued" ? [rule.id] : [],
  ),
);

const htmlResponse = (overrides: Partial<ResponseDetails> = {}): ResponseDetails => ({
  cookies: [],
  headers: { "content-type": "text/html; charset=utf-8" },
  status: 200,
  url: "https://shop.example/",
  ...overrides,
});

const challengeCases = () =>
  [...challengeRules].map((rule) => {
    const named = classifiedCases.find(
      ({ blockCase }) =>
        blockCase.expect.verdict === "blocked" &&
        blockCase.expect.ruleIds.some((ruleId) => ruleId === rule),
    );

    if (named === undefined) {
      throw new Error(`No challenge case covers ${rule}.`);
    }

    return { input: blockInputOf(named.blockCase), rule };
  });

const EVERY_PAGE_KIND = {
  interstitial_heavy_script: true,
  interstitial_no_prose: true,
  interstitial_with_prose: true,
  over_html_limit: true,
  over_text_limit: true,
} satisfies Record<PageKind, true>;

describe("the block cases", () => {
  it.each(classifiedCases)("decides $id along its recorded path", ({ blockCase }) => {
    expect(decisionPathOf(blockCase)).toStrictEqual(blockCase.expect);
  });

  it.each(failingCases)("reports $id as unknown with a classifier failure", ({ blockCase }) => {
    expect(classifyResponse(blockInputOf(blockCase))).toMatchObject({
      evidence: [{ rule: "classifier_failure" }],
      vendor: null,
      verdict: "unknown",
    });
  });

  it("fires every rule and reaches every page kind somewhere in the corpus", () => {
    const firedRules = new Set(
      everyCase.flatMap(({ blockCase }) =>
        classifyResponse(blockInputOf(blockCase)).evidence.map((entry) => entry.rule),
      ),
    );

    const reachedKinds = new Set(classifiedCases.map(({ blockCase }) => blockCase.expect.page));

    expect(rules.map((rule) => rule.id).filter((id) => !firedRules.has(id))).toStrictEqual([]);
    expect([...reachedKinds].toSorted()).toStrictEqual(Object.keys(EVERY_PAGE_KIND).toSorted());
  });

  it("keeps at most one evidence item per rule", () => {
    const duplicated = everyCase.flatMap(({ blockCase, id }) => {
      const rulesSeen = classifyResponse(blockInputOf(blockCase)).evidence.map(
        (entry) => entry.rule,
      );

      return rulesSeen.length === new Set(rulesSeen).size ? [] : [id];
    });

    expect(duplicated).toStrictEqual([]);
  });

  it.each(
    classifiedCases.filter(({ blockCase }) =>
      blockCase.expect.ruleIds.some((rule) => SELF_NAMING_RULES.has(rule)),
    ),
  )("decides $id at a served page's size, past the interstitial gate", ({ blockCase }) => {
    const served = blockCase.html.replace(/<\/body>/iu, `${prose.repeat(10)}</body>`);
    const report = classifyResponse({ ...blockInputOf(blockCase), html: served });

    expect(served.length).toBeGreaterThan(gates.interstitialMaxHtmlChars);
    expect(report.verdict).toBe("blocked");
    expect(report.evidence.some((entry) => SELF_NAMING_RULES.has(entry.rule))).toBeTruthy();
  });

  it.each(challengeCases())(
    "withholds $rule on a served page and decides on an empty shell",
    ({ input, rule }) => {
      const served = classifyResponse({ ...input, html: page(prose.repeat(10)) });
      const shell = classifyResponse({ ...input, html: EMPTY_SHELL });

      expect(served.passedChallenges).toContain(rule);
      expect(shell.passedChallenges).not.toContain(rule);
      expect(shell.verdict).toBe("blocked");
      expect(shell.evidence.map((entry) => entry.rule)).toContain(rule);
    },
  );

  it("orders evidence by tier and keeps every detail within 160 characters", () => {
    const reports = everyCase.map(({ blockCase }) => classifyResponse(blockInputOf(blockCase)));

    const misordered = reports.filter((report) => {
      const tiers = report.evidence.map((entry) => entry.tier);

      return tiers.join(",") !== tiers.toSorted().join(",");
    });

    expect(misordered).toStrictEqual([]);
    expect(
      reports.flatMap((report) => report.evidence).filter((entry) => entry.detail.length > 160),
    ).toStrictEqual([]);
  });
});

describe("the page limits", () => {
  it.each([
    { decides: true, htmlChars: INTERSTITIAL_HTML_LIMIT },
    { decides: false, htmlChars: INTERSTITIAL_HTML_LIMIT + 1 },
  ])(
    "treats a $htmlChars character document as interstitial-shaped: $decides",
    ({ decides, htmlChars }) => {
      const report = classifyResponse({
        html: paddedTo(htmlChars, "<script>window._cf_chl_opt = {};</script>"),
        requestUrls: [],
        response: htmlResponse(),
      });

      expect(ruleIdsOf(report).includes("cf_chl_opt")).toBe(decides);
    },
  );

  it.each([
    {
      expected: { passedChallenges: [], verdict: "blocked" },
      textChars: INTERSTITIAL_TEXT_LIMIT,
    },
    {
      expected: { passedChallenges: ["datadome_captcha_delivery_request"], verdict: "ok" },
      textChars: INTERSTITIAL_TEXT_LIMIT + 1,
    },
  ])(
    "decides a page of $textChars text characters as $expected.verdict",
    ({ expected, textChars }) => {
      const report = classifyResponse({
        html: page(`<p>${"a".repeat(textChars)}</p>`),
        requestUrls: [challengeRequest],
        response: htmlResponse(),
      });

      expect(report).toMatchObject(expected);
    },
  );

  it.each([
    { decides: true, textChars: NO_PROSE_TEXT_LIMIT - 1 },
    { decides: false, textChars: NO_PROSE_TEXT_LIMIT },
  ])(
    "lets a sensor decide only below 100 text characters ($textChars)",
    ({ decides, textChars }) => {
      const report = classifyResponse({
        html: sensorPage("a".repeat(textChars)),
        requestUrls: [],
        response: htmlResponse(),
      });

      expect(ruleIdsOf(report).includes("perimeterx_app_id")).toBe(decides);
    },
  );

  it.each([
    { decides: true, textChars: NO_PROSE_TEXT_LIMIT - 1 },
    { decides: false, textChars: NO_PROSE_TEXT_LIMIT },
  ])("counts $textChars text characters on a page at the HTML limit", ({ decides, textChars }) => {
    const report = classifyResponse({
      html: sensorPageAtHtmlLimit(textChars),
      requestUrls: [],
      response: htmlResponse(),
    });

    expect(ruleIdsOf(report).includes("perimeterx_app_id")).toBe(decides);
  });

  it.each([
    { decides: true, label: "99 named entities", text: "&eacute;".repeat(NO_PROSE_TEXT_LIMIT - 1) },
    { decides: false, label: "100 named entities", text: "&eacute;".repeat(NO_PROSE_TEXT_LIMIT) },
    { decides: true, label: "99 emoji", text: "\u{1F600}".repeat(NO_PROSE_TEXT_LIMIT - 1) },
    { decides: false, label: "20 unknown entities", text: "&zzzz;".repeat(20) },
    { decides: true, label: "99 legacy entities", text: "&copy".repeat(NO_PROSE_TEXT_LIMIT - 1) },
  ])("counts $label as visible characters", ({ decides, text }) => {
    const report = classifyResponse({
      html: sensorPage(text),
      requestUrls: [],
      response: htmlResponse(),
    });

    expect(ruleIdsOf(report).includes("perimeterx_app_id")).toBe(decides);
  });

  it.each([
    { fires: true, htmlChars: HEAVY_SCRIPT_HTML_LIMIT },
    { fires: false, htmlChars: HEAVY_SCRIPT_HTML_LIMIT + 1 },
  ])("flags a $htmlChars character page as heavy script: $fires", ({ fires, htmlChars }) => {
    const report = classifyResponse({
      html: paddedTo(htmlChars, scriptElementOf(AMPLE_SCRIPT_CHARS)),
      requestUrls: [],
      response: htmlResponse(),
    });

    expect(ruleIdsOf(report).includes("thin_text_heavy_script")).toBe(fires);
  });

  it.each([
    { emoji: HEAVY_SCRIPT_MIN_CHARS - EMPTY_SCRIPT_ELEMENT_CHARS - 1, fires: false },
    { emoji: HEAVY_SCRIPT_MIN_CHARS - EMPTY_SCRIPT_ELEMENT_CHARS, fires: true },
  ])("counts $emoji emoji of script as code points: heavy script $fires", ({ emoji, fires }) => {
    const report = classifyResponse({
      html: `<html><body><script>${"\u{1F600}".repeat(emoji)}</script></body></html>`,
      requestUrls: [],
      response: htmlResponse({ status: 403 }),
    });

    expect(ruleIdsOf(report).includes("thin_text_heavy_script")).toBe(fires);
  });

  it.each([
    { fires: true, scriptChars: HEAVY_SCRIPT_TEXT_RATIO * RATIO_PROBE_TEXT_CHARS },
    { fires: false, scriptChars: HEAVY_SCRIPT_TEXT_RATIO * RATIO_PROBE_TEXT_CHARS - 1 },
  ])(
    "flags $scriptChars script characters over 30 text characters as heavy script: $fires",
    ({ fires, scriptChars }) => {
      const report = classifyResponse({
        html: scriptAndTextPage(scriptChars, RATIO_PROBE_TEXT_CHARS),
        requestUrls: [],
        response: htmlResponse(),
      });

      expect(ruleIdsOf(report).includes("thin_text_heavy_script")).toBe(fires);
    },
  );

  it.each([
    { markerEnd: DOM_SCAN_LIMIT, ruleIds: ["ticketmaster_eps_block"], verdict: "blocked" },
    { markerEnd: DOM_SCAN_LIMIT + 1, ruleIds: [], verdict: "ok" },
  ])(
    "lets DOM rules see a marker that ends at character $markerEnd: $verdict",
    ({ markerEnd, ruleIds, verdict }) => {
      const report = classifyResponse({
        html: blockMarkerEndingAt(markerEnd),
        requestUrls: [],
        response: htmlResponse(),
      });

      expect(report.verdict).toBe(verdict);
      expect(ruleIdsOf(report)).toStrictEqual(ruleIds);
    },
  );
});

describe(classifyResponse, () => {
  it("withholds a passed challenge on a page with content and decides on an interstitial", () => {
    const served = classifyResponse({
      html: page(prose),
      requestUrls: [challengeRequest],
      response: htmlResponse(),
    });

    const interstitial = classifyResponse({
      html: page("<p>One moment.</p>"),
      requestUrls: [challengeRequest],
      response: htmlResponse(),
    });

    expect(served).toMatchObject({
      passedChallenges: ["datadome_captcha_delivery_request"],
      verdict: "ok",
    });
    expect(interstitial).toMatchObject({
      passedChallenges: [],
      vendor: "datadome",
      verdict: "blocked",
    });
  });

  it("drops a logged challenge without a capture but still decides on a header challenge", () => {
    const json = htmlResponse({ headers: { "content-type": "application/json" }, status: 403 });

    const logged = classifyResponse({
      html: undefined,
      requestUrls: [challengeRequest],
      response: json,
    });

    const header = classifyResponse({
      html: undefined,
      requestUrls: [],
      response: { ...json, headers: { ...json.headers, "cf-mitigated": "challenge" } },
    });

    expect(logged).toMatchObject({ passedChallenges: [], verdict: "ok" });
    expect(header).toMatchObject({ vendor: "cloudflare", verdict: "blocked" });
  });

  it("reads a block page sent as a bare fragment as HTML", () => {
    const report = classifyResponse({
      html: "<div><h1>Access Denied</h1><p>Reference #18.6f2e1002.1786518982.2a3b4c</p></div>",
      requestUrls: [],
      response: htmlResponse({ status: 403 }),
    });

    expect(report).toMatchObject({ vendor: "akamai", verdict: "blocked" });
    expect(ruleIdsOf(report)).toStrictEqual(["akamai_reference_id", "waf_status"]);
  });

  it("reads a block page sent as XHTML with an XML declaration as HTML", () => {
    const report = classifyResponse({
      html: '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Access Denied</h1><p>Reference #18.6f2e1002.1786518982.2a3b4c</p></body></html>',
      requestUrls: [],
      response: htmlResponse({
        headers: { "content-type": "application/xhtml+xml" },
        status: 403,
      }),
    });

    expect(report).toMatchObject({ vendor: "akamai", verdict: "blocked" });
    expect(ruleIdsOf(report)).toStrictEqual(["akamai_reference_id", "waf_status"]);
  });

  it("promotes two weak signals only when they come from different families", () => {
    const titled = page("<p>Checking your browser before you continue.</p>").replace(
      "Catalog",
      "Just a moment...",
    );

    expect(
      classifyResponse({ html: titled, requestUrls: [], response: htmlResponse({ status: 403 }) })
        .verdict,
    ).toBe("blocked");
    expect(
      classifyResponse({ html: titled, requestUrls: [], response: htmlResponse() }).verdict,
    ).toBe("suspect");
    expect(
      classifyResponse({
        html: page(prose),
        requestUrls: [],
        response: htmlResponse({ status: 403 }),
      }).verdict,
    ).toBe("suspect");
  });

  it("redacts cookie values from evidence", () => {
    const report = classifyResponse({
      html: page("<p>One moment.</p>"),
      requestUrls: [],
      response: htmlResponse({
        cookies: ["__cf_bm=normal-traffic", "cf_chl_2=session-secret-value; Path=/"],
      }),
    });

    expect(report.evidence).toContainEqual(
      expect.objectContaining({ detail: "set-cookie #2 of 2: cf_chl_2 (value redacted)" }),
    );
    expect(JSON.stringify(report)).not.toContain("session-secret-value");
  });

  it("reports a waiting room as queued, unless a block signal is also present", () => {
    const queued = htmlResponse({ url: "https://shop.queue-it.net/?c=shop&e=summer" });

    expect(classifyResponse({ html: page(prose), requestUrls: [], response: queued }).verdict).toBe(
      "queued",
    );
    expect(
      classifyResponse({
        html: page("<p>You are in line.</p>"),
        requestUrls: [],
        response: { ...queued, headers: { ...queued.headers, "x-vercel-mitigated": "challenge" } },
      }),
    ).toMatchObject({ vendor: "vercel", verdict: "blocked" });
    expect(
      classifyResponse({
        html: page(prose),
        requestUrls: [],
        response: htmlResponse({ url: "https://notqueue-it.net/" }),
      }).verdict,
    ).toBe("ok");
  });

  it.each([
    { html: "[".repeat(100_000), name: "deeply nested brackets" },
    { html: page("&#99999999; &#x110000; &bogus; &amp;"), name: "out-of-range entities" },
    { html: "<script>".repeat(10_000), name: "unclosed scripts" },
    { html: undefined, name: "no capture" },
  ])("returns a verdict for $name without throwing", ({ html }) => {
    const report = classifyResponse({
      html,
      requestUrls: ["not a url", ""],
      response: htmlResponse({ url: "not a url" }),
    });

    expect(report.verdict).toBe("ok");
  });

  it.each([
    { html: atTextPassLimit("<"), name: "unclosed tag openers" },
    { html: atTextPassLimit("<\u{1F600}", 2), name: "tag openers between emoji" },
    { html: atTextPassLimit("<script "), name: "unclosed script tags" },
    { html: atTextPassLimit("<script>"), name: "unclosed scripts" },
    { html: atTextPassLimit("<style "), name: "unclosed style tags" },
    { html: atTextPassLimit("<!--"), name: "unclosed comments" },
    { html: atTextPassLimit("&am"), name: "unterminated entities" },
  ])("classifies a document of $name within the text-pass limit promptly", ({ html }) => {
    const started = performance.now();

    classifyResponse({ html, requestUrls: [], response: htmlResponse() });

    expect(performance.now() - started).toBeLessThan(HOSTILE_DOCUMENT_BUDGET_MS);
  });

  it.each([
    {
      input: { html: repeatedTo(gates.domScanMaxChars, "<abuse-component ") },
      name: "a megabyte of unclosed vendor tags",
    },
    { input: { html: repeatedTo(gates.domScanMaxChars, "<title") }, name: "unclosed titles" },
    ...["token.awswaf.com/", "/_Incapsula_Resource?"].map((unit) => ({
      input: { requestUrls: [repeatedTo(CHROME_MAX_URL_CHARS, unit)] },
      name: `a request URL of Chrome's maximum length repeating ${unit}`,
    })),
    {
      input: { response: htmlResponse({ cookies: [repeatedTo(COOKIE_HEADER_CHARS, "cf_chl_")] }) },
      name: "a repeated challenge cookie prefix",
    },
  ])("classifies $name in bounded time", ({ input }) => {
    const started = performance.now();

    classifyResponse({ html: EMPTY_SHELL, requestUrls: [], response: htmlResponse(), ...input });

    expect(performance.now() - started).toBeLessThan(MAXIMUM_INPUT_BUDGET_MS);
  });

  it("lets nothing weak decide when the response was not captured as HTML", () => {
    const report = classifyResponse({
      html: undefined,
      requestUrls: [],
      response: htmlResponse({
        cookies: ["cf_chl_rc_m=1; Path=/"],
        headers: { "content-type": "application/xhtml+xml" },
        status: 403,
      }),
    });

    expect(report.verdict).toBe("ok");
    expect(ruleIdsOf(report)).toContain("waf_status");
  });

  it("keeps query values and token headers out of evidence", () => {
    const report = classifyResponse({
      html: page("<p>One moment.</p>"),
      requestUrls: [
        "https://geo.captcha-delivery.com/captcha/?SECRETTOKEN&initialCid=a&cid=SECRETCOOKIE",
      ],
      response: htmlResponse({
        headers: { "content-type": "text/html", "x-kpsdk-ct": "SECRETTOKEN" },
      }),
    });

    expect(JSON.stringify(report)).not.toMatch(/SECRET/u);
    expect(report.evidence).toContainEqual(
      expect.objectContaining({
        detail: "requested https://geo.captcha-delivery.com/captcha/?initialCid&cid",
      }),
    );
  });
});
