import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import oxlintConfig from "../oxlint.config.ts";

const oxlintPath = fileURLToPath(new URL("bin/oxlint", import.meta.resolve("oxlint/package.json")));

const exemptions = (oxlintConfig.overrides ?? []).filter(
  (override) => override.rules?.["xrio/identity-owner"] === "off",
);

const lint = (relativePath: string, source: string) => {
  const directory = mkdtempSync(path.join(tmpdir(), "xrio-identity-owner-"));
  const configPath = path.join(directory, "oxlint.json");
  const sourcePath = path.join(directory, relativePath);

  try {
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [fileURLToPath(new URL("xrio.ts", import.meta.url))],
        overrides: exemptions,
        rules: { "xrio/identity-owner": "error" },
      }),
    );
    writeFileSync(sourcePath, source);

    const result = spawnSync(
      process.execPath,
      [
        oxlintPath,
        "--config",
        configPath,
        "--disable-nested-config",
        "--format",
        "json",
        sourcePath,
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );

    const output: unknown = JSON.parse(result.stdout);

    return { output, status: result.status, stderr: result.stderr };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

const OUTSIDE = "packages/core/src/sources/http.ts";

const violations = [
  {
    message: "`--lang` is a launch switch the Humanizer owns; only src/humanizer/ may emit it.",
    source: 'export const a = ["--lang=fr"];',
  },
  {
    message: "`--use-gl` is a launch switch the Humanizer owns; only src/humanizer/ may emit it.",
    source: 'export const b = "--use-gl";',
  },
  {
    message:
      "`--window-size` is a launch switch the Humanizer owns; only src/humanizer/ may emit it.",
    source: `export const c = \`--window-size=\${size}\`;`,
  },
  {
    message:
      "`--pxr-` switches belong to the browser fork's dialect; only src/humanizer/ may emit them.",
    source: 'export const d = "--pxr-seed=1";',
  },
  {
    message:
      "`--xrio-` switches belong to the browser fork's dialect; only src/humanizer/ may emit them.",
    source: 'export const e = "--xrio-device-memory=8";',
  },
  {
    message: "`TZ` is an environment variable the Humanizer owns; only src/humanizer/ may use it.",
    source: 'export const f = { TZ: "UTC" };',
  },
  {
    message:
      "`LANGUAGE` is an environment variable the Humanizer owns; only src/humanizer/ may use it.",
    source: 'export const g = { "LANGUAGE": "de" };',
  },
  {
    message:
      "`intl.accept_languages` is a profile setting the Humanizer owns; only src/humanizer/ may write it.",
    source: 'export const h = "intl.accept_languages";',
  },
  {
    message:
      "`dns_over_https.mode` is a profile setting the Humanizer owns; only src/humanizer/ may write it.",
    source: 'export const i = "dns_over_https.mode";',
  },
  {
    message:
      "`accept-language` is a request header the Humanizer owns; only src/humanizer/ may use it.",
    source: 'export const j = { "Accept-Language": "fr" };',
  },
  {
    message: "`process.env.TZ` is read by the Humanizer; take the value from the identity inputs.",
    source: "export const k = process.env.TZ;",
  },
  {
    message:
      "`LANG` is an environment variable the Humanizer owns; only src/humanizer/ may use it.",
    source: 'export const l = process.env["LANG"];',
  },
  {
    message:
      "`process.env.LANGUAGE` is read by the Humanizer; take the value from the identity inputs.",
    source: "export const { LANGUAGE } = process.env;",
  },
  {
    message:
      "`intl.accept_languages` is a profile setting the Humanizer owns; only src/humanizer/ may write it.",
    source: 'export const preferences = { intl: { accept_languages: "de" } };',
  },
  {
    message:
      "`net.network_prediction_options` is a profile setting the Humanizer owns; only src/humanizer/ may write it.",
    source: "export const prediction = { net: { network_prediction_options: 0 } };",
  },
  {
    message:
      "`dns_over_https.mode` is a profile setting the Humanizer owns; only src/humanizer/ may write it.",
    source: 'export const doh = { dns_over_https: { mode: "secure" } };',
  },
  {
    message:
      "`accept-language` is a request header the Humanizer owns; only src/humanizer/ may use it.",
    source: 'export const computed = { ["accept-language"]: "fr" };',
  },
  {
    message:
      "`accept-language` is a request header the Humanizer owns; only src/humanizer/ may use it.",
    source: 'export const tuples = new Headers([["Accept-Language", "fr"]]);',
  },
  {
    message:
      "`accept-language` is a request header the Humanizer owns; only src/humanizer/ may use it.",
    source: 'export const record = new Headers({ "accept-language": "fr" });',
  },
  {
    message:
      "`intl.accept_languages` is a profile setting the Humanizer owns; only src/humanizer/ may write it.",
    source: 'export const wrapped = { preferences: { intl: { accept_languages: "de" } } };',
  },
  {
    message:
      "`dns_over_https.mode` is a profile setting the Humanizer owns; only src/humanizer/ may write it.",
    source: 'export const state = { "Local State": { dns_over_https: { mode: "off" } } };',
  },
  {
    message:
      "`accept-language` is a request header the Humanizer owns; only src/humanizer/ may use it.",
    source: 'export const template = { [`accept-language`]: "fr" };',
  },
  {
    message:
      "`accept-language` is a request header the Humanizer owns; only src/humanizer/ may use it.",
    source: 'export const templateTuples = new Headers([[`accept-language`, "fr"]]);',
  },
  {
    message:
      "`dns_over_https.mode` is a profile setting the Humanizer owns; only src/humanizer/ may write it.",
    source: 'export const outerComputed = { [LOCAL_STATE]: { dns_over_https: { mode: "off" } } };',
  },
  {
    message:
      "`intl.accept_languages` is a profile setting the Humanizer owns; only src/humanizer/ may write it.",
    source: 'export const innerComputed = { [key]: { intl: { accept_languages: "de" } } };',
  },
  {
    message:
      "`intl.accept_languages` is a profile setting the Humanizer owns; only src/humanizer/ may write it.",
    source: 'export const asWrapped = { intl: { accept_languages: "de" } as Preferences };',
  },
  {
    message:
      "`intl.accept_languages` is a profile setting the Humanizer owns; only src/humanizer/ may write it.",
    source:
      'export const satisfiesWrapped = { intl: { accept_languages: "de" } satisfies Preferences };',
  },
  {
    message:
      "`intl.accept_languages` is a profile setting the Humanizer owns; only src/humanizer/ may write it.",
    source: 'export const nonNullWrapped = { intl: { accept_languages: "de" }! };',
  },
  {
    message:
      "`intl.accept_languages` is a profile setting the Humanizer owns; only src/humanizer/ may write it.",
    source: 'export const parenthesised = { intl: ({ accept_languages: "de" }) };',
  },
  {
    message:
      "`intl.accept_languages` is a profile setting the Humanizer owns; only src/humanizer/ may write it.",
    source: 'export const dotted = { prefs: { "intl.accept_languages": "de" } };',
  },
  {
    message:
      "`accept-language` is a request header the Humanizer owns; only src/humanizer/ may use it.",
    source: 'headers.set("accept-language", "fr");',
  },
  {
    message:
      "`accept-language` is a request header the Humanizer owns; only src/humanizer/ may use it.",
    source: 'headers.append("Accept-Language", "fr");',
  },
  {
    message:
      "`accept-language` is a request header the Humanizer owns; only src/humanizer/ may use it.",
    source: 'export const order = ["Host", "Accept-Language", "Priority"];',
  },
  {
    message:
      "`accept-language` is a request header the Humanizer owns; only src/humanizer/ may use it.",
    source: 'headers.set(`accept-language`, "fr");',
  },
  {
    message:
      "`accept-language` is a request header the Humanizer owns; only src/humanizer/ may use it.",
    source: 'export const language = headers.get("Accept-Language");',
  },
  {
    message:
      "`FONTCONFIG_FILE` is an environment variable the Humanizer owns; only src/humanizer/ may use it.",
    source: 'export const fontFile = { FONTCONFIG_FILE: "/x/fonts.conf" };',
  },
  {
    message:
      "`FONTCONFIG_PATH` is an environment variable the Humanizer owns; only src/humanizer/ may use it.",
    source: 'export const fontPath = { "FONTCONFIG_PATH": "/x" };',
  },
  {
    message:
      "`process.env.FONTCONFIG_FILE` is read by the Humanizer; take the value from the identity inputs.",
    source: "export const { FONTCONFIG_FILE } = process.env;",
  },
];

const allowed = [
  'export const m = ["--disable-features=X", "--headless", "--language-tool"];',
  "export const n = process.env.DISPLAY;",
  'export const o = { HOME: "/h", "Content-Type": "x" };',
  'export const p = ["Accept-Encoding", "Content-Type"];',
  'export const q = "TZX";',
  'export const agentName = "user-agent-string";',
  'headers.set("sec-ch-ua-prefers-color-scheme", "dark");',
  'headers.set("accept-encoding", "gzip");',
  "export const r = { intl: { other: 1 }, net: { mode: 1 }, dns_over_https: {} };",
  'export const t = new Headers([["x-other", "1"]]);',
  "export const u = { preferences: { intl: { other: 1 } }, myintl: { accept_languages: 1 } };",
  "export const v = { [`x-other`]: 1 };",
  'export const w = { "x.intl": { accept_languages: 1 } };',
  'export const x = { a: { "my.dns_over_https": { mode: 1 } } };',
];

describe("identity-owner lint rule", () => {
  it("flags each identity input outside the Humanizer on its own line", () => {
    const result = lint(OUTSIDE, `${violations.map(({ source }) => source).join("\n")}\n`);

    expect(result).toMatchObject({
      output: {
        diagnostics: violations.map(({ message }, index) => ({
          code: "xrio(identity-owner)",
          labels: [{ span: { line: index + 1 } }],
          message,
        })),
      },
      status: 1,
    });
  });

  it.each([
    "user-agent",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "sec-ch-ua-full-version-list",
    "sec-ch-ua-arch",
    "sec-ch-ua-model",
    "sec-ch-ua-platform-version",
    "sec-ch-ua-bitness",
    "sec-ch-ua-wow64",
    "sec-ch-ua-form-factors",
    "sec-ch-ua-full-version",
    "sec-ch-device-memory",
    "sec-ch-dpr",
    "sec-ch-viewport-width",
    "sec-ch-viewport-height",
  ])("flags the identity header %s as a key, a call argument and an array entry", (name) => {
    const message = `\`${name}\` is a request header the Humanizer owns; only src/humanizer/ may use it.`;
    const source = `export const keyed = { "${name.toUpperCase()}": "x" };\nheaders.set("${name}", "x");\nexport const order = ["Host", "${name}"];\n`;

    expect(lint(OUTSIDE, source)).toMatchObject({
      output: {
        diagnostics: [1, 2, 3].map((line) => ({ labels: [{ span: { line } }], message })),
      },
      status: 1,
    });
  });

  it("allows other switches, variables, headers listed by name, and near misses", () => {
    expect(lint(OUTSIDE, `${allowed.join("\n")}\n`)).toMatchObject({
      output: { diagnostics: [] },
      status: 0,
      stderr: "",
    });
  });

  it.each([
    { outcome: "flags", path: OUTSIDE },
    { outcome: "flags", path: "packages/core/src/sources/browser/launch-plan.ts" },
    { outcome: "allows", path: "packages/core/src/humanizer/surfaces.ts" },
    { outcome: "allows", path: "packages/core/src/humanizer/nested/inputs.ts" },
    { outcome: "allows", path: "packages/core/src/sources/http.test.ts" },
    { outcome: "allows", path: "packages/core/src/sources/browser/conformance.browser.test.ts" },
    { outcome: "allows", path: "packages/core/src/client.test-d.ts" },
    { outcome: "allows", path: "packages/core/src/testing/conformance-pages.ts" },
  ])("$outcome a switch literal in $path", ({ outcome, path: relativePath }) => {
    expect(lint(relativePath, 'export const flag = "--lang=fr";\n')).toMatchObject({
      status: outcome === "flags" ? 1 : 0,
    });
  });
});
