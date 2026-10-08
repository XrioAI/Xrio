/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-unknown-parameters -- The table holds configs that are invalid by design, and the example walker reads raw JSON, so no config type describes them. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv } from "ajv";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { XRIO_CONFIG_SCHEMA } from "./config-schema.ts";
import type { JsonSchema } from "./config-schema.ts";
import { loadXrioConfig } from "./config.ts";
import { isPlainObject } from "./host-config.ts";
import { CHROME_ACCEPT_LANGUAGES } from "./humanizer/owned-inputs.ts";

type Verdict = "accepts" | "rejects";

interface Conformance {
  readonly name: string;
  readonly config: object;
  readonly loader: Verdict;
  readonly schema: Verdict;
}

const BOTH_ACCEPT: readonly Conformance[] = [
  { config: {}, name: "an empty config" },
  {
    config: { $schema: "./node_modules/@xrio/core/xrio.schema.json" },
    name: "a schema reference",
  },
  { config: { proxy: { url: "http://proxy.example:8080" } }, name: "a plain proxy" },
  {
    config: { proxy: { url: "socks5h://user:secret@proxy.example:1080" } },
    name: "a socks proxy with credentials",
  },
  {
    config: { proxy: { url: "http://user-{session}:secret@proxy.example:8080" } },
    name: "a session template with default session settings",
  },
  {
    config: {
      proxy: {
        session: { format: "alphanumeric", length: 256 },
        url: "http://user:{session}@proxy.example:8080",
      },
    },
    name: "a session template with explicit session settings",
  },
  { config: { host: {} }, name: "an empty host" },
  {
    config: {
      $schema: "./xrio.schema.json",
      host: {
        browserArgs: ["--no-sandbox", "--disk-cache-dir=/tmp/cache"],
        display: {
          screen: { height: 1080, width: 1920 },
          taskbar: { bottom: 48 },
          window: "maximized",
        },
        hardware: { cores: 8, gpuPolicy: "matched", memoryGb: 16 },
        locale: "de-DE",
        timezone: "Europe/Berlin",
      },
      proxy: { url: "http://user-{session}:secret@proxy.example:8080" },
    },
    name: "the documented example",
  },
  {
    config: {
      host: {
        display: {
          screen: [
            { height: 1080, weight: 40, width: 1920 },
            { height: 1440, weight: 7, width: 2560 },
          ],
          taskbar: [
            { left: 66, top: 32, weight: 3 },
            { bottom: 48, weight: 2 },
          ],
          window: [
            { maximized: true, weight: 4 },
            { height: 800, weight: 1, width: 1280 },
            { height: 700, weight: 1, width: 1300, x: 100, y: 120 },
          ],
        },
      },
    },
    name: "weighted display tables",
  },
  { config: { host: { display: { taskbar: {} } } }, name: "a display with no panels" },
  {
    config: {
      host: {
        display: {
          screen: { height: 1080, width: 1920 },
          window: { height: 700, width: 1300, x: 100, y: 120 },
        },
      },
    },
    name: "a positioned window",
  },
  {
    config: {
      host: {
        hardware: {
          cores: [
            { value: 8, weight: 3 },
            { value: 12, weight: 1 },
          ],
          gpu: [
            { name: "basharsx4-swiftshader-hidden", weight: 3 },
            { name: "Synthetic_GPU.v2", weight: 1 },
          ],
          memoryGb: [
            { value: 8, weight: 1 },
            { value: 32, weight: 2 },
          ],
        },
      },
    },
    name: "weighted hardware tables",
  },
  { config: { host: { hardware: { gpu: "x".repeat(128) } } }, name: "the longest GL persona name" },
  {
    config: { host: { hardware: { cores: 2_147_483_647 } } },
    name: "the most cores the fork takes",
  },
  { config: { host: { timezone: "UTC" } }, name: "a zone" },
  { config: { host: { browserArgs: [] } }, name: "an empty browserArgs list" },
  { config: { scrape: {} }, name: "an empty scrape section" },
  { config: { scrape: { retries: 0 } }, name: "no retries" },
  { config: { scrape: { retries: 3 } }, name: "three retries" },
  { config: { scrape: { retries: Number.MAX_SAFE_INTEGER } }, name: "the most retries" },
].map((entry) => ({ ...entry, loader: "accepts", schema: "accepts" }));

const BOTH_REJECT: readonly Conformance[] = [
  { config: { browser: { futureSetting: true } }, name: "an unknown top-level key" },
  { config: { $schema: 5 }, name: "a schema reference that is not text" },
  { config: { proxy: { url: 5 } }, name: "a proxy url that is not text" },
  { config: { proxy: { extra: 1, url: "http://proxy.example" } }, name: "an unknown proxy key" },
  { config: { proxy: {} }, name: "a proxy without a url" },
  {
    config: { proxy: { session: { format: "numeric" }, url: "http://proxy.example" } },
    name: "session settings without a placeholder",
  },
  {
    config: { proxy: { session: { id: "12345678" }, url: "http://user-{session}@proxy.example" } },
    name: "a session key that is not format or length",
  },
  {
    config: { proxy: { session: { format: "hex" }, url: "http://user-{session}@proxy.example" } },
    name: "an unknown session format",
  },
  {
    config: { proxy: { session: { length: 257 }, url: "http://user-{session}@proxy.example" } },
    name: "a session length over the cap",
  },
  { config: { host: { dpr: 2 } }, name: "an unknown host key" },
  { config: { host: [] }, name: "a host that is a list" },
  { config: { host: { locale: 5 } }, name: "a locale that is not text" },
  { config: { host: { locale: "sw-KE" } }, name: "an unmeasured locale" },
  { config: { host: { locale: "en_US.UTF-8" } }, name: "a POSIX locale" },
  { config: { host: { locale: "de-de" } }, name: "a locale in another casing" },
  { config: { host: { timezone: 5 } }, name: "a zone that is not text" },
  { config: { host: { browserArgs: "--no-sandbox" } }, name: "browserArgs that is not a list" },
  { config: { host: { browserArgs: ["no-sandbox"] } }, name: "a switch without dashes" },
  { config: { host: { hardware: { memoryGb: 12 } } }, name: "memory Chrome does not report" },
  { config: { host: { hardware: { cores: 0 } } }, name: "zero cores" },
  {
    config: { host: { hardware: { cores: 2_147_483_648 } } },
    name: "more cores than the fork takes",
  },
  { config: { host: { hardware: { gpuPolicy: "hide" } } }, name: "an unknown GPU policy" },
  { config: { host: { hardware: { gpu: "personas/renoir" } } }, name: "a GL persona with a slash" },
  { config: { host: { hardware: { gpu: "x".repeat(129) } } }, name: "a GL persona name too long" },
  { config: { host: { hardware: { threads: 8 } } }, name: "an unknown hardware key" },
  {
    config: { host: { hardware: { cores: [{ value: 8 }] } } },
    name: "a table row without a weight",
  },
  {
    config: { host: { hardware: { cores: [{ value: 8, weight: 0 }] } } },
    name: "a table row with a zero weight",
  },
  { config: { host: { hardware: { cores: [] } } }, name: "an empty table" },
  { config: { host: { display: { screen: { width: 1440 } } } }, name: "a screen without a height" },
  {
    config: { host: { display: { screen: { height: 900.5, width: 1440 } } } },
    name: "a fractional screen",
  },
  {
    config: { host: { display: { screen: { height: 1080, weight: 2, width: 1920 } } } },
    name: "a weight on a single screen",
  },
  { config: { host: { display: { taskbar: { bottom: -1 } } } }, name: "a negative inset" },
  { config: { host: { display: { taskbar: { bottom: null } } } }, name: "a null taskbar edge" },
  { config: { host: { display: { dpr: 2 } } }, name: "an unknown display key" },
  {
    config: { host: { display: { window: { height: 800, width: 1200, x: 10 } } } },
    name: "a window x without a y",
  },
  { config: { host: { display: { window: "fullscreen" } } }, name: "an unknown window keyword" },
  {
    config: { host: { display: { window: [{ maximized: true, weight: 1, width: 900 }] } } },
    name: "a maximized row with a size",
  },
  {
    config: { host: { display: { window: { maximized: true } } } },
    name: "a single maximized window written as a row",
  },
  { config: { scrape: 2 }, name: "a scrape section that is not an object" },
  { config: { scrape: { timeoutMs: 1000 } }, name: "an unknown scrape key" },
  { config: { scrape: { retries: -1 } }, name: "negative retries" },
  { config: { scrape: { retries: 1.5 } }, name: "fractional retries" },
  { config: { scrape: { retries: "2" } }, name: "retries written as text" },
  { config: { scrape: { retries: null } }, name: "null retries" },
  {
    config: { scrape: { retries: Number.MAX_SAFE_INTEGER + 1 } },
    name: "retries past a safe integer",
  },
].map((entry) => ({ ...entry, loader: "rejects", schema: "rejects" }));

const LOADER_ONLY: readonly Conformance[] = [
  { config: { host: { timezone: "Mars/Olympus" } }, name: "a zone Intl does not know" },
  { config: { host: { timezone: "+05:30" } }, name: "an offset instead of a zone" },
  {
    config: { host: { display: { window: { height: 1000, width: 1700 } } } },
    name: "a window that does not fit one of Xrio's screens",
  },
  {
    config: {
      host: {
        display: {
          screen: [
            { height: 1080, weight: 1e308, width: 1920 },
            { height: 900, weight: 1e308, width: 1440 },
          ],
        },
      },
    },
    name: "weights that add up past a finite number",
  },
  { config: { host: { browserArgs: ["--lang=fr"] } }, name: "a switch Xrio manages" },
  { config: { proxy: { url: "not a url" } }, name: "a proxy url that does not parse" },
  {
    config: { proxy: { url: "http://{session}-{session}:secret@proxy.example" } },
    name: "two session placeholders",
  },
  {
    config: { proxy: { url: "http://user:secret@{session}.example" } },
    name: "a placeholder outside the credentials",
  },
].map((entry) => ({ ...entry, loader: "rejects", schema: "accepts" }));

const directories: string[] = [];

const loaderVerdict = (config: object): Verdict => {
  const directory = mkdtempSync(path.join(tmpdir(), "xrio-schema-"));

  directories.push(directory);
  writeFileSync(path.join(directory, "xrio.config.json"), JSON.stringify(config));

  try {
    loadXrioConfig(undefined, directory);
  } catch {
    return "rejects";
  }

  return "accepts";
};

const validate = new Ajv({ strict: true }).compile(XRIO_CONFIG_SCHEMA);

const schemaVerdict = (config: object): Verdict => (validate(config) ? "accepts" : "rejects");

const EXAMPLE = fileURLToPath(new URL("../examples/xrio.config.json", import.meta.url));

const TABLE_FIELDS = new Set(["value", "weight"]);

const FORK_ONLY_SETTING = "host.hardware.gpu";

const joined = (at: string, key: string): string => (at === "" ? key : `${at}.${key}`);

const schemaPaths = (node: JsonSchema, at: string): readonly string[] => [
  ...Object.entries(node.properties ?? {}).flatMap(([key, field]) =>
    field === undefined ? [] : [joined(at, key), ...schemaPaths(field, joined(at, key))],
  ),
  ...(node.oneOf ?? []).flatMap((variant) => schemaPaths(variant, at)),
  ...(node.items === undefined ? [] : schemaPaths(node.items, at)),
];

const configPaths = (value: unknown, at: string): readonly string[] => {
  if (Array.isArray(value)) {
    const rows: unknown[] = value;

    return rows.flatMap((row) => configPaths(row, at));
  }

  if (!isPlainObject(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, field]) => [
    joined(at, key),
    ...configPaths(field, joined(at, key)),
  ]);
};

const isSetting = (setting: string): boolean =>
  !TABLE_FIELDS.has(setting.split(".").at(-1) ?? "") &&
  setting !== FORK_ONLY_SETTING &&
  !setting.startsWith(`${FORK_ONLY_SETTING}.`);

describe("the published JSON schema", () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("is the file shipped as xrio.schema.json", async () => {
    await expect(`${JSON.stringify(XRIO_CONFIG_SCHEMA, undefined, 2)}\n`).toMatchFileSnapshot(
      "../xrio.schema.json",
    );
  });

  it("ships an example that sets every setting except the fork-only GL persona", () => {
    const example: unknown = JSON.parse(readFileSync(EXAMPLE, "utf-8"));
    const set = new Set(configPaths(example, ""));
    const settings = new Set(schemaPaths(XRIO_CONFIG_SCHEMA, "").filter(isSetting));

    expect([...settings].filter((setting) => !set.has(setting))).toStrictEqual([]);
    expect(isPlainObject(example) ? schemaVerdict(example) : "not an object").toBe("accepts");
    expect(loadXrioConfig(EXAMPLE).host.identity.locale).toBe("de-DE");
  });

  it.each([...BOTH_ACCEPT, ...BOTH_REJECT, ...LOADER_ONLY])(
    "judges $name as the loader $loader and the schema $schema",
    ({ config, loader, schema }) => {
      expect({ loader: loaderVerdict(config), schema: schemaVerdict(config) }).toStrictEqual({
        loader,
        schema,
      });
    },
  );

  it.each(Object.keys(CHROME_ACCEPT_LANGUAGES))(
    "accepts the measured locale %s in both",
    (locale) => {
      const config = { host: { locale } };

      expect({ loader: loaderVerdict(config), schema: schemaVerdict(config) }).toStrictEqual({
        loader: "accepts",
        schema: "accepts",
      });
    },
  );
});
