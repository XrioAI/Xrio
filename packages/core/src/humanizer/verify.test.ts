import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { noPins } from "../testing/no-pins.ts";
import type { Observation } from "./contracts.ts";
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
  availHeight: 1040,
  availWidth: 1920,
  colorDepth: 24,
  colorScheme: "light",
  devicePixelRatio: 1,
  hover: "hover",
  intlLocale: "en-US",
  languages: ["en-US", "en"],
  maxTouchPoints: 0,
  outerHeight: 900,
  outerWidth: 1600,
  pointer: "fine",
  product: MEASURED,
  reducedMotion: "no-preference",
  requestedOffsets: ["GMT+05:30", "GMT+05:30"],
  requestedZone: "Asia/Kolkata",
  screenHeight: 1080,
  screenWidth: 1920,
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  webdriver: false,
  webgl: true,
  zone: "Asia/Calcutta",
  zoneOffsets: ["GMT+05:30", "GMT+05:30"],
};

const contextOf = (overrides: Partial<IdentityContext> = {}): IdentityContext => ({
  capabilities: { platform: "linux" },
  exit: { facts: { kind: "unknown" }, route: "direct" },
  hostZone: "Asia/Kolkata",
  mode: "headless",
  pins: noPins,
  ...overrides,
});

const planFor = (overrides: Partial<IdentityContext> = {}) => planIdentity(contextOf(overrides));

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
      wanted: ["GMT+05:30", "GMT+05:30"],
    },
    {
      held: { ...linuxHeadless, outerWidth: 1920 },
      kind: "at-most-field",
      missed: { ...linuxHeadless, outerWidth: 1921 },
      rule: expectation({
        field: "outerWidth",
        matcher: { field: "availWidth", kind: "at-most-field" },
        surface: "window",
      }),
      wanted: 1920,
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
      wanted:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
    },
  ] as const)("$kind holds or names the field it missed", ({ held, missed, rule, wanted }) => {
    expect(evaluate(planWith([rule]), held).mismatches).toStrictEqual([]);
    expect(evaluate(planWith([rule]), missed).mismatches).toStrictEqual([
      {
        expected: wanted,
        field: rule.field,
        observed: missed[rule.field],
        surface: rule.surface,
      },
    ]);
  });
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
      report: { notes: [], tells: [] },
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
        tells: ["unmeasured-chrome"],
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
        tells: [],
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
        report: { notes: [], tells: ["unmeasured-chrome"] },
      });
    },
  );

  it("only notes an Intl language off the plan on macOS", () => {
    expect(
      evaluate(planFor({ capabilities: { platform: "darwin" } }), {
        ...linuxHeadless,
        colorScheme: "dark",
        intlLocale: "fr-CA",
      }),
    ).toMatchObject({
      mismatches: [],
      report: {
        notes: [{ expected: "en", field: "intlLocale", observed: "fr-CA", surface: "locale" }],
        tells: [],
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
        tells: [],
      },
    });
  });
});

describe("the headed window", () => {
  it("notes a window wider than the observed work area and derives the display tells", () => {
    const smallXvfb = {
      ...linuxHeadless,
      availHeight: 768,
      availWidth: 1024,
      colorDepth: 16,
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
        tells: ["no-taskbar", "display-implausible"],
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
          tells: [],
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

    expect(evaluate(planFor(), headless).report.tells).toStrictEqual(["headless-token"]);
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
    ]);
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

const pageGlobals = (matching: ReadonlySet<string>, canCreateWebgl: boolean) => ({
  devicePixelRatio: 1,
  document: { createElement: () => ({ getContext: () => (canCreateWebgl ? {} : null) }) },
  matchMedia: (query: string) => ({ matches: matching.has(query) }),
  navigator: {
    languages: ["en-US", "en"],
    maxTouchPoints: 0,
    userAgent: "Mozilla/5.0 Chrome/154.0.0.0",
    webdriver: false,
  },
  outerHeight: 900,
  outerWidth: 1600,
  screen: { availHeight: 1040, availWidth: 1920, colorDepth: 24, height: 1080, width: 1920 },
});

const runRead = (read: string, matching: ReadonlySet<string>, canCreateWebgl = true): string =>
  String(runInNewContext(read, pageGlobals(matching, canCreateWebgl)));

const readInPage = (hostZone: string, matching: ReadonlySet<string>): string =>
  runRead(planIdentity(contextOf({ hostZone })).read.beforeNavigation, matching);

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
      colorScheme: "light",
      hover: "hover",
      languages: ["en-US", "en"],
      outerWidth: 1600,
      pointer: "fine",
      reducedMotion: "no-preference",
      requestedOffsets: ["GMT+05:30", "GMT+05:30"],
      screenHeight: 1080,
      webdriver: false,
      webgl: true,
    });
  });

  it.each([true, false])("reads webgl %s as the page's canvas gives it", (webgl) => {
    const read = planIdentity(contextOf()).read.beforeNavigation;

    expect(readObservation(MEASURED, runRead(read, lightDesktop, webgl))).toMatchObject({ webgl });
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
      readObservation(MEASURED, runRead(identityRead("Mars/Olympus"), new Set())),
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
        report: { notes: [], tells: [] },
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
        report: { notes: [], tells: [] },
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
