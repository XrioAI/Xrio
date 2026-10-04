import { describe, expect, it } from "vite-plus/test";

import { noPins } from "../testing/no-pins.ts";
import type { Observation } from "./contracts.ts";
import { httpIdentity, planIdentity } from "./humanizer.ts";
import type { IdentityReport } from "./report.ts";
import { evaluate } from "./verify.ts";

const linuxUserAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36";

const macUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

const linuxClientHints = {
  architecture: "x86",
  bitness: "64",
  brands: [{ brand: "Chromium", version: "154" }],
  fullVersionList: [{ brand: "Chromium", version: "154.0.8037.57" }],
  mobile: false,
  model: "",
  platform: "Linux",
  platformVersion: "6.8.0",
  wow64: false,
};

const headlessLinux: Observation = {
  afterCapture: {
    battery: true,
    clientHints: linuxClientHints,
    deviceMemory: 8,
    kind: "secure",
    webgpu: false,
  },
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
  product: { headless: true, major: 154, version: "154.0.8037.57" },
  reducedMotion: "no-preference",
  requestedOffsets: ["GMT+00:00", "GMT+00:00"],
  requestedZone: "UTC",
  screenHeight: 1080,
  screenWidth: 1920,
  userAgent: linuxUserAgent,
  webdriver: false,
  zone: "UTC",
  zoneOffsets: ["GMT+00:00", "GMT+00:00"],
};

const headedMac: Observation = {
  ...headlessLinux,
  afterCapture: { kind: "insecure" },
  availHeight: 1079,
  availWidth: 1728,
  colorScheme: "dark",
  devicePixelRatio: 2,
  outerHeight: 900,
  outerWidth: 1600,
  product: { headless: false, major: 154, version: "154.0.8037.57" },
  requestedOffsets: ["GMT-05:00", "GMT-04:00"],
  requestedZone: "America/Toronto",
  screenHeight: 1117,
  screenWidth: 1728,
  userAgent: macUserAgent,
  zone: "America/Toronto",
  zoneOffsets: ["GMT-05:00", "GMT-04:00"],
};

const secureCoverage = {
  automation: { state: "observed" },
  battery: { state: "observed" },
  clientHints: { state: "observed" },
  colorDepth: { state: "observed" },
  colorScheme: { state: "observed" },
  cores: { reason: "not-observed", state: "unchecked" },
  deviceMemory: { state: "observed" },
  devicePixelRatio: { state: "observed" },
  dns: { reason: "not-observed", state: "unchecked" },
  fonts: { reason: "not-observed", state: "unchecked" },
  languages: { state: "observed" },
  mediaDevices: { reason: "not-observed", state: "unchecked" },
  permissions: { reason: "not-observed", state: "unchecked" },
  platform: { reason: "not-observed", state: "unchecked" },
  pointer: { state: "observed" },
  reducedMotion: { state: "observed" },
  requestHeaders: { reason: "no-request-log", state: "unchecked" },
  screen: { state: "observed" },
  storageQuota: { reason: "not-observed", state: "unchecked" },
  timezone: { state: "observed" },
  userAgent: { state: "observed" },
  voices: { reason: "not-observed", state: "unchecked" },
  webglPixels: { reason: "lanes-only", state: "unchecked" },
  webglStrings: { reason: "not-observed", state: "unchecked" },
  webgpu: { state: "observed" },
  webrtc: { reason: "not-observed", state: "unchecked" },
  window: { state: "observed" },
  workArea: { state: "observed" },
};

const insecureCoverage = {
  ...secureCoverage,
  battery: { reason: "insecure-origin", state: "unchecked" },
  clientHints: { reason: "insecure-origin", state: "unchecked" },
  deviceMemory: { reason: "insecure-origin", state: "unchecked" },
  webgpu: { reason: "insecure-origin", state: "unchecked" },
};

describe("the identity report", () => {
  it("reports an http scrape's wreq profile, with request headers unchecked", () => {
    expect(httpIdentity(noPins).report).toStrictEqual({
      coverage: { requestHeaders: { reason: "no-request-log", state: "unchecked" } },
      locale: "en-US",
      mode: "http",
      profile: { chromeMajor: 149, platform: "linux" },
      tells: [],
    });
  });

  it.each(["fr-FR", "ja-JP"])("reports the locale %s an http scrape was pinned to", (locale) => {
    expect(httpIdentity({ locale, timezone: undefined }).report).toMatchObject({
      locale,
      mode: "http",
    });
  });

  it("reports a headless stock scrape on Linux", () => {
    const plan = planIdentity({
      capabilities: { platform: "linux" },
      exit: { facts: { kind: "unknown" }, route: "direct" },
      hostZone: "UTC",
      mode: "headless",
      pins: noPins,
    });

    expect(evaluate(plan, headlessLinux)).toStrictEqual({
      mismatches: [],
      report: {
        binary: { version: "154.0.8037.57" },
        coverage: secureCoverage,
        exit: { facts: { kind: "unknown" }, route: "direct" },
        mode: "headless",
        notes: [],
        observed: {
          anyPointer: "fine",
          battery: true,
          clientHints: linuxClientHints,
          colorScheme: "light",
          deviceMemory: 8,
          hover: "hover",
          intlLocale: "en-US",
          languages: ["en-US", "en"],
          maxTouchPoints: 0,
          offsets: ["GMT+00:00", "GMT+00:00"],
          pointer: "fine",
          reducedMotion: "no-preference",
          screen: {
            availHeight: 1040,
            availWidth: 1920,
            colorDepth: 24,
            devicePixelRatio: 1,
            height: 1080,
            width: 1920,
          },
          timeZone: "UTC",
          userAgent: linuxUserAgent,
          webdriver: false,
          webgpu: false,
          window: { outerHeight: 900, outerWidth: 1600 },
        },
        surfaces: {
          automation: null,
          gpu: { backend: "swiftshader", persona: null },
          leaks: { dnsOverHttps: "off", networkPrediction: "off" },
          locale: { languages: ["en-US", "en"], tag: "en-US" },
          media: { devices: { audioinput: 1, audiooutput: 1, videoinput: 0 }, source: "fake" },
          screen: {
            size: { height: 1080, width: 1920 },
            source: "fixed",
            workArea: { bottom: 40, left: 0, right: 0, top: 0 },
          },
          timezone: { source: "host", zone: "UTC" },
          window: { size: { height: 900, width: 1600 }, source: "fixed" },
        },
        tells: ["headless-token", "host-zone-utc"],
      },
    });
  });

  it("reports a headed stock scrape of a non-secure page on macOS, with no secure-context surface read", () => {
    const plan = planIdentity({
      capabilities: { platform: "darwin" },
      exit: { facts: { kind: "unknown" }, route: "direct" },
      hostZone: "America/Toronto",
      mode: "headed",
      pins: noPins,
    });

    expect(evaluate(plan, headedMac)).toStrictEqual({
      mismatches: [],
      report: {
        binary: { version: "154.0.8037.57" },
        coverage: insecureCoverage,
        exit: { facts: { kind: "unknown" }, route: "direct" },
        mode: "headed",
        notes: [],
        observed: {
          anyPointer: "fine",
          battery: null,
          clientHints: null,
          colorScheme: "dark",
          deviceMemory: null,
          hover: "hover",
          intlLocale: "en-US",
          languages: ["en-US", "en"],
          maxTouchPoints: 0,
          offsets: ["GMT-05:00", "GMT-04:00"],
          pointer: "fine",
          reducedMotion: "no-preference",
          screen: {
            availHeight: 1079,
            availWidth: 1728,
            colorDepth: 24,
            devicePixelRatio: 2,
            height: 1117,
            width: 1728,
          },
          timeZone: "America/Toronto",
          userAgent: macUserAgent,
          webdriver: false,
          webgpu: null,
          window: { outerHeight: 900, outerWidth: 1600 },
        },
        surfaces: {
          automation: null,
          gpu: { backend: "native" },
          leaks: { dnsOverHttps: "off", networkPrediction: "off" },
          locale: { languages: ["en-US", "en"], tag: "en-US" },
          media: { source: "host" },
          screen: { source: "host" },
          timezone: { source: "host", zone: "America/Toronto" },
          window: { size: { height: 900, width: 1600 }, source: "fixed" },
        },
        tells: [],
      },
    });
  });
});

describe("the secure-context surfaces' coverage", () => {
  const plan = planIdentity({
    capabilities: { platform: "linux" },
    exit: { facts: { kind: "unknown" }, route: "direct" },
    hostZone: "UTC",
    mode: "headless",
    pins: noPins,
  });

  it.each([
    { afterCapture: { kind: "failed" } as const, reason: "read-failed" },
    { afterCapture: { kind: "skipped" } as const, reason: "no-time" },
    { afterCapture: { kind: "not-navigated" } as const, reason: "not-observed" },
  ])(
    "is unchecked with $reason when the read gives $afterCapture.kind",
    ({ afterCapture, reason }) => {
      const { coverage, observed } = evaluate(plan, { ...headlessLinux, afterCapture }).report;

      expect({
        coverage: [coverage.battery, coverage.clientHints, coverage.deviceMemory, coverage.webgpu],
        observed: [observed.battery, observed.clientHints, observed.deviceMemory, observed.webgpu],
        platform: coverage.platform,
      }).toStrictEqual({
        coverage: Array.from({ length: 4 }, () => ({ reason, state: "unchecked" })),
        observed: [null, null, null, null],
        platform: { reason: "not-observed", state: "unchecked" },
      });
    },
  );
});

describe("a secure origin whose individual reads gave nothing", () => {
  it("marks only those surfaces unchecked with read-failed", () => {
    const plan = planIdentity({
      capabilities: { platform: "linux" },
      exit: { facts: { kind: "unknown" }, route: "direct" },
      hostZone: "UTC",
      mode: "headless",
      pins: noPins,
    });

    const { coverage } = evaluate(plan, {
      ...headlessLinux,
      afterCapture: {
        battery: true,
        clientHints: null,
        deviceMemory: null,
        kind: "secure",
        webgpu: false,
      },
    }).report;

    expect([
      coverage.battery,
      coverage.clientHints,
      coverage.deviceMemory,
      coverage.webgpu,
    ]).toStrictEqual([
      { state: "observed" },
      { reason: "read-failed", state: "unchecked" },
      { reason: "read-failed", state: "unchecked" },
      { state: "observed" },
    ]);
  });
});

describe("report independence", () => {
  const plan = planIdentity({
    capabilities: { platform: "linux" },
    exit: { facts: { kind: "unknown" }, route: "direct" },
    hostZone: "UTC",
    mode: "headless",
    pins: noPins,
  });

  it("keeps a caller's change to one report's coverage out of the next report", () => {
    const first = evaluate(plan, headlessLinux).report;

    Object.assign(first.coverage.timezone, { reason: "read-failed", state: "unchecked" });
    Object.assign(first.coverage.requestHeaders, { state: "observed" });

    const second = evaluate(plan, headlessLinux).report;

    expect({
      requestHeaders: second.coverage.requestHeaders,
      shared: first.coverage.screen === second.coverage.screen,
      sharedWithinReport: first.coverage.battery === first.coverage.webgpu,
      timezone: second.coverage.timezone,
    }).toStrictEqual({
      requestHeaders: { reason: "no-request-log", state: "unchecked" },
      shared: false,
      sharedWithinReport: false,
      timezone: { state: "observed" },
    });
  });

  it("keeps a caller's change to an http report's profile out of the next report", () => {
    const first = httpIdentity(noPins).report;

    Object.assign(first.profile, { chromeMajor: 1 });
    Object.assign(first.coverage.requestHeaders, { state: "observed" });

    expect(httpIdentity(noPins).report).toStrictEqual({
      coverage: { requestHeaders: { reason: "no-request-log", state: "unchecked" } },
      locale: "en-US",
      mode: "http",
      profile: { chromeMajor: 149, platform: "linux" },
      tells: [],
    });
  });
});

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

const aliasedPaths = (report: IdentityReport): string[][] => {
  const found = new Map<object, string[]>();
  const pending: [string, unknown][] = [["$", report]];

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [at, value] = next;

    if (isObject(value)) {
      const paths = [...(found.get(value) ?? []), at];

      found.set(value, paths);

      if (paths.length === 1) {
        for (const [key, child] of Object.entries(value)) {
          pending.push([`${at}.${key}`, child]);
        }
      }
    }
  }

  return [...found.values()].filter((paths) => paths.length > 1);
};

describe("no shared object inside one report", () => {
  const plan = planIdentity({
    capabilities: { platform: "linux" },
    exit: { facts: { kind: "unknown" }, route: "direct" },
    hostZone: "UTC",
    mode: "headless",
    pins: noPins,
  });

  it("holds for a headless report", () => {
    expect(aliasedPaths(evaluate(plan, headlessLinux).report)).toStrictEqual([]);
  });

  it("holds for a report whose languages mismatch became a note on an unmeasured Chrome", () => {
    const { report } = evaluate(plan, {
      ...headlessLinux,
      languages: ["en-GB"],
      product: { headless: true, major: 152, version: "152.0.0.0" },
    });

    expect({
      aliases: aliasedPaths(report),
      notes: report.notes.map(({ field, observed }) => ({ field, observed })),
    }).toStrictEqual({ aliases: [], notes: [{ field: "languages", observed: ["en-GB"] }] });
  });

  it("holds for an http report", () => {
    expect(aliasedPaths(httpIdentity(noPins).report)).toStrictEqual([]);
  });
});

describe("coverage backed by timezone reads", () => {
  const plan = planIdentity({
    capabilities: { platform: "linux" },
    exit: { facts: { kind: "unknown" }, route: "direct" },
    hostZone: "UTC",
    mode: "headless",
    pins: noPins,
  });

  it("leaves platform unchecked even when secure client hints name the platform", () => {
    expect(evaluate(plan, headlessLinux).report.coverage.platform).toStrictEqual({
      reason: "not-observed",
      state: "unchecked",
    });
  });

  it("reports timezone observed when the expected zone and its offsets were read", () => {
    expect(evaluate(plan, headlessLinux).report.coverage.timezone).toStrictEqual({
      state: "observed",
    });
  });

  it.each([
    { name: "Chrome did not name the expected timezone", read: { zone: null } },
    { name: "the expected zone's offsets could not be read", read: { requestedOffsets: null } },
  ])("reports a failed read when $name", ({ read }) => {
    expect(evaluate(plan, { ...headlessLinux, ...read }).report.coverage.timezone).toStrictEqual({
      reason: "read-failed",
      state: "unchecked",
    });
  });
});
