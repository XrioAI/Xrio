import { readdirSync } from "node:fs";

import { decodeHTML } from "entities";
import { describe, expect, it } from "vite-plus/test";

import { casesByVendor, classifiedCases, failingCases, mergedCasesOf } from "./block-cases.ts";
import type { BlockCase } from "./block-cases.ts";

const EXAMPLE_HOST =
  /(?:^|\.)(?:example|test|invalid|localhost)$|(?:^|\.)example\.(?:com|net|org)$/iu;

const VENDOR_HOSTS = [
  "awswaf.com",
  "captcha-delivery.com",
  "cloudflare.com",
  "datadome.co",
  "edgesuite.net",
  "google.com",
  "googleapis.com",
  "googletagmanager.com",
  "hcaptcha.com",
  "px-cdn.net",
  "px-cloud.net",
  "queue-it.net",
];

const HOST_REFERENCE =
  /(?:https?:)?\/\/(?<host>[\w-]+(?:\.[\w-]+)+)|domain=\.?(?<domain>[\w-]+(?:\.[\w-]+)+)/giu;

const CASE_FOLDER = new URL("block-cases/", import.meta.url);

const REDACTED_COOKIE = /^[^=;]+=REDACTEDx*(?:;|$)/u;

const TOKEN_LIKE = /(?<!\w)(?!REDACTED)(?=\w*\d)(?=\w*[A-Za-z])\w{12,}(?!\w)/gu;

const PERIMETERX_APP_ID = /\bPX[A-Za-z0-9]{8,}\b/gu;

const PLACEHOLDER_APP_ID = /^PX(?:example\d+|a1b2c3d4|x{8})$/u;

const isPublishableHost = (host: string): boolean =>
  EXAMPLE_HOST.test(host) ||
  VENDOR_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));

const distinct = (values: readonly string[]): string[] => [...new Set(values)];

const publishingProblemsOf = (blockCase: BlockCase): string[] => {
  const text = decodeHTML(
    [
      blockCase.url,
      ...Object.values(blockCase.headers),
      ...blockCase.cookies,
      ...(blockCase.requestUrls ?? []),
      blockCase.html,
    ].join("\n"),
  );

  const hosts = [...text.matchAll(HOST_REFERENCE)].map((match) =>
    (match.groups?.host ?? match.groups?.domain ?? "").toLowerCase(),
  );

  const unredactedCookies = blockCase.cookies
    .filter((cookie) => !REDACTED_COOKIE.test(cookie))
    .map((cookie) => cookie.split("=", 1)[0]);

  const realAppIds = (text.match(PERIMETERX_APP_ID) ?? []).filter(
    (appId) => !PLACEHOLDER_APP_ID.test(appId),
  );

  return [
    ...distinct(hosts.filter((host) => !isPublishableHost(host))).map((host) => `host ${host}`),
    ...unredactedCookies.map((name) => `cookie ${name}`),
    ...distinct(text.match(TOKEN_LIKE) ?? []).map((token) => `token ${token}`),
    ...distinct(realAppIds).map((appId) => `app id ${appId}`),
  ];
};

describe("the block cases in a public repository", () => {
  it.each([...classifiedCases, ...failingCases])(
    "keeps $id to example and vendor hosts with redacted values",
    ({ blockCase }) => {
      expect(publishingProblemsOf(blockCase)).toStrictEqual([]);
    },
  );
});

describe("the block case tables", () => {
  it("keep one file in block-cases/ for each vendor table and nothing else", () => {
    const registered = Object.keys(casesByVendor).map(
      (vendor) => `${vendor.replaceAll("_", "-")}.ts`,
    );

    expect(
      readdirSync(CASE_FOLDER)
        .filter((name) => name.endsWith(".ts"))
        .toSorted(),
    ).toStrictEqual(registered.toSorted());
  });

  it("refuse an id that two tables both define", () => {
    const shared: BlockCase = {
      cookies: [],
      fault: "request_log_unreadable",
      headers: {},
      html: "",
      status: 200,
      url: "https://target.example/page",
      why: "A stand-in case.",
    };

    expect(() => mergedCasesOf([{ shared_id: shared }, { shared_id: shared }])).toThrow(
      "The block case shared_id is defined in more than one vendor file.",
    );
  });
});
