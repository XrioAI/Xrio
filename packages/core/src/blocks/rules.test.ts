import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import type { ResponseDetails } from "../types.ts";
import { classifyResponse } from "./classify.ts";
import { rules } from "./rules.ts";
import type { Rule } from "./rules.ts";

interface NonSignal {
  marker: string;
  kind: "header" | "cookie" | "dom" | "request";
  reason: string;
}

const NON_SIGNAL_KINDS = new Set(["header", "cookie", "dom", "request"]);

const isNonSignal = (value: unknown): value is NonSignal =>
  typeof value === "object" &&
  value !== null &&
  "marker" in value &&
  typeof value.marker === "string" &&
  "kind" in value &&
  typeof value.kind === "string" &&
  NON_SIGNAL_KINDS.has(value.kind) &&
  "reason" in value &&
  typeof value.reason === "string";

const parsedNonSignals: unknown = JSON.parse(
  readFileSync(new URL("fixtures/non-signals.json", import.meta.url), "utf-8"),
);

const nonSignals = Array.isArray(parsedNonSignals) ? parsedNonSignals.filter(isNonSignal) : [];

const ruleList: readonly Rule[] = rules;

const ids = (selected: readonly Rule[]) => selected.map((rule) => rule.id).toSorted();

const SENSOR_RULES = ["imperva_resource", "kasada_script_start", "perimeterx_app_id"];

const article = `<!doctype html><html><head><title>Store</title></head><body><main>${"<p>Plenty of ordinary prose about the things this store sells, for its customers.</p>".repeat(20)}</main>`;

const inputFor = ({ kind, marker }: NonSignal) => {
  const [name, ...value] = marker.split(": ");
  const headers: ResponseDetails["headers"] = { "content-type": "text/html; charset=utf-8" };

  if (kind === "header") {
    headers[name.toLowerCase()] = value.join(": ");
  }

  return {
    html: kind === "dom" ? `${article}${marker}</body></html>` : `${article}</body></html>`,
    requestUrls: kind === "request" ? ["https://shop.example/", marker] : ["https://shop.example/"],
    response: {
      cookies: kind === "cookie" ? [marker] : [],
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
  it("holds 23 entries", () => {
    expect(nonSignals).toHaveLength(23);
  });

  it.each(nonSignals)("$marker classifies as ok on a delivered page", (nonSignal) => {
    const report = classifyResponse(inputFor(nonSignal));

    expect(report).toMatchObject({ evidence: [], verdict: "ok" });
  });

  it("matches no request-log or DOM rule pattern", () => {
    const matched = nonSignals.flatMap((nonSignal) =>
      ruleList.flatMap((rule) =>
        sameSource(nonSignal, rule) &&
        "pattern" in rule &&
        rule.pattern?.test(nonSignal.marker) === true
          ? [`${rule.id} ~ ${nonSignal.marker}`]
          : [],
      ),
    );

    expect(matched).toStrictEqual([]);
  });
});
