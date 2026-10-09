import { describe, expect, it } from "vite-plus/test";

import { fixedDevice, fixedSeed } from "../testing/fixed-seed.ts";
import { noPins } from "../testing/no-pins.ts";
import type {
  BatteryReading,
  HostCapabilities,
  Observation,
  WebGpuAdapterReading,
} from "./contracts.ts";
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
    batteryState: { charging: true, kind: "state", level: 1 },
    clientHints: linuxClientHints,
    deviceMemory: 8,
    kind: "secure",
    webgpu: false,
    webgpuAdapter: { kind: "none" },
  },
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
  product: { headless: true, major: 154, version: "154.0.8037.57" },
  reducedMotion: "no-preference",
  requestedOffsets: ["GMT+00:00", "GMT+00:00"],
  requestedZone: "UTC",
  screenHeight: 1050,
  screenWidth: 1680,
  screenX: 0,
  screenY: 32,
  userAgent: linuxUserAgent,
  webdriver: false,
  webgl: true,
  webglExtensions: ["WEBGL_compressed_texture_astc", "WEBGL_debug_renderer_info"],
  webglRenderer:
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
  webglVendor: "Google Inc. (Google)",
  zone: "UTC",
  zoneOffsets: ["GMT+00:00", "GMT+00:00"],
};

const headedMac: Observation = {
  ...headlessLinux,
  afterCapture: { kind: "insecure" },
  availHeight: 1079,
  availTop: 0,
  availWidth: 1728,
  colorScheme: "dark",
  devicePixelRatio: 2,
  fontsDigest: "0aa1b2c3",
  fontsSentinel: "9c0ffee1",
  fontsSentinelResolved: true,
  outerHeight: 900,
  outerWidth: 1600,
  product: { headless: false, major: 154, version: "154.0.8037.57" },
  requestedOffsets: ["GMT-05:00", "GMT-04:00"],
  requestedZone: "America/Toronto",
  screenHeight: 1117,
  screenWidth: 1728,
  screenX: 22,
  screenY: 22,
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
  cores: { state: "observed" },
  deviceMemory: { state: "observed" },
  devicePixelRatio: { state: "observed" },
  dns: { reason: "not-observed", state: "unchecked" },
  fonts: { state: "observed" },
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
  webglStrings: { state: "observed" },
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

interface RecordedBuild {
  readonly commit: string | null;
  readonly dirty: number | null;
  readonly buildUnreadable: boolean;
}

const NO_BUILD: RecordedBuild = { buildUnreadable: false, commit: null, dirty: null };

const forkAt = (version: string, build: RecordedBuild = NO_BUILD): HostCapabilities => ({
  fork: {
    ...build,
    dialect: "xrio",
    knobs: {},
    packageDir: "/opt/xrio-chrome",
    personas: { gl: [], refusedGl: [], speech: [] },
    version,
  },
  permittedCpus: 32,
  platform: "linux",
});

const reportForBuild = (build: RecordedBuild) =>
  evaluate(
    planIdentity({
      capabilities: forkAt("154.0.8037.57", build),
      device: fixedDevice,
      exit: { facts: { kind: "unknown" }, route: "direct" },
      hostZone: "UTC",
      mode: "headless",
      pins: noPins,
    }),
    headlessLinux,
  ).report;

describe("the identity report", () => {
  it("reports an http scrape's wreq profile, with request headers unchecked", () => {
    expect(httpIdentity(noPins).report(null)).toStrictEqual({
      coverage: {
        httpProfileSkew: { reason: "not-observed", state: "unchecked" },
        requestHeaders: { reason: "no-request-log", state: "unchecked" },
      },
      locale: "en-US",
      mode: "http",
      profile: { chromeMajor: 149, platform: "linux" },
      tells: [],
    });
  });

  it.each(["fr-FR", "ja-JP"])("reports the locale %s an http scrape was pinned to", (locale) => {
    expect(httpIdentity({ locale }).report(null)).toMatchObject({
      locale,
      mode: "http",
    });
  });

  it.each([
    { client: null, tells: [], version: "no browser" },
    {
      client: { permittedCpus: 32, platform: "linux" as const },
      tells: [],
      version: "a stock binary",
    },
    { client: forkAt("149.0.7800.10"), tells: [], version: "a fork on Chrome 149" },
    {
      client: forkAt("154.0.8037.57"),
      tells: ["http-profile-skew"],
      version: "a fork on Chrome 154",
    },
  ])(
    "tells http-profile-skew only when the client's binary is $version of another major",
    ({ client, tells }) => {
      expect(httpIdentity(noPins).report(client).tells).toStrictEqual(tells);
    },
  );

  it("reports a headless stock scrape on Linux", () => {
    const plan = planIdentity({
      capabilities: { permittedCpus: 32, platform: "linux" },
      device: fixedDevice,
      exit: { facts: { kind: "unknown" }, route: "direct" },
      hostZone: "UTC",
      mode: "headless",
      pins: noPins,
    });

    expect(evaluate(plan, headlessLinux)).toStrictEqual({
      fontEvidence: { digest: "c41f09a2", kind: "gathered", sentinel: "5e17a1b2" },
      mismatches: [],
      report: {
        binary: { commit: null, dirty: null, fork: null, version: "154.0.8037.57" },
        coverage: secureCoverage,
        digests: plan.chosen.digests,
        exit: { facts: { kind: "unknown" }, route: "direct" },
        mode: "headless",
        notes: [],
        observed: {
          anyPointer: "fine",
          battery: true,
          batteryState: { charging: true, level: 1 },
          clientHints: linuxClientHints,
          colorScheme: "light",
          deviceMemory: 8,
          fontsDigest: "c41f09a2",
          hardwareConcurrency: 32,
          hover: "hover",
          intlLocale: "en-US",
          languages: ["en-US", "en"],
          maxTouchPoints: 0,
          offsets: ["GMT+00:00", "GMT+00:00"],
          pointer: "fine",
          reducedMotion: "no-preference",
          screen: {
            availHeight: 1018,
            availLeft: 0,
            availTop: 32,
            availWidth: 1680,
            colorDepth: 24,
            devicePixelRatio: 1,
            height: 1050,
            width: 1680,
          },
          timeZone: "UTC",
          userAgent: linuxUserAgent,
          webdriver: false,
          webgl: {
            extensions: ["WEBGL_compressed_texture_astc", "WEBGL_debug_renderer_info"],
            renderer:
              "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
            vendor: "Google Inc. (Google)",
          },
          webgpu: false,
          webgpuAdapter: null,
          window: { outerHeight: 1018, outerWidth: 1680, screenX: 0, screenY: 32 },
        },
        record: plan.chosen.record,
        seed: fixedSeed,
        surfaces: {
          automation: null,
          fonts: { reason: "no fontstack/ beside the binary", source: "host" },
          gpu: { backend: "swiftshader", persona: null },
          hardware: { cores: 0, memoryGb: 0, source: "host" },
          leaks: { dnsOverHttps: "off", networkPrediction: "off", webrtc: "default" },
          locale: { languages: ["en-US", "en"], tag: "en-US" },
          media: { devices: { audioinput: 1, audiooutput: 1, videoinput: 0 }, source: "fake" },
          screen: {
            layout: "gnome",
            size: { height: 1050, width: 1680 },
            source: "drawn",
            workArea: { bottom: 0, left: 0, right: 0, top: 32 },
          },
          seed: { source: "fresh" },
          speech: { persona: null },
          timezone: { source: "host", zone: "UTC" },
          window: { height: 1018, kind: "maximized", source: "drawn", width: 1680, x: 0, y: 32 },
        },
        tells: [
          "headless-token",
          "host-zone-utc",
          "gl-persona-unavailable",
          "hardware-unhonored",
          "host-fonts",
        ],
      },
    });
  });

  it("names the fork in the binary, its speech persona in the record, and adds the surfaces' tells", () => {
    const plan = planIdentity({
      capabilities: {
        fork: {
          buildUnreadable: false,
          commit: null,
          dialect: "xrio",
          dirty: null,
          knobs: { "speech-persona": { origin: "set", value: "basharsx4-google-linux-154" } },
          packageDir: "/opt/xrio-chrome",
          personas: { gl: [], refusedGl: [], speech: [] },
          version: "154.0.8037.57",
        },
        permittedCpus: 32,
        platform: "linux",
      },
      device: fixedDevice,
      exit: { facts: { kind: "unknown" }, route: "direct" },
      hostZone: "UTC",
      mode: "headless",
      pins: noPins,
    });

    const { report } = evaluate(plan, headlessLinux);

    expect({
      binary: report.binary,
      speech: report.surfaces.speech,
      tells: report.tells,
      voices: report.record.device.voices,
    }).toStrictEqual({
      binary: { commit: null, dirty: null, fork: "xrio", version: "154.0.8037.57" },
      speech: { persona: "basharsx4-google-linux-154" },
      tells: [
        "headless-token",
        "host-zone-utc",
        "gl-persona-unavailable",
        "hardware-unhonored",
        "host-fonts",
        "speech-persona-skew",
      ],
      voices: { kind: "persona", name: "basharsx4-google-linux-154" },
    });
  });

  describe("the fork's recorded build", () => {
    const COMMIT = "0123456789abcdef0123456789abcdef01234567";

    const DEVICE_DIGEST = "86b5a7953a4dbd0eb5cd26213f154086232b261e0cb35988f33c308e3668c366";

    it("reports binary.commit and binary.dirty from VERSIONS", () => {
      const { binary, tells } = reportForBuild({
        buildUnreadable: false,
        commit: COMMIT,
        dirty: 3,
      });

      expect({ binary, tells }).toStrictEqual({
        binary: { commit: COMMIT, dirty: 3, fork: "xrio", version: "154.0.8037.57" },
        tells: [
          "headless-token",
          "host-zone-utc",
          "gl-persona-unavailable",
          "hardware-unhonored",
          "host-fonts",
        ],
      });
    });

    it("reports null for both and no tell when VERSIONS records no build", () => {
      const { binary, tells } = reportForBuild({
        buildUnreadable: false,
        commit: null,
        dirty: null,
      });

      expect({ binary, tells }).toStrictEqual({
        binary: { commit: null, dirty: null, fork: "xrio", version: "154.0.8037.57" },
        tells: [
          "headless-token",
          "host-zone-utc",
          "gl-persona-unavailable",
          "hardware-unhonored",
          "host-fonts",
        ],
      });
    });

    it("tells fork-commit-unreadable when a recorded line was malformed", () => {
      const { binary, tells } = reportForBuild({ buildUnreadable: true, commit: null, dirty: 0 });

      expect({ binary, tells }).toStrictEqual({
        binary: { commit: null, dirty: 0, fork: "xrio", version: "154.0.8037.57" },
        tells: [
          "headless-token",
          "host-zone-utc",
          "gl-persona-unavailable",
          "hardware-unhonored",
          "host-fonts",
          "fork-commit-unreadable",
        ],
      });
    });

    it("gives two builds of one package different host digests and the same device digest", () => {
      const digests = [
        reportForBuild({ buildUnreadable: false, commit: null, dirty: null }),
        reportForBuild({ buildUnreadable: false, commit: COMMIT, dirty: 0 }),
        reportForBuild({ buildUnreadable: false, commit: COMMIT, dirty: 1 }),
      ].map((report) => report.digests);

      expect(digests.map(({ host }) => host)).toStrictEqual([
        "14cfc7acb3f102161c434eea597611d734fca18b42eb25499f188cf695206fde",
        "d2aeaffdbf3c81bef36910e6bd08d1847610a49b9d41f46943f7aefb08fa577b",
        "82fddf92f789f08551828ac56c1ed19a816f23580c1a50ec7c6b080a029d42d4",
      ]);
      expect(digests.map(({ device }) => device)).toStrictEqual([
        DEVICE_DIGEST,
        DEVICE_DIGEST,
        DEVICE_DIGEST,
      ]);
    });
  });

  it("reports a headed stock scrape of a non-secure page on macOS, with no secure-context surface read", () => {
    const plan = planIdentity({
      capabilities: { permittedCpus: 32, platform: "darwin" },
      device: fixedDevice,
      exit: { facts: { kind: "unknown" }, route: "direct" },
      hostZone: "America/Toronto",
      mode: "headed",
      pins: noPins,
    });

    expect(evaluate(plan, headedMac)).toStrictEqual({
      fontEvidence: { digest: "0aa1b2c3", kind: "gathered", sentinel: "9c0ffee1" },
      mismatches: [],
      report: {
        binary: { commit: null, dirty: null, fork: null, version: "154.0.8037.57" },
        coverage: insecureCoverage,
        digests: {
          device: "454908c5cc83747918fba77f92b5fcf8e1aa234e0290b0619e2accd6a9eeb0a3",
          host: plan.chosen.digests.host,
        },
        exit: { facts: { kind: "unknown" }, route: "direct" },
        mode: "headed",
        notes: [],
        observed: {
          anyPointer: "fine",
          battery: null,
          batteryState: null,
          clientHints: null,
          colorScheme: "dark",
          deviceMemory: null,
          fontsDigest: "0aa1b2c3",
          hardwareConcurrency: 32,
          hover: "hover",
          intlLocale: "en-US",
          languages: ["en-US", "en"],
          maxTouchPoints: 0,
          offsets: ["GMT-05:00", "GMT-04:00"],
          pointer: "fine",
          reducedMotion: "no-preference",
          screen: {
            availHeight: 1079,
            availLeft: 0,
            availTop: 0,
            availWidth: 1728,
            colorDepth: 24,
            devicePixelRatio: 2,
            height: 1117,
            width: 1728,
          },
          timeZone: "America/Toronto",
          userAgent: macUserAgent,
          webdriver: false,
          webgl: {
            extensions: ["WEBGL_compressed_texture_astc", "WEBGL_debug_renderer_info"],
            renderer:
              "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
            vendor: "Google Inc. (Google)",
          },
          webgpu: null,
          webgpuAdapter: null,
          window: { outerHeight: 900, outerWidth: 1600, screenX: 22, screenY: 22 },
        },
        record: {
          device: {
            cores: 0,
            fonts: { kind: "system" },
            gpu: { backend: "native", persona: null },
            memoryGb: 0,
            screen: {
              height: 1117,
              width: 1728,
              workArea: { bottom: 38, left: 0, right: 0, top: 0 },
            },
            voices: { kind: "system" },
            window: { kind: "chrome-default" },
          },
          policy: { locale: "en-US", timezone: { kind: "host", zone: "America/Toronto" } },
          schema: 1,
          seed: fixedSeed,
        },
        seed: fixedSeed,
        surfaces: {
          automation: null,
          fonts: { reason: null, source: "host" },
          gpu: { backend: "native", persona: null },
          hardware: { cores: 0, memoryGb: 0, source: "host" },
          leaks: { dnsOverHttps: "off", networkPrediction: "off", webrtc: "default" },
          locale: { languages: ["en-US", "en"], tag: "en-US" },
          media: { source: "host" },
          screen: { source: "host" },
          seed: { source: "fresh" },
          speech: { persona: null },
          timezone: { source: "host", zone: "America/Toronto" },
          window: { size: { height: 900, width: 1600 }, source: "fixed" },
        },
        tells: ["gl-persona-unavailable", "hardware-unhonored", "flag-infobar"],
      },
    });
  });
});

describe("the secure-context surfaces' coverage", () => {
  const plan = planIdentity({
    capabilities: { permittedCpus: 32, platform: "linux" },
    device: fixedDevice,
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

const secureWith = (webgpuAdapter: WebGpuAdapterReading): Observation["afterCapture"] => ({
  battery: true,
  batteryState: { charging: true, kind: "state", level: 1 },
  clientHints: linuxClientHints,
  deviceMemory: 8,
  kind: "secure",
  webgpu: true,
  webgpuAdapter,
});

describe("the WebGPU adapter's report", () => {
  const plan = planIdentity({
    capabilities: { permittedCpus: 32, platform: "linux" },
    device: fixedDevice,
    exit: { facts: { kind: "unknown" }, route: "direct" },
    hostZone: "UTC",
    mode: "headless",
    pins: noPins,
  });

  it.each([
    { adapter: { kind: "none" } as const, observed: null },
    {
      adapter: { architecture: "swiftshader", kind: "adapter", vendor: "google" } as const,
      observed: { architecture: "swiftshader", vendor: "google" },
    },
  ])("is observed for a $adapter.kind reading", ({ adapter, observed }) => {
    const { report } = evaluate(plan, { ...headlessLinux, afterCapture: secureWith(adapter) });

    expect({
      battery: report.coverage.battery,
      clientHints: report.coverage.clientHints,
      deviceMemory: report.coverage.deviceMemory,
      webgpu: report.coverage.webgpu,
      webgpuAdapter: report.observed.webgpuAdapter,
    }).toStrictEqual({
      battery: { state: "observed" },
      clientHints: { state: "observed" },
      deviceMemory: { state: "observed" },
      webgpu: { state: "observed" },
      webgpuAdapter: observed,
    });
  });

  it.each([
    { adapter: { kind: "timed-out" } as const, reason: "no-time" },
    { adapter: { kind: "failed" } as const, reason: "read-failed" },
  ])(
    "is unchecked with $reason for a $adapter.kind reading, and costs nothing else",
    ({ adapter, reason }) => {
      const { report } = evaluate(plan, { ...headlessLinux, afterCapture: secureWith(adapter) });

      expect({
        battery: report.coverage.battery,
        clientHints: report.coverage.clientHints,
        deviceMemory: report.coverage.deviceMemory,
        observed: [report.observed.deviceMemory, report.observed.battery],
        webgpu: report.coverage.webgpu,
        webgpuAdapter: report.observed.webgpuAdapter,
      }).toStrictEqual({
        battery: { state: "observed" },
        clientHints: { state: "observed" },
        deviceMemory: { state: "observed" },
        observed: [8, true],
        webgpu: { reason, state: "unchecked" },
        webgpuAdapter: null,
      });
    },
  );

  it("reports no adapter for a page that was not a secure context", () => {
    const { coverage, observed } = evaluate(plan, {
      ...headlessLinux,
      afterCapture: { kind: "insecure" },
    }).report;

    expect({ coverage: coverage.webgpu, observed: observed.webgpuAdapter }).toStrictEqual({
      coverage: { reason: "insecure-origin", state: "unchecked" },
      observed: null,
    });
  });
});

const secureWithBattery = (batteryState: BatteryReading): Observation["afterCapture"] => ({
  battery: true,
  batteryState,
  clientHints: linuxClientHints,
  deviceMemory: 8,
  kind: "secure",
  webgpu: false,
  webgpuAdapter: { kind: "none" },
});

describe("the battery state's report", () => {
  const plan = planIdentity({
    capabilities: { permittedCpus: 32, platform: "linux" },
    device: fixedDevice,
    exit: { facts: { kind: "unknown" }, route: "direct" },
    hostZone: "UTC",
    mode: "headless",
    pins: noPins,
  });

  it.each([
    {
      battery: { charging: false, kind: "state", level: 0.5 } as const,
      observed: { charging: false, level: 0.5 },
    },
    { battery: { kind: "none" } as const, observed: null },
  ])("is observed for a $battery.kind reading", ({ battery, observed }) => {
    const { report } = evaluate(plan, {
      ...headlessLinux,
      afterCapture: secureWithBattery(battery),
    });

    expect({
      coverage: report.coverage.battery,
      observed: report.observed.batteryState,
    }).toStrictEqual({ coverage: { state: "observed" }, observed });
  });

  it.each([
    { battery: { kind: "timed-out" } as const, reason: "no-time" },
    { battery: { kind: "failed" } as const, reason: "read-failed" },
  ])(
    "is unchecked with $reason for a $battery.kind reading, and costs nothing else",
    ({ battery, reason }) => {
      const { report } = evaluate(plan, {
        ...headlessLinux,
        afterCapture: secureWithBattery(battery),
      });

      expect({
        battery: report.coverage.battery,
        clientHints: report.coverage.clientHints,
        observed: [report.observed.battery, report.observed.batteryState],
        webgpu: report.coverage.webgpu,
      }).toStrictEqual({
        battery: { reason, state: "unchecked" },
        clientHints: { state: "observed" },
        observed: [true, null],
        webgpu: { state: "observed" },
      });
    },
  );

  it("reports no state for a page that was not a secure context", () => {
    const { coverage, observed } = evaluate(plan, {
      ...headlessLinux,
      afterCapture: { kind: "insecure" },
    }).report;

    expect({ coverage: coverage.battery, observed: observed.batteryState }).toStrictEqual({
      coverage: { reason: "insecure-origin", state: "unchecked" },
      observed: null,
    });
  });
});

describe("the WebGL strings' coverage", () => {
  const plan = planIdentity({
    capabilities: { permittedCpus: 32, platform: "linux" },
    device: fixedDevice,
    exit: { facts: { kind: "unknown" }, route: "direct" },
    hostZone: "UTC",
    mode: "headless",
    pins: noPins,
  });

  it("reports them observed on a page whose scrape never navigated", () => {
    const { coverage, observed } = evaluate(plan, {
      ...headlessLinux,
      afterCapture: { kind: "not-navigated" },
    }).report;

    expect({ coverage: coverage.webglStrings, vendor: observed.webgl.vendor }).toStrictEqual({
      coverage: { state: "observed" },
      vendor: "Google Inc. (Google)",
    });
  });

  it("reports a null vendor, renderer and extension list for a page with no context", () => {
    const { observed } = evaluate(plan, {
      ...headlessLinux,
      webgl: false,
      webglExtensions: null,
      webglRenderer: null,
      webglVendor: null,
    }).report;

    expect(observed.webgl).toStrictEqual({ extensions: null, renderer: null, vendor: null });
  });
});

describe("a secure origin whose individual reads gave nothing", () => {
  it("marks only those surfaces unchecked with read-failed", () => {
    const plan = planIdentity({
      capabilities: { permittedCpus: 32, platform: "linux" },
      device: fixedDevice,
      exit: { facts: { kind: "unknown" }, route: "direct" },
      hostZone: "UTC",
      mode: "headless",
      pins: noPins,
    });

    const { coverage } = evaluate(plan, {
      ...headlessLinux,
      afterCapture: {
        battery: true,
        batteryState: { charging: true, kind: "state", level: 1 },
        clientHints: null,
        deviceMemory: null,
        kind: "secure",
        webgpu: false,
        webgpuAdapter: { kind: "none" },
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
    capabilities: { permittedCpus: 32, platform: "linux" },
    device: fixedDevice,
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
    const first = httpIdentity(noPins).report(null);

    Object.assign(first.profile, { chromeMajor: 1 });
    Object.assign(first.coverage.requestHeaders, { state: "observed" });

    expect(httpIdentity(noPins).report(null)).toStrictEqual({
      coverage: {
        httpProfileSkew: { reason: "not-observed", state: "unchecked" },
        requestHeaders: { reason: "no-request-log", state: "unchecked" },
      },
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
    capabilities: { permittedCpus: 32, platform: "linux" },
    device: fixedDevice,
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
    expect(aliasedPaths(httpIdentity(noPins).report(null))).toStrictEqual([]);
  });
});

describe("coverage backed by timezone reads", () => {
  const plan = planIdentity({
    capabilities: { permittedCpus: 32, platform: "linux" },
    device: fixedDevice,
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
