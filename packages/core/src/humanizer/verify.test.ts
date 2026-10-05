import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CHECKED_FONT_STACK } from "../testing/fake-font-stack.ts";
import { fixedDevice } from "../testing/fixed-seed.ts";
import { forkWithKnobs } from "../testing/hardware-fork.ts";
import { noPins } from "../testing/no-pins.ts";
import type { FontEvidence, HostCapabilities, Observation } from "./contracts.ts";
import { planIdentity } from "./humanizer.ts";
import type { IdentityContext } from "./surfaces.ts";
import {
  AFTER_CAPTURE_READ,
  describeMismatch,
  evaluate,
  identityRead,
  readAfterCapture,
  readObservation,
} from "./verify.ts";
import type { SurfaceExpectation } from "./verify.ts";

const MEASURED = { headless: false, major: 154, version: "154.0.8037.57" };

const UNMEASURED = { headless: false, major: 152, version: "152.0.7977.75" };

const linuxHeadless: Observation = {
  afterCapture: { kind: "not-navigated" },
  anyPointer: "fine",
  availHeight: 1018,
  availLeft: 0,
  availTop: 32,
  availWidth: 1680,
  colorDepth: 24,
  colorScheme: "light",
  devicePixelRatio: 1,
  fontsDigest: "c41f09a2",
  fontsSentinel: "5e17a1b2",
  fontsSentinelResolved: true,
  hardwareConcurrency: 32,
  hover: "hover",
  intlLocale: "en-US",
  languages: ["en-US", "en"],
  maxTouchPoints: 0,
  outerHeight: 1018,
  outerWidth: 1680,
  pointer: "fine",
  product: MEASURED,
  reducedMotion: "no-preference",
  requestedOffsets: ["GMT+05:30", "GMT+05:30"],
  requestedZone: "Asia/Kolkata",
  screenHeight: 1050,
  screenWidth: 1680,
  screenX: 0,
  screenY: 32,
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  webdriver: false,
  webgl: true,
  zone: "Asia/Calcutta",
  zoneOffsets: ["GMT+05:30", "GMT+05:30"],
};

const contextOf = (overrides: Partial<IdentityContext> = {}): IdentityContext => ({
  capabilities: { fontStack: CHECKED_FONT_STACK, permittedCpus: 32, platform: "linux" },
  device: fixedDevice,
  exit: { facts: { kind: "unknown" }, route: "direct" },
  hostZone: "Asia/Kolkata",
  mode: "headless",
  pins: noPins,
  ...overrides,
});

const EVIDENCE: FontEvidence = {
  ageMs: 5_400_000,
  digest: "2eeb6d13",
  key: "5be0c7d2",
  sentinel: "c6755abb",
};

const planFor = (overrides: Partial<IdentityContext> = {}) => planIdentity(contextOf(overrides));

const planWithEvidence = () =>
  planFor({
    capabilities: {
      fontEvidence: EVIDENCE,
      fontStack: CHECKED_FONT_STACK,
      permittedCpus: 32,
      platform: "linux",
    },
  });

const planWith = (expected: readonly SurfaceExpectation[]) => ({ ...planFor(), expected });

const expectation = (overrides: Partial<SurfaceExpectation>): SurfaceExpectation => ({
  compatibility: false,
  field: "languages",
  matcher: { kind: "equals", value: ["en-US", "en"] },
  severity: "fatal",
  surface: "locale",
  ...overrides,
});

describe("each matcher kind", () => {
  it.each([
    {
      held: { ...linuxHeadless, languages: ["en-US", "en"] },
      kind: "equals",
      missed: { ...linuxHeadless, languages: ["de-DE", "de"] },
      rule: expectation({}),
      seen: ["de-DE", "de"],
      wanted: ["en-US", "en"],
    },
    {
      held: { ...linuxHeadless, intlLocale: "en" },
      kind: "same-language",
      missed: { ...linuxHeadless, intlLocale: "de-DE" },
      rule: expectation({
        field: "intlLocale",
        matcher: { kind: "same-language", locale: "en-US" },
      }),
      seen: "de-DE",
      wanted: "en",
    },
    {
      held: linuxHeadless,
      kind: "zone-offsets",
      missed: { ...linuxHeadless, zoneOffsets: ["GMT+00:00", "GMT+00:00"] },
      rule: expectation({
        field: "zoneOffsets",
        matcher: { kind: "zone-offsets" },
        surface: "timezone",
      }),
      seen: ["GMT+00:00", "GMT+00:00"],
      wanted: ["GMT+05:30", "GMT+05:30"],
    },
    {
      held: { ...linuxHeadless, outerWidth: 1680 },
      kind: "at-most-field",
      missed: { ...linuxHeadless, outerWidth: 1681 },
      rule: expectation({
        field: "outerWidth",
        matcher: { field: "availWidth", kind: "at-most-field" },
        surface: "window",
      }),
      seen: 1681,
      wanted: 1680,
    },
    {
      held: linuxHeadless,
      kind: "no-headless-token",
      missed: {
        ...linuxHeadless,
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36",
      },
      rule: expectation({
        field: "userAgent",
        matcher: { kind: "no-headless-token" },
        surface: "automation",
      }),
      seen: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36",
      wanted:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
    },
  ] as const)(
    "$kind holds or names the field it missed",
    ({ held, missed, rule, seen, wanted }) => {
      expect(evaluate(planWith([rule]), held).mismatches).toStrictEqual([]);
      expect(evaluate(planWith([rule]), missed).mismatches).toStrictEqual([
        {
          expected: wanted,
          field: rule.field,
          observed: seen,
          surface: rule.surface,
        },
      ]);
    },
  );
});

describe("severity", () => {
  const germanLinux = { ...linuxHeadless, intlLocale: "de", languages: ["de-DE", "de"] };

  it("fails a compatibility expectation on a measured Chrome major", () => {
    expect(evaluate(planFor(), germanLinux)).toMatchObject({
      mismatches: [
        {
          expected: ["en-US", "en"],
          field: "languages",
          observed: ["de-DE", "de"],
          surface: "locale",
        },
        { expected: "en", field: "intlLocale", observed: "de", surface: "locale" },
      ],
      report: { notes: [], tells: ["hardware-unhonored"] },
    });
  });

  it("only notes a compatibility expectation on an unmeasured Chrome major", () => {
    expect(evaluate(planFor(), { ...germanLinux, product: UNMEASURED })).toMatchObject({
      mismatches: [],
      report: {
        notes: [
          {
            expected: ["en-US", "en"],
            field: "languages",
            observed: ["de-DE", "de"],
            surface: "locale",
          },
          { expected: "en", field: "intlLocale", observed: "de", surface: "locale" },
        ],
        tells: ["unmeasured-chrome", "hardware-unhonored"],
      },
    });
  });

  it("fails a page with no WebGL context on a measured Chrome major and only notes it on another", () => {
    const noWebgl = { ...linuxHeadless, webgl: false };
    const mismatch = { expected: true, field: "webgl", observed: false, surface: "gpu" };

    expect(evaluate(planFor(), noWebgl).mismatches).toStrictEqual([mismatch]);
    expect(evaluate(planFor(), { ...noWebgl, product: UNMEASURED })).toMatchObject({
      mismatches: [],
      report: { notes: [mismatch] },
    });
  });

  it("keeps the zone offsets fatal on an unmeasured Chrome major", () => {
    const utc = { ...linuxHeadless, product: UNMEASURED, zoneOffsets: ["GMT+00:00", "GMT+00:00"] };

    expect(evaluate(planFor(), utc).mismatches).toStrictEqual([
      {
        expected: ["GMT+05:30", "GMT+05:30"],
        field: "zoneOffsets",
        observed: ["GMT+00:00", "GMT+00:00"],
        surface: "timezone",
      },
    ]);
  });

  it("only notes a zone the page's Intl cannot name while Chrome names a zone, reporting that zone", () => {
    expect(
      evaluate(planFor({ hostZone: "Antarctica/Coyhaique" }), {
        ...linuxHeadless,
        requestedOffsets: null,
        requestedZone: "Antarctica/Coyhaique",
        zone: "UTC",
        zoneOffsets: ["GMT+00:00", "GMT+00:00"],
      }),
    ).toMatchObject({
      mismatches: [],
      report: {
        notes: [
          {
            expected: "Antarctica/Coyhaique",
            field: "zoneOffsets",
            observed: ["UTC", "GMT+00:00", "GMT+00:00"],
            surface: "timezone",
          },
        ],
        tells: ["hardware-unhonored"],
      },
    });
  });

  it.each([null, "Etc/Unknown"])(
    "fails a TZ for which Chrome reports the zone %j, on an unmeasured major too",
    (zone) => {
      expect(
        evaluate(planFor({ hostZone: "UTC0" }), {
          ...linuxHeadless,
          product: UNMEASURED,
          requestedOffsets: null,
          requestedZone: "UTC0",
          zone,
          zoneOffsets: ["GMT+00:00", "GMT+00:00"],
        }),
      ).toMatchObject({
        mismatches: [{ expected: "UTC0", field: "zone", observed: zone, surface: "timezone" }],
        report: { notes: [], tells: ["unmeasured-chrome", "hardware-unhonored"] },
      });
    },
  );

  it("only notes an Intl language off the plan on macOS", () => {
    expect(
      evaluate(planFor({ capabilities: { permittedCpus: 32, platform: "darwin" } }), {
        ...linuxHeadless,
        colorScheme: "dark",
        intlLocale: "fr-CA",
      }),
    ).toMatchObject({
      mismatches: [],
      report: {
        notes: [{ expected: "en", field: "intlLocale", observed: "fr-CA", surface: "locale" }],
        tells: ["hardware-unhonored"],
      },
    });
  });
});

const hardwarePlan = () =>
  planFor({ capabilities: { ...forkWithKnobs(), fontStack: CHECKED_FONT_STACK } });

const secure = (deviceMemory: number | null): Observation["afterCapture"] => ({
  battery: true,
  clientHints: null,
  deviceMemory,
  kind: "secure",
  webgpu: false,
});

describe("the hardware expectations", () => {
  const seen = { ...linuxHeadless, hardwareConcurrency: 6 };

  it("holds when the page reads the drawn cores and memory", () => {
    expect(evaluate(hardwarePlan(), { ...seen, afterCapture: secure(16) })).toMatchObject({
      mismatches: [],
      report: { notes: [], tells: [] },
    });
  });

  it("fails a scrape whose page reads other cores than the drawn ones", () => {
    expect(
      evaluate(hardwarePlan(), { ...linuxHeadless, afterCapture: secure(16) }).mismatches,
    ).toStrictEqual([
      { expected: 6, field: "hardwareConcurrency", observed: 32, surface: "hardware" },
    ]);
  });

  it("notes other memory than the drawn one and tells hardware-drift, never failing the scrape", () => {
    expect(evaluate(hardwarePlan(), { ...seen, afterCapture: secure(8) })).toMatchObject({
      mismatches: [],
      report: {
        notes: [{ expected: 16, field: "deviceMemory", observed: 8, surface: "hardware" }],
        tells: ["hardware-drift"],
      },
    });
  });

  it.each([
    { afterCapture: { kind: "insecure" }, name: "an insecure page" },
    { afterCapture: { kind: "failed" }, name: "a failed read" },
    { afterCapture: { kind: "skipped" }, name: "a skipped read" },
    { afterCapture: { kind: "not-navigated" }, name: "a scrape that never navigated" },
    { afterCapture: secure(null), name: "a page with no deviceMemory" },
  ] as const)("expects no memory from $name", ({ afterCapture }) => {
    expect(evaluate(hardwarePlan(), { ...seen, afterCapture })).toMatchObject({
      mismatches: [],
      report: { notes: [], tells: [] },
    });
  });

  it("expects nothing on stock Chrome, whatever cores and memory the host shows", () => {
    expect(
      evaluate(planFor(), { ...linuxHeadless, afterCapture: secure(32), hardwareConcurrency: 64 }),
    ).toMatchObject({
      mismatches: [],
      report: { notes: [], tells: ["hardware-unhonored"] },
    });
  });

  it("only notes a core mismatch on an unmeasured Chrome major", () => {
    expect(
      evaluate(hardwarePlan(), { ...linuxHeadless, afterCapture: secure(16), product: UNMEASURED }),
    ).toMatchObject({
      mismatches: [],
      report: {
        notes: [{ expected: 6, field: "hardwareConcurrency", observed: 32, surface: "hardware" }],
      },
    });
  });
});

describe("the colour scheme", () => {
  it("is a note on Linux when Chrome reports dark", () => {
    expect(evaluate(planFor(), { ...linuxHeadless, colorScheme: "dark" })).toMatchObject({
      mismatches: [],
      report: {
        notes: [
          { expected: "light", field: "colorScheme", observed: "dark", surface: "automation" },
        ],
        tells: ["hardware-unhonored"],
      },
    });
  });
});

describe("the no-taskbar tell", () => {
  const screenOnly = {
    ...linuxHeadless,
    availHeight: 1080,
    availLeft: 0,
    availTop: 0,
    availWidth: 1920,
    screenHeight: 1080,
    screenWidth: 1920,
  };

  it.each([
    { name: "a screen with no inset", observation: screenOnly, tells: ["no-taskbar"] },
    {
      name: "a dock on the left only",
      observation: { ...screenOnly, availLeft: 64, availWidth: 1856 },
      tells: [],
    },
    {
      name: "a panel on the right only",
      observation: { ...screenOnly, availWidth: 1872 },
      tells: [],
    },
  ])("fires only when no edge is inset, not for $name", ({ observation, tells }) => {
    expect(
      evaluate(planFor(), observation).report.tells.filter((tell) => tell === "no-taskbar"),
    ).toStrictEqual(tells);
  });
});

describe("the headed window", () => {
  it("notes a window wider than the observed work area and derives the display tells", () => {
    const smallXvfb = {
      ...linuxHeadless,
      availHeight: 768,
      availTop: 0,
      availWidth: 1024,
      colorDepth: 16,
      outerHeight: 900,
      outerWidth: 1600,
      screenHeight: 768,
      screenWidth: 1024,
    };

    expect(evaluate(planFor({ mode: "headed" }), smallXvfb)).toMatchObject({
      mismatches: [],
      report: {
        notes: [
          { expected: 1024, field: "outerWidth", observed: 1600, surface: "window" },
          { expected: 768, field: "outerHeight", observed: 900, surface: "window" },
        ],
        tells: ["no-taskbar", "display-implausible", "hardware-unhonored", "flag-infobar"],
      },
    });
  });
});

describe("a pinned alias", () => {
  it("passes on the zone Chrome names, which the report names as well", () => {
    const kyiv = {
      ...linuxHeadless,
      requestedOffsets: ["GMT+02:00", "GMT+03:00"],
      requestedZone: "Europe/Kiev",
      zone: "Europe/Kiev",
      zoneOffsets: ["GMT+02:00", "GMT+03:00"],
    };

    expect(evaluate(planFor({ pins: { ...noPins, timezone: "Europe/Kyiv" } }), kyiv)).toMatchObject(
      {
        mismatches: [],
        report: {
          notes: [],
          observed: { timeZone: "Europe/Kiev" },
          surfaces: { timezone: { source: "pin", zone: "Europe/Kiev" } },
          tells: ["hardware-unhonored"],
        },
      },
    );
  });

  it("fails when Chrome presents other offsets than the pinned zone's", () => {
    const hostLeak = {
      ...linuxHeadless,
      requestedOffsets: ["GMT+02:00", "GMT+03:00"],
      requestedZone: "Europe/Kiev",
      zone: "Asia/Calcutta",
    };

    expect(
      evaluate(planFor({ pins: { ...noPins, timezone: "Europe/Kyiv" } }), hostLeak).mismatches,
    ).toStrictEqual([
      {
        expected: ["GMT+02:00", "GMT+03:00"],
        field: "zoneOffsets",
        observed: ["GMT+05:30", "GMT+05:30"],
        surface: "timezone",
      },
    ]);
  });
});

describe("tells", () => {
  it("names stock headless Chrome's user agent token", () => {
    const headless = {
      ...linuxHeadless,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/154.0.0.0 Safari/537.36",
    };

    expect(evaluate(planFor(), headless).report.tells).toStrictEqual([
      "headless-token",
      "hardware-unhonored",
    ]);
  });

  it("lists what the plan's facts show after what Chrome was observed to present", () => {
    const headless = {
      ...linuxHeadless,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/154.0.0.0 Safari/537.36",
    };

    const proxied = planFor({ exit: { facts: { kind: "unknown" }, route: "proxy" } });

    expect(evaluate(proxied, headless).report.tells).toStrictEqual([
      "headless-token",
      "exit-unknown",
      "hardware-unhonored",
    ]);
  });
});

describe("the fonts evidence", () => {
  const sentinelOnly: Observation = {
    ...linuxHeadless,
    fontsDigest: null,
    fontsSentinel: "c6755abb",
  };

  it("hands the digest and sentinel of a launch with no evidence to the store, as observed", () => {
    const { fontEvidence, report } = evaluate(planFor(), linuxHeadless);

    expect({
      coverage: report.coverage.fonts,
      digest: report.observed.fontsDigest,
      fontEvidence,
    }).toStrictEqual({
      coverage: { state: "observed" },
      digest: "c41f09a2",
      fontEvidence: { digest: "c41f09a2", kind: "gathered", sentinel: "5e17a1b2" },
    });
  });

  it("reports the stored digest as cached with its key and age when the sentinel agrees", () => {
    const { fontEvidence, mismatches, report } = evaluate(planWithEvidence(), sentinelOnly);

    expect({
      coverage: report.coverage.fonts,
      digest: report.observed.fontsDigest,
      fontEvidence,
      mismatches,
      notes: report.notes,
      tells: report.tells,
    }).toStrictEqual({
      coverage: { ageMs: 5_400_000, key: "5be0c7d2", state: "cached" },
      digest: "2eeb6d13",
      fontEvidence: { kind: "confirmed" },
      mismatches: [],
      notes: [],
      tells: ["hardware-unhonored"],
    });
  });

  it("notes a sentinel off the evidence and tells fonts-drift, never failing the launch, and reports no digest", () => {
    const { fontEvidence, mismatches, report } = evaluate(planWithEvidence(), {
      ...sentinelOnly,
      fontsSentinel: "deadbeef",
    });

    expect({
      coverage: report.coverage.fonts,
      digest: report.observed.fontsDigest,
      fontEvidence,
      mismatches,
      notes: report.notes,
      tells: report.tells,
    }).toStrictEqual({
      coverage: { reason: "fonts-drift", state: "unchecked" },
      digest: null,
      fontEvidence: { kind: "drifted" },
      mismatches: [],
      notes: [
        { expected: "c6755abb", field: "fontsSentinel", observed: "deadbeef", surface: "fonts" },
      ],
      tells: ["hardware-unhonored", "fonts-drift"],
    });
  });

  it("does not store the evidence of a gathering launch whose pinned stack's sentinel resolved nothing", () => {
    const { fontEvidence, mismatches, report } = evaluate(planFor(), {
      ...linuxHeadless,
      fontsSentinelResolved: false,
    });

    expect({
      coverage: report.coverage.fonts,
      digest: report.observed.fontsDigest,
      fontEvidence,
      mismatches,
      notes: report.notes,
      tells: report.tells,
    }).toStrictEqual({
      coverage: { state: "observed" },
      digest: "c41f09a2",
      fontEvidence: { kind: "unproven" },
      mismatches: [],
      notes: [
        { expected: true, field: "fontsSentinelResolved", observed: false, surface: "fonts" },
      ],
      tells: ["hardware-unhonored", "fonts-drift"],
    });
  });

  it("expects the sentinel to resolve only where the stack is pinned", () => {
    const hostFonts = planFor({ capabilities: { permittedCpus: 32, platform: "linux" } });
    const unresolved = { ...linuxHeadless, fontsSentinelResolved: false };

    expect([
      evaluate(hostFonts, unresolved).report.notes,
      evaluate(planFor({ capabilities: { permittedCpus: 32, platform: "darwin" } }), unresolved)
        .report.notes,
    ]).toStrictEqual([[], []]);
  });

  it("does not compare a sentinel when there is no evidence", () => {
    expect(
      evaluate(planFor(), { ...linuxHeadless, fontsSentinel: "deadbeef" }).report.notes,
    ).toStrictEqual([]);
  });
});

describe(readObservation, () => {
  const { afterCapture: _afterCapture, product: _product, ...reading } = linuxHeadless;

  it("adds the browser's product to a well-formed read, with nothing read after capture yet", () => {
    expect(readObservation(MEASURED, JSON.stringify(reading))).toStrictEqual(linuxHeadless);
  });

  it.each([
    { read: JSON.stringify({ ...reading, webdriver: "false" }), refusal: "webdriver" },
    { read: JSON.stringify({ ...reading, webgl: undefined }), refusal: "webgl" },
    { read: JSON.stringify({ ...reading, fontsDigest: 7 }), refusal: "fontsDigest" },
    { read: JSON.stringify({ ...reading, fontsSentinel: null }), refusal: "fontsSentinel" },
    {
      read: JSON.stringify({ ...reading, hardwareConcurrency: "8" }),
      refusal: "hardwareConcurrency",
    },
    { read: JSON.stringify({ ...reading, languages: undefined }), refusal: "languages" },
    { read: JSON.stringify({ ...reading, zoneOffsets: [0, 0] }), refusal: "zoneOffsets" },
    { read: "null", refusal: "anyPointer, availHeight" },
  ])(
    "refuses a read with a malformed $refusal on an unmeasured Chrome major too",
    ({ read, refusal }) => {
      expect(() => readObservation(UNMEASURED, read)).toThrow(
        `The identity read returned a malformed ${refusal}`,
      );
    },
  );

  it("refuses a read that is not JSON", () => {
    expect(() => readObservation(UNMEASURED, "<html>")).toThrow(SyntaxError);
  });
});

const SENTINEL_MEASURES = 9;

const FULL_MEASURES = 120;

interface PageOptions {
  readonly canCreateWebgl?: boolean;
  readonly fallsBack?: boolean;
  readonly measured?: string[];
}

const widthOf = (font: string): number =>
  (font.split("").reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0) % 977) / 8;

const genericOf = (font: string): string => `72px ${font.slice(font.lastIndexOf(" ") + 1)}`;

const canvasDocument = ({
  canCreateWebgl = true,
  fallsBack = false,
  measured = [],
}: PageOptions) => ({
  createElement: () => ({
    getContext: (kind: string) => {
      if (kind === "webgl") {
        return canCreateWebgl ? {} : null;
      }

      const context = {
        font: "",
        measureText: () => {
          measured.push(context.font);

          return { width: widthOf(fallsBack ? genericOf(context.font) : context.font) };
        },
      };

      return context;
    },
  }),
});

const pageGlobals = (matching: ReadonlySet<string>, options: PageOptions) => ({
  devicePixelRatio: 1,
  document: canvasDocument(options),
  matchMedia: (query: string) => ({ matches: matching.has(query) }),
  navigator: {
    hardwareConcurrency: 12,
    languages: ["en-US", "en"],
    maxTouchPoints: 0,
    userAgent: "Mozilla/5.0 Chrome/154.0.0.0",
    webdriver: false,
  },
  outerHeight: 900,
  outerWidth: 1600,
  screen: {
    availHeight: 1040,
    availLeft: 0,
    availTop: 32,
    availWidth: 1920,
    colorDepth: 24,
    height: 1080,
    width: 1920,
  },
  screenX: 22,
  screenY: 44,
});

const runRead = (read: string, matching: ReadonlySet<string>, options: PageOptions = {}): string =>
  String(runInNewContext(read, pageGlobals(matching, options)));

const readInPage = (
  hostZone: string,
  matching: ReadonlySet<string>,
  measured: string[] = [],
  fontEvidence?: FontEvidence,
): string => {
  const capabilities: HostCapabilities =
    fontEvidence === undefined
      ? { permittedCpus: 32, platform: "linux" }
      : { fontEvidence, permittedCpus: 32, platform: "linux" };

  return runRead(
    planIdentity(contextOf({ capabilities, hostZone })).read.beforeNavigation,
    matching,
    { measured },
  );
};

describe(identityRead, () => {
  const lightDesktop = new Set([
    "(prefers-color-scheme: light)",
    "(prefers-reduced-motion: no-preference)",
    "(pointer: fine)",
    "(hover: hover)",
    "(any-pointer: fine)",
  ]);

  it("reads every field the observation needs, with the requested zone's offsets", () => {
    expect(readObservation(MEASURED, readInPage("Asia/Kolkata", lightDesktop))).toMatchObject({
      anyPointer: "fine",
      availTop: 32,
      colorScheme: "light",
      hardwareConcurrency: 12,
      hover: "hover",
      languages: ["en-US", "en"],
      outerWidth: 1600,
      pointer: "fine",
      reducedMotion: "no-preference",
      requestedOffsets: ["GMT+05:30", "GMT+05:30"],
      screenHeight: 1080,
      screenY: 44,
      webdriver: false,
      webgl: true,
    });
  });

  it.each([true, false])("reads webgl %s as the page's canvas gives it", (webgl) => {
    const read = planIdentity(contextOf()).read.beforeNavigation;

    expect(
      readObservation(MEASURED, runRead(read, lightDesktop, { canCreateWebgl: webgl })),
    ).toMatchObject({ webgl });
  });

  it("without evidence, measures the sentinel and 40 families against each generic and reports both digests", () => {
    const measured: string[] = [];
    const reading = readObservation(MEASURED, readInPage("UTC", new Set(), measured));

    expect({
      count: measured.length,
      digest: reading.fontsDigest,
      first: measured.slice(0, 4),
      last: measured.at(-1),
      resolved: reading.fontsSentinelResolved,
      sentinel: reading.fontsSentinel,
    }).toStrictEqual({
      count: SENTINEL_MEASURES + FULL_MEASURES,
      digest: "2eeb6d13",
      first: ["72px monospace", "72px sans-serif", "72px serif", '72px "Ubuntu", monospace'],
      last: '72px "Amiri", serif',
      resolved: true,
      sentinel: "c6755abb",
    });
  });

  it("reports a sentinel that no family resolves, because every width equals the generic fallback", () => {
    const pinned = planIdentity(contextOf());

    const reading = readObservation(
      MEASURED,
      runRead(pinned.read.beforeNavigation, new Set(), { fallsBack: true }),
    );

    expect([reading.fontsSentinelResolved, reading.fontsDigest]).toStrictEqual([false, "046bc60b"]);
  });

  it("with evidence, measures only the sentinel and reports no digest", () => {
    const measured: string[] = [];
    const reading = readObservation(MEASURED, readInPage("UTC", new Set(), measured, EVIDENCE));

    expect({
      count: measured.length,
      digest: reading.fontsDigest,
      last: measured.at(-1),
      sentinel: reading.fontsSentinel,
    }).toStrictEqual({
      count: SENTINEL_MEASURES,
      digest: null,
      last: '72px "KACSTOffice", serif',
      sentinel: "c6755abb",
    });
  });

  it("requests the pinned zone, not the host's", () => {
    const pinned = planIdentity(
      contextOf({ hostZone: "America/Chicago", pins: { ...noPins, timezone: "Asia/Kolkata" } }),
    );

    expect(
      readObservation(MEASURED, runRead(pinned.read.beforeNavigation, lightDesktop)),
    ).toMatchObject({
      requestedOffsets: ["GMT+05:30", "GMT+05:30"],
      requestedZone: "Asia/Calcutta",
    });
  });

  it("reads no requested offsets for a zone Intl refuses", () => {
    expect(
      readObservation(MEASURED, runRead(identityRead("Mars/Olympus", "full"), new Set())),
    ).toMatchObject({ colorScheme: null, requestedOffsets: null, requestedZone: "Mars/Olympus" });
  });
});

const zoneCheckUnder = (hostZone: string, requestedZone = hostZone) => {
  vi.stubEnv("TZ", hostZone);

  const observation = readObservation(MEASURED, readInPage(requestedZone, new Set()));

  const zoneExpectations = planFor({ hostZone: requestedZone }).expected.filter(
    ({ surface }) => surface === "timezone",
  );

  return { observation, ...evaluate(planWith(zoneExpectations), observation) };
};

describe("the zone check run against the host's Intl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["UTC", "America/Chicago", "Europe/Berlin", "Asia/Calcutta"])(
    "accepts TZ=%s, comparing the zone it names",
    (zone) => {
      expect(zoneCheckUnder(zone)).toMatchObject({
        mismatches: [],
        observation: { requestedZone: zone },
        report: { notes: [], tells: ["hardware-unhonored"] },
      });
    },
  );

  it.each(["UTC0", "Mars/Olympus", " America/Chicago"])(
    "fails TZ=%j, for which Intl names no default zone",
    (zone) => {
      const { mismatches, observation, report } = zoneCheckUnder(zone);

      expect({
        described: mismatches.map((mismatch) => describeMismatch(mismatch, observation)),
        mismatches,
        report,
      }).toMatchObject({
        described: [`timezone zone (TZ=${zone}; Chrome named no zone)`],
        mismatches: [{ expected: zone, field: "zone", observed: null, surface: "timezone" }],
        report: { notes: [], tells: ["hardware-unhonored"] },
      });
    },
  );

  it("names the requested TZ when it describes a zone mismatch", () => {
    const { mismatches, observation } = zoneCheckUnder("America/Bogota", "America/Chicago");

    expect(mismatches.map((mismatch) => describeMismatch(mismatch, observation))).toStrictEqual([
      "timezone zoneOffsets (TZ=America/Chicago)",
    ]);
  });

  it("tells apart zones that share summer time but not winter time", () => {
    expect(zoneCheckUnder("America/Bogota", "America/Chicago").mismatches).toStrictEqual([
      {
        expected: ["GMT-06:00", "GMT-05:00"],
        field: "zoneOffsets",
        observed: ["GMT-05:00", "GMT-05:00"],
        surface: "timezone",
      },
    ]);
  });
});

const securePage = {
  getBattery: async () => await Promise.resolve({}),
  gpu: {},
  userAgentData: {
    getHighEntropyValues: async () =>
      await Promise.resolve({
        architecture: "x86",
        bitness: "64",
        brands: [{ brand: "Chromium", version: "154" }],
        fullVersionList: [{ brand: "Chromium", version: "154.0.8037.57" }],
        mobile: false,
        model: "",
        platform: "Linux",
        platformVersion: "6.8.0",
        wow64: false,
      }),
  },
};

const readAfterCaptureIn = async (
  isSecureContext: boolean,
  navigator: Partial<typeof securePage> & { readonly deviceMemory?: number },
): Promise<string> => {
  const read: unknown = await runInNewContext(AFTER_CAPTURE_READ, { isSecureContext, navigator });

  return String(read);
};

describe("the after-capture read", () => {
  it("reads the secure-context surfaces on a secure origin", async () => {
    expect(
      readAfterCapture(await readAfterCaptureIn(true, { ...securePage, deviceMemory: 8 })),
    ).toStrictEqual({
      battery: true,
      clientHints: {
        architecture: "x86",
        bitness: "64",
        brands: [{ brand: "Chromium", version: "154" }],
        fullVersionList: [{ brand: "Chromium", version: "154.0.8037.57" }],
        mobile: false,
        model: "",
        platform: "Linux",
        platformVersion: "6.8.0",
        wow64: false,
      },
      deviceMemory: 8,
      kind: "secure",
      webgpu: true,
    });
  });

  it("reports what a page without the APIs exposes as null or false", async () => {
    expect(readAfterCapture(await readAfterCaptureIn(true, {}))).toStrictEqual({
      battery: false,
      clientHints: null,
      deviceMemory: null,
      kind: "secure",
      webgpu: false,
    });
  });

  it("reads nothing on a non-secure origin", async () => {
    expect(readAfterCapture(await readAfterCaptureIn(false, securePage))).toStrictEqual({
      kind: "insecure",
    });
  });

  it.each([
    { reading: "{}", why: "no kind" },
    { reading: JSON.stringify({ kind: "secure" }), why: "missing fields" },
    {
      reading: JSON.stringify({
        battery: true,
        clientHints: { architecture: 64 },
        deviceMemory: 8,
        kind: "secure",
        webgpu: true,
      }),
      why: "a malformed client hint",
    },
  ])("refuses a reading with $why", ({ reading }) => {
    expect(() => readAfterCapture(reading)).toThrow(
      "The after-capture read returned a malformed reading.",
    );
  });
});
