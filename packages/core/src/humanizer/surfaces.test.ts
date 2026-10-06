import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { fixedDevice, fixedSeed } from "../testing/fixed-seed.ts";
import {
  forkWithGl,
  gpuHost,
  HIDE_ONLY,
  RENOIR,
  RENOIR_RENDERER,
  SWIFTSHADER_RENDERER,
  swiftShaderHost,
} from "../testing/gl-fork.ts";
import { forkWithKnobs, HARDWARE_KNOBS } from "../testing/hardware-fork.ts";
import { noPins } from "../testing/no-pins.ts";
import type {
  DeviceRecord,
  FontStack,
  GpuChoice,
  HostCapabilities,
  KnobOrigin,
  KnobRegistry,
  NameRow,
} from "./contracts.ts";
import { fontConfigOf } from "./fonts.ts";
import { planIdentity } from "./humanizer.ts";
import type { IdentityIntent } from "./intent.ts";
import { chromeAcceptLanguages } from "./owned-inputs.ts";
import { EMISSION_ORDER, recordOverrides, resolveSurfaces } from "./surfaces.ts";
import type { IdentityContext, SurfaceChoices } from "./surfaces.ts";

const contextOf = (overrides: Partial<IdentityContext> = {}): IdentityContext => ({
  capabilities: { permittedCpus: 32, platform: "linux" },
  device: fixedDevice,
  exit: { facts: { kind: "unknown" }, route: "direct" },
  hostZone: "America/Chicago",
  mode: "headless",
  pins: noPins,
  ...overrides,
});

const pinnedTo = (locale: string): Partial<IdentityContext> => ({
  pins: { display: undefined, hardware: undefined, locale, timezone: undefined },
});

const expectedLocale = (
  tag: string,
  languages: readonly string[],
  intlSeverity: "fatal" | "note",
) => [
  {
    compatibility: true,
    field: "languages",
    matcher: { kind: "equals", value: languages },
    severity: "fatal",
  },
  {
    compatibility: true,
    field: "intlLocale",
    matcher: { kind: "same-language", locale: tag },
    severity: intlSeverity,
  },
];

const LINUX_SPEECH = "basharsx4-google-linux-154";

const forkWith = (
  speechPersona: string | null,
  artifactVersions: readonly string[] = [],
): HostCapabilities => ({
  fork: {
    buildUnreadable: false,
    commit: null,
    dialect: "xrio",
    dirty: null,
    knobs: {
      "speech-persona": { origin: speechPersona === null ? "def" : "set", value: speechPersona },
      "suppress-headless-token": { origin: "def", value: "true" },
    },
    packageDir: "/opt/xrio-chrome",
    personas: {
      gl: [],
      refusedGl: [],
      speech: artifactVersions.map((chromeVersion) => ({
        chromeVersion,
        digest: `sha256:${"0".repeat(64)}`,
        name: LINUX_SPEECH,
        schema: "xrio-speech-table/v1",
      })),
    },
    version: "154.0.8037.57",
  },
  permittedCpus: 32,
  platform: "linux",
});

const PAYLOAD = "62bbc5617946311ab21ed9ec8ef22f68a15e4ccf06cebf01aca807fedb1def3d";

const STACK: FontStack = {
  cacheDir: "/tmp/xrio-501/fontcache-0123456789abcdef",
  directory: "/opt/xrio-chrome/fontstack",
  families: 175,
  payload: PAYLOAD,
  rules: ["10-antialias.conf", "50-user.conf", "51-local.conf", "60-latin.conf"],
};

const withStack = (platform: NodeJS.Platform = "linux"): HostCapabilities => ({
  fontStack: { ...STACK, kind: "checked" },
  permittedCpus: 32,
  platform,
});

describe("the locale surface", () => {
  it.each([
    {
      languages: ["en-US", "en"],
      list: "en-US,en",
      posix: "en_US",
      tag: "en-US",
    },
    {
      languages: ["de-DE", "de", "en-US", "en"],
      list: "de-DE,de,en-US,en",
      posix: "de_DE",
      tag: "de-DE",
    },
    {
      languages: ["pt-BR", "pt", "en-US", "en"],
      list: "pt-BR,pt,en-US,en",
      posix: "pt_BR",
      tag: "pt-BR",
    },
    {
      languages: ["en-AU", "en-US", "en"],
      list: "en-AU,en-US,en",
      posix: "en_AU",
      tag: "en-AU",
    },
  ])("presents $tag with Chrome's list", (locale) => {
    const { languages, list, posix, tag } = locale;

    expect(resolveSurfaces(contextOf(pinnedTo(tag))).locale).toStrictEqual({
      expected: expectedLocale(tag, languages, "fatal"),
      inputs: [
        { name: "--accept-lang", sink: "switch", value: list },
        { name: "LANG", sink: "environment", value: "C.UTF-8" },
        { name: "LANGUAGE", sink: "environment", value: posix },
        { name: "intl.accept_languages", sink: "preference", value: list },
      ],
      value: { languages, tag },
    });
  });

  it("presents en-US when no locale is pinned", () => {
    expect(resolveSurfaces(contextOf()).locale).toStrictEqual(
      resolveSurfaces(contextOf(pinnedTo("en-US"))).locale,
    );
  });

  it("keeps the bare language Chrome leads with for ja-JP", () => {
    const { inputs, value } = resolveSurfaces(contextOf(pinnedTo("ja-JP"))).locale;

    expect(inputs).toContainEqual({
      name: "intl.accept_languages",
      sink: "preference",
      value: "ja,en-US,en",
    });
    expect(value).toStrictEqual({ languages: ["ja", "en-US", "en"], tag: "ja-JP" });
  });

  it("never emits --lang, which Chrome ignores", () => {
    const { inputs } = resolveSurfaces(contextOf(pinnedTo("de-DE"))).locale;

    expect(inputs.map(({ name }) => name)).not.toContain("--lang");
  });

  it("only notes an Intl language off the plan on macOS, where Intl follows the host", () => {
    expect(
      resolveSurfaces(
        contextOf({
          ...pinnedTo("de-DE"),
          capabilities: { permittedCpus: 32, platform: "darwin" },
        }),
      ).locale.expected,
    ).toStrictEqual(expectedLocale("de-DE", ["de-DE", "de", "en-US", "en"], "note"));
  });

  it("refuses a tag whose Chrome list is unmeasured, which the options never let through", () => {
    expect(() => resolveSurfaces(contextOf(pinnedTo("sw-KE")))).toThrow(
      "Xrio has not measured Chrome's language list for sw-KE.",
    );
  });

  it("shares no array with the table it reads", () => {
    const { value } = resolveSurfaces(contextOf(pinnedTo("de-DE"))).locale;

    expect(value.languages).not.toBe(chromeAcceptLanguages("de-DE"));
  });
});

const zoneExpectations = [
  {
    compatibility: false,
    field: "zone",
    matcher: { kind: "named-zone" },
    severity: "fatal",
  },
  {
    compatibility: false,
    field: "zoneOffsets",
    matcher: { kind: "zone-offsets" },
    severity: "fatal",
  },
];

const proxyRoute = { facts: { kind: "unknown" }, route: "proxy" } as const;

const observedGermanExit = {
  facts: {
    address: "203.0.113.7",
    country: "DE",
    destination: "example.com",
    generation: 0,
    kind: "observed",
    observedAt: 1_760_000_000_000,
    provider: "fixture",
    route: "7f3a",
    zone: "Europe/Berlin",
  },
  route: "proxy",
} as const satisfies IdentityContext["exit"];

describe("the timezone surface", () => {
  it("sets TZ to the host zone, always explicitly", () => {
    expect(resolveSurfaces(contextOf({ hostZone: "America/Chicago" })).timezone).toStrictEqual({
      expected: zoneExpectations,
      inputs: [{ name: "TZ", sink: "environment", value: "America/Chicago" }],
      tells: [],
      value: { source: "host", zone: "America/Chicago" },
    });
  });

  it("tells a direct scrape that presents UTC from the host", () => {
    expect(resolveSurfaces(contextOf({ hostZone: "UTC" })).timezone).toMatchObject({
      inputs: [{ name: "TZ", sink: "environment", value: "UTC" }],
      tells: ["host-zone-utc"],
      value: { source: "host", zone: "UTC" },
    });
  });

  it("tells a proxied scrape with unknown exit facts that the host zone stands in for the exit's", () => {
    expect(
      resolveSurfaces(contextOf({ exit: proxyRoute, hostZone: "America/Chicago" })).timezone,
    ).toMatchObject({
      inputs: [{ name: "TZ", sink: "environment", value: "America/Chicago" }],
      tells: ["exit-unknown"],
    });
  });

  it("tells a proxied UTC host about its unknown exit only", () => {
    expect(
      resolveSurfaces(contextOf({ exit: proxyRoute, hostZone: "UTC" })).timezone.tells,
    ).toStrictEqual(["exit-unknown"]);
  });

  it("sets TZ to a pinned zone, whatever the host's zone is", () => {
    expect(
      resolveSurfaces(
        contextOf({
          hostZone: "America/Chicago",
          pins: { ...noPins, timezone: "America/New_York" },
        }),
      ).timezone,
    ).toStrictEqual({
      expected: zoneExpectations,
      inputs: [{ name: "TZ", sink: "environment", value: "America/New_York" }],
      tells: [],
      value: { source: "pin", zone: "America/New_York" },
    });
  });

  it.each([
    ["europe/berlin", "Europe/Berlin"],
    ["Europe/Kyiv", "Europe/Kiev"],
    ["asia/kolkata", "Asia/Calcutta"],
    ["Etc/UTC", "UTC"],
  ])("sets TZ to the spelling Chrome uses for a pin of %s, which is %s", (pin, zone) => {
    expect(
      resolveSurfaces(contextOf({ pins: { ...noPins, timezone: pin } })).timezone,
    ).toMatchObject({
      inputs: [{ name: "TZ", sink: "environment", value: zone }],
      value: { source: "pin", zone },
    });
  });

  it.each(["Mars/Olympus", "+05:30", ""])(
    "falls back to the host zone when a pin of %j names no zone",
    (pin) => {
      expect(
        resolveSurfaces(
          contextOf({ hostZone: "America/Chicago", pins: { ...noPins, timezone: pin } }),
        ).timezone,
      ).toMatchObject({
        inputs: [{ name: "TZ", sink: "environment", value: "America/Chicago" }],
        value: { source: "host", zone: "America/Chicago" },
      });
    },
  );

  it("tells nothing about a pinned UTC, because the caller chose it", () => {
    expect(
      resolveSurfaces(contextOf({ hostZone: "UTC", pins: { ...noPins, timezone: "UTC" } }))
        .timezone,
    ).toMatchObject({ tells: [], value: { source: "pin", zone: "UTC" } });
  });

  it("prefers a pin to observed exit facts, with or without an exit policy", () => {
    const pinned = { exit: observedGermanExit, pins: { ...noPins, timezone: "America/New_York" } };

    expect(
      [false, true].map(
        (followExit) => resolveSurfaces(contextOf({ ...pinned, followExit })).timezone,
      ),
    ).toMatchObject([
      {
        inputs: [{ name: "TZ", sink: "environment", value: "America/New_York" }],
        tells: [],
        value: { source: "pin", zone: "America/New_York" },
      },
      {
        inputs: [{ name: "TZ", sink: "environment", value: "America/New_York" }],
        tells: [],
        value: { source: "pin", zone: "America/New_York" },
      },
    ]);
  });

  it("sets TZ to an observed exit's zone under an exit policy", () => {
    expect(
      resolveSurfaces(
        contextOf({ exit: observedGermanExit, followExit: true, hostZone: "America/Chicago" }),
      ).timezone,
    ).toStrictEqual({
      expected: zoneExpectations,
      inputs: [{ name: "TZ", sink: "environment", value: "Europe/Berlin" }],
      tells: [],
      value: { source: "exit", zone: "Europe/Berlin" },
    });
  });

  it("sets TZ to the spelling Chrome uses for an exit's zone", () => {
    const kyivExit = {
      ...observedGermanExit,
      facts: { ...observedGermanExit.facts, zone: "Europe/Kyiv" },
    };

    expect(resolveSurfaces(contextOf({ exit: kyivExit, followExit: true })).timezone).toMatchObject(
      {
        inputs: [{ name: "TZ", sink: "environment", value: "Europe/Kiev" }],
        value: { source: "exit", zone: "Europe/Kiev" },
      },
    );
  });

  it.each(["Mars/Olympus", "+02:00", ""])(
    "falls back to the host zone when an exit's zone %j names no zone",
    (zone) => {
      const badExit = { ...observedGermanExit, facts: { ...observedGermanExit.facts, zone } };

      expect(
        resolveSurfaces(contextOf({ exit: badExit, followExit: true, hostZone: "America/Chicago" }))
          .timezone,
      ).toMatchObject({
        inputs: [{ name: "TZ", sink: "environment", value: "America/Chicago" }],
        value: { source: "host", zone: "America/Chicago" },
      });
    },
  );

  it("falls back to the host zone, with its tell, when an exit policy has no exit facts", () => {
    expect(
      resolveSurfaces(contextOf({ exit: proxyRoute, followExit: true, hostZone: "UTC" })).timezone,
    ).toMatchObject({
      inputs: [{ name: "TZ", sink: "environment", value: "UTC" }],
      tells: ["exit-unknown"],
      value: { source: "host", zone: "UTC" },
    });
  });

  it("keeps the host zone beside observed exit facts, with no tell", () => {
    expect(
      resolveSurfaces(contextOf({ exit: observedGermanExit, hostZone: "America/Chicago" }))
        .timezone,
    ).toMatchObject({
      inputs: [{ name: "TZ", sink: "environment", value: "America/Chicago" }],
      tells: [],
      value: { source: "host", zone: "America/Chicago" },
    });
  });
});

const webglContext = {
  compatibility: true,
  field: "webgl",
  matcher: { kind: "equals", value: true },
  severity: "fatal",
};

describe("the gpu surface", () => {
  it("selects SwiftShader through its unsafe switch on Linux", () => {
    expect(resolveSurfaces(contextOf()).gpu).toStrictEqual({
      expected: [webglContext],
      inputs: [{ name: "--enable-unsafe-swiftshader", sink: "switch" }],
      tells: ["gl-persona-unavailable"],
      value: { backend: "swiftshader", persona: null },
    });
  });

  it("selects ANGLE on Vulkan on Linux when a render node is readable", () => {
    expect(
      resolveSurfaces(
        contextOf({
          capabilities: { permittedCpus: 32, platform: "linux", readableRenderNode: true },
        }),
      ).gpu,
    ).toStrictEqual({
      expected: [webglContext],
      inputs: [
        { name: "--use-gl", sink: "switch", value: "angle" },
        { name: "--use-angle", sink: "switch", value: "vulkan" },
      ],
      tells: ["gl-persona-unavailable"],
      value: { backend: "native", persona: null },
    });
  });

  it.each(["darwin", "win32"] as const)("leaves the system's backend alone on %s", (platform) => {
    expect(
      resolveSurfaces(contextOf({ capabilities: { permittedCpus: 32, platform } })).gpu,
    ).toStrictEqual({
      expected: [webglContext],
      inputs: [],
      tells: ["gl-persona-unavailable"],
      value: { backend: "native", persona: null },
    });
  });
});

const gpuOf = (capabilities: HostCapabilities) => resolveSurfaces(contextOf({ capabilities })).gpu;

const SWIFTSHADER_SWITCH = { name: "--enable-unsafe-swiftshader", sink: "switch" } as const;

const NATIVE_SWITCHES = [
  { name: "--use-gl", sink: "switch", value: "angle" },
  { name: "--use-angle", sink: "switch", value: "vulkan" },
] as const;

const OTHER_CHROME = "153.0.7871.2";

const recordPresenting = (capabilities: HostCapabilities, gpu: GpuChoice): DeviceRecord => {
  const { record } = planIdentity(contextOf({ capabilities })).chosen;

  if (record === null) {
    throw new Error("A headless plan records its device.");
  }

  return { ...record, device: { ...record.device, gpu } };
};

describe("a GL persona under the matched policy", () => {
  it("never draws a hide-only persona over SwiftShader", () => {
    expect(gpuOf(swiftShaderHost(forkWithGl([HIDE_ONLY])))).toStrictEqual({
      expected: [webglContext],
      inputs: [SWIFTSHADER_SWITCH],
      tells: ["gl-persona-unavailable"],
      value: { backend: "swiftshader", persona: null },
    });
  });

  it("presents the hide-only persona a replayed record holds, and expects its renderer without its hidden extensions", () => {
    const capabilities = swiftShaderHost(forkWithGl([HIDE_ONLY]));

    const record = recordPresenting(capabilities, {
      backend: "swiftshader",
      persona: { kind: "hide-only", name: "basharsx4-swiftshader-hidden" },
    });

    expect(
      resolveSurfaces(contextOf({ capabilities, device: { kind: "record", record } })).gpu,
    ).toStrictEqual({
      expected: [
        webglContext,
        {
          compatibility: false,
          field: "webglRenderer",
          matcher: { kind: "equals", value: SWIFTSHADER_RENDERER },
          severity: "fatal",
        },
        {
          compatibility: false,
          field: "webglExtensions",
          matcher: {
            kind: "excludes-all",
            values: [
              "WEBGL_compressed_texture_astc",
              "WEBGL_compressed_texture_etc",
              "WEBGL_compressed_texture_etc1",
            ],
          },
          severity: "fatal",
        },
      ],
      inputs: [
        SWIFTSHADER_SWITCH,
        { name: "--xrio-gl-persona", sink: "switch", value: "basharsx4-swiftshader-hidden" },
      ],
      tells: [],
      value: {
        backend: "swiftshader",
        persona: { kind: "hide-only", name: "basharsx4-swiftshader-hidden" },
      },
    });
  });

  it("never presents a hardware persona over SwiftShader", () => {
    expect(gpuOf(swiftShaderHost(forkWithGl([RENOIR])))).toStrictEqual({
      expected: [webglContext],
      inputs: [SWIFTSHADER_SWITCH],
      tells: ["gl-persona-unavailable"],
      value: { backend: "swiftshader", persona: null },
    });
  });

  it.each([
    { host: RENOIR_RENDERER, name: "the artifact's own string" },
    {
      host: "ANGLE (AMD, Vulkan 1.3.255 (AMD Radeon Graphics (RADV RENOIR) (0x0000164C)), radv-23.2.1)",
      name: "the driver version GPUInfo appends",
    },
  ])("presents a hardware persona on a native GPU whose renderer is $name", ({ host }) => {
    expect(gpuOf(gpuHost(forkWithGl([HIDE_ONLY, RENOIR]), host))).toStrictEqual({
      expected: [
        webglContext,
        {
          compatibility: false,
          field: "webglRenderer",
          matcher: { kind: "equals", value: RENOIR_RENDERER },
          severity: "fatal",
        },
        {
          compatibility: false,
          field: "webglExtensions",
          matcher: {
            kind: "excludes-all",
            values: [
              "WEBGL_clip_cull_distance",
              "WEBGL_compressed_texture_astc",
              "WEBGL_compressed_texture_etc",
              "WEBGL_compressed_texture_etc1",
            ],
          },
          severity: "fatal",
        },
      ],
      inputs: [
        ...NATIVE_SWITCHES,
        { name: "--xrio-gl-persona", sink: "switch", value: "basharsx4-amd-renoir" },
      ],
      tells: [],
      value: { backend: "native", persona: { kind: "hardware", name: "basharsx4-amd-renoir" } },
    });
  });

  it.each([
    {
      host: "ANGLE (AMD, Vulkan 1.3.255 (AMD Radeon Graphics (RADV RENOIR) (0x0000164D)), radv)",
      name: "another device id",
    },
    {
      host: "ANGLE (AMD, Vulkan 1.3.260 (AMD Radeon Graphics (RADV RENOIR) (0x0000164C)), radv)",
      name: "another Vulkan version",
    },
    {
      host: "ANGLE (AMD, Vulkan 1.3.255 (AMD Radeon Graphics (RADV RENOIR) (0x0000164C)), amdvlk)",
      name: "another driver",
    },
    { host: undefined, name: "a renderer Xrio could not learn" },
  ])("presents no persona on a native GPU with $name", ({ host }) => {
    expect(gpuOf(gpuHost(forkWithGl([HIDE_ONLY, RENOIR]), host))).toStrictEqual({
      expected: [webglContext],
      inputs: [...NATIVE_SWITCHES],
      tells: ["gl-persona-unavailable"],
      value: { backend: "native", persona: null },
    });
  });

  it("never presents a persona whose max_threads is below the 4 cores of the smallest machine class", () => {
    expect(
      gpuOf(gpuHost(forkWithGl([{ ...RENOIR, maxThreads: 2 }]), RENOIR_RENDERER)),
    ).toStrictEqual({
      expected: [webglContext],
      inputs: [...NATIVE_SWITCHES],
      tells: ["gl-persona-unavailable"],
      value: { backend: "native", persona: null },
    });
  });

  it.each([
    {
      maxThreads: 3,
      name: "refuses a persona of 3 max_threads, one below the 4 cores of the smallest machine class",
      persona: null,
    },
    {
      maxThreads: 4,
      name: "presents a persona of 4 max_threads, the 4 cores of the smallest machine class",
      persona: { kind: "hardware", name: "basharsx4-amd-renoir" },
    },
  ])("$name", ({ maxThreads, persona }) => {
    expect(
      gpuOf(gpuHost(forkWithGl([{ ...RENOIR, maxThreads }]), RENOIR_RENDERER)).value,
    ).toStrictEqual({ backend: "native", persona });
  });

  it("never presents a hide-only persona on a native GPU", () => {
    expect(gpuOf(gpuHost(forkWithGl([HIDE_ONLY]), SWIFTSHADER_RENDERER)).value).toStrictEqual({
      backend: "native",
      persona: null,
    });
  });

  it("skips an artifact captured on another Chrome version and tells gl-persona-skew", () => {
    expect(
      gpuOf(swiftShaderHost(forkWithGl([{ ...HIDE_ONLY, chromeVersion: OTHER_CHROME }]))),
    ).toStrictEqual({
      expected: [webglContext],
      inputs: [SWIFTSHADER_SWITCH],
      tells: ["gl-persona-skew", "gl-persona-unavailable"],
      value: { backend: "swiftshader", persona: null },
    });
  });

  it("presents an eligible persona beside a skewed one, and still tells gl-persona-skew", () => {
    const skewed = { ...RENOIR, chromeVersion: OTHER_CHROME, name: "basharsx4-amd-renoir-153" };
    const { tells, value } = gpuOf(gpuHost(forkWithGl([skewed, RENOIR]), RENOIR_RENDERER));

    expect({ tells, value }).toStrictEqual({
      tells: ["gl-persona-skew"],
      value: { backend: "native", persona: { kind: "hardware", name: "basharsx4-amd-renoir" } },
    });
  });

  it("checks the backend before the version, so a hardware artifact over SwiftShader is no skew", () => {
    expect(
      gpuOf(swiftShaderHost(forkWithGl([{ ...RENOIR, chromeVersion: OTHER_CHROME }]))).tells,
    ).toStrictEqual(["gl-persona-unavailable"]);
  });

  it("tells gl-persona-skew when the probe refused an artifact", () => {
    const refusedGl = [{ reason: 'is named "x", not its file stem broken', stem: "broken" }];
    const { tells, value } = gpuOf(gpuHost(forkWithGl([RENOIR], { refusedGl }), RENOIR_RENDERER));

    expect({ tells, value }).toStrictEqual({
      tells: ["gl-persona-skew"],
      value: { backend: "native", persona: { kind: "hardware", name: "basharsx4-amd-renoir" } },
    });
  });

  it("tells gl-persona-unavailable on stock Chrome and on a fork with no GL persona", () => {
    expect([
      gpuOf({ permittedCpus: 32, platform: "linux" }).tells,
      gpuOf(swiftShaderHost(forkWithGl([]))).tells,
    ]).toStrictEqual([["gl-persona-unavailable"], ["gl-persona-unavailable"]]);
  });

  it.each([
    {
      cores: [4, 6, 8, 12, 16],
      gl: [RENOIR],
      host: gpuHost,
      name: "a 16-thread persona on 32 CPUs never draws the 24-core class and tells nothing",
      permittedCpus: 32,
      tells: [],
    },
    {
      cores: [4, 6, 8],
      gl: [{ ...RENOIR, maxThreads: 8 }],
      host: gpuHost,
      name: "an 8-thread persona on 32 CPUs draws at most 8 cores and tells nothing",
      permittedCpus: 32,
      tells: [],
    },
    {
      cores: [4, 6, 8, 12],
      gl: [RENOIR],
      host: gpuHost,
      name: "a 16-thread persona on 12 CPUs tells hardware-capped",
      permittedCpus: 12,
      tells: ["hardware-capped"],
    },
    {
      cores: [4, 6, 8, 12, 16, 24],
      gl: [],
      host: gpuHost,
      name: "no persona on 32 CPUs draws every class and tells nothing",
      permittedCpus: 32,
      tells: [],
    },
    {
      cores: [4, 6, 8, 12, 16, 24],
      gl: [{ ...HIDE_ONLY, maxThreads: 8 }],
      host: swiftShaderHost,
      name: "a hide-only persona over SwiftShader is never drawn, so it sets no ceiling",
      permittedCpus: 32,
      tells: [],
    },
    {
      cores: [0],
      gl: [RENOIR],
      host: gpuHost,
      name: "a 16-thread persona on 3 CPUs keeps the host's values and tells hardware-capped",
      permittedCpus: 3,
      tells: ["hardware-capped"],
    },
    {
      cores: [0],
      gl: [],
      host: gpuHost,
      name: "no persona on 3 CPUs keeps the host's values and tells hardware-capped",
      permittedCpus: 3,
      tells: ["hardware-capped"],
    },
  ])("$name", ({ cores, gl, host, permittedCpus, tells }) => {
    const capabilities = { ...host(forkWithGl(gl), RENOIR_RENDERER), permittedCpus };

    const drawn = Array.from({ length: 1000 }, (_, index) =>
      resolveSurfaces(
        contextOf({
          capabilities,
          device: { kind: "fresh", seed: (index + 1).toString(16).padStart(16, "0") },
        }),
      ),
    ).map(({ hardware }) => hardware);

    expect({
      cores: [...new Set(drawn.map(({ value }) => value.cores))].toSorted(
        (left, right) => left - right,
      ),
      tells: [...new Set(drawn.flatMap(({ tells: drawnTells = [] }) => drawnTells))],
    }).toStrictEqual({ cores, tells });
  });
});

describe("the GL persona switch", () => {
  it.each([
    {
      capabilities: swiftShaderHost(forkWithGl([HIDE_ONLY])),
      name: "a hide-only persona over SwiftShader, which is never drawn",
      switches: [],
    },
    {
      capabilities: gpuHost(forkWithGl([RENOIR]), RENOIR_RENDERER),
      name: "a hardware persona on its own GPU",
      switches: ["--xrio-gl-persona=basharsx4-amd-renoir"],
    },
    {
      capabilities: swiftShaderHost(forkWithGl([RENOIR])),
      name: "no eligible persona",
      switches: [],
    },
    {
      capabilities: { permittedCpus: 32, platform: "linux" } as const,
      name: "stock",
      switches: [],
    },
  ])(
    "is sent exactly when a persona is presented, here for $name",
    ({ capabilities, switches }) => {
      expect(
        planIdentity(contextOf({ capabilities })).inputs.switches.filter((entry) =>
          entry.startsWith("--xrio-gl-persona="),
        ),
      ).toStrictEqual(switches);
    },
  );
});

const KIT_ROW = /^\[(?<origin>set|def|umb|der)\] (?<key>\S+) = (?<value>.*)$/u;

const KNOB_ORIGINS: readonly KnobOrigin[] = ["set", "def", "umb", "der"];

const kitRow = (line: string): [string, KnobRegistry[string]][] => {
  const { key, origin, value } = KIT_ROW.exec(line)?.groups ?? {};
  const known = KNOB_ORIGINS.find((candidate) => candidate === origin);

  return key === undefined || known === undefined || value === undefined
    ? []
    : [[key, { origin: known, value }]];
};

const KIT_KNOBS: KnobRegistry = Object.fromEntries(
  readFileSync(new URL("../sources/browser/fixtures/kit-dump.txt", import.meta.url), "utf-8")
    .split("\n")
    .flatMap(kitRow),
);

const FORK_GL_KNOBS: KnobRegistry = {
  ...KIT_KNOBS,
  "gl-persona": { origin: "set", value: "basharsx4-amd-renoir" },
  "gl-renderer": { origin: "set", value: RENOIR_RENDERER },
  "gl-vendor": { origin: "set", value: "Google Inc. (AMD)" },
  "media-persona": { origin: "set", value: "basharsx4-amd-renoir" },
};

const forkSwitchNames = (capabilities: HostCapabilities): string[] =>
  planIdentity(contextOf({ capabilities }))
    .inputs.switches.filter((entry) => entry.startsWith("--xrio-"))
    .map((entry) => entry.split("=")[0] ?? entry);

const HARDWARE_SWITCHES = ["--xrio-hardware-concurrency", "--xrio-device-memory"];

describe("the fork's own GL and media knobs", () => {
  it.each([
    { knobs: {}, name: "an empty registry", switches: ["--xrio-gl-persona"] },
    {
      knobs: HARDWARE_KNOBS,
      name: "the hardware knobs",
      switches: ["--xrio-gl-persona", ...HARDWARE_SWITCHES],
    },
    {
      knobs: KIT_KNOBS,
      name: "the full kit dump",
      switches: ["--xrio-gl-persona", ...HARDWARE_SWITCHES],
    },
    {
      knobs: FORK_GL_KNOBS,
      name: "the kit dump with gl-vendor, gl-renderer and media-persona set",
      switches: ["--xrio-gl-persona", ...HARDWARE_SWITCHES],
    },
  ])("are never sent, whatever $name lists", ({ knobs, switches }) => {
    expect(
      forkSwitchNames(gpuHost(forkWithGl([RENOIR], { knobs }), RENOIR_RENDERER)),
    ).toStrictEqual(switches);
  });
});

const SECOND_HIDE_ONLY = { ...HIDE_ONLY, name: "basharsx4-swiftshader-second" };

describe("a replayed record's GL persona", () => {
  const capabilities = swiftShaderHost(forkWithGl([HIDE_ONLY, SECOND_HIDE_ONLY]));

  it.each(["basharsx4-swiftshader-hidden", "basharsx4-swiftshader-second"])(
    "presents the record's %s where this host can, with no skew",
    (name) => {
      const gpu = { backend: "swiftshader", persona: { kind: "hide-only", name } } as const;
      const record = recordPresenting(capabilities, gpu);
      const plan = planIdentity(contextOf({ capabilities, device: { kind: "record", record } }));

      expect({ presented: plan.chosen.surfaces.gpu, tells: plan.tells }).toStrictEqual({
        presented: gpu,
        tells: ["host-fonts"],
      });
    },
  );

  it("draws this host's persona with the record's seed when the record's is missing, keeping the record's and telling replay-host-skew", () => {
    const gone = {
      backend: "native",
      persona: { kind: "hardware", name: "basharsx4-amd-gone" },
    } as const;

    const host = gpuHost(forkWithGl([RENOIR]), RENOIR_RENDERER);
    const record = recordPresenting(host, gone);

    const plan = planIdentity(
      contextOf({ capabilities: host, device: { kind: "record", record } }),
    );

    expect({
      presented: plan.chosen.surfaces.gpu,
      recorded: plan.chosen.record?.device.gpu,
      tells: plan.tells,
    }).toStrictEqual({
      presented: { backend: "native", persona: { kind: "hardware", name: "basharsx4-amd-renoir" } },
      recorded: gone,
      tells: ["host-fonts", "replay-host-skew"],
    });
  });
});

const pinningGpu = (gpu: readonly NameRow[]): IdentityIntent => ({
  ...noPins,
  hardware: { gpu },
});

const pinnedGpuOf = (capabilities: HostCapabilities, gpu: readonly NameRow[], seed = fixedSeed) =>
  planIdentity(contextOf({ capabilities, device: { kind: "fresh", seed }, pins: pinningGpu(gpu) }))
    .chosen.surfaces.gpu;

const notEligible = (message: string) => ({ code: "INVALID_OPTIONS", message, name: "TypeError" });

const HIDDEN_GPU = {
  backend: "swiftshader",
  persona: { kind: "hide-only", name: "basharsx4-swiftshader-hidden" },
} as const;

const scrapePinning = (gpu: readonly NameRow[]) =>
  ({ mode: "headless", pins: pinningGpu(gpu) }) as const;

describe("a GL persona the caller pins", () => {
  const capabilities = swiftShaderHost(forkWithGl([HIDE_ONLY, SECOND_HIDE_ONLY, RENOIR]));

  it("presents the one eligible persona it names", () => {
    expect(
      pinnedGpuOf(capabilities, [{ name: "basharsx4-swiftshader-hidden", weight: 1 }]),
    ).toStrictEqual({
      backend: "swiftshader",
      persona: { kind: "hide-only", name: "basharsx4-swiftshader-hidden" },
    });
  });

  it("presents a hide-only persona only when pinned, expecting its renderer without its hidden extensions", () => {
    const host = swiftShaderHost(forkWithGl([HIDE_ONLY]));

    const pinned = resolveSurfaces(
      contextOf({
        capabilities: host,
        pins: pinningGpu([{ name: "basharsx4-swiftshader-hidden", weight: 1 }]),
      }),
    ).gpu;

    expect({ pinned, unpinned: gpuOf(host).value }).toStrictEqual({
      pinned: {
        expected: [
          webglContext,
          {
            compatibility: false,
            field: "webglRenderer",
            matcher: { kind: "equals", value: SWIFTSHADER_RENDERER },
            severity: "fatal",
          },
          {
            compatibility: false,
            field: "webglExtensions",
            matcher: {
              kind: "excludes-all",
              values: [
                "WEBGL_compressed_texture_astc",
                "WEBGL_compressed_texture_etc",
                "WEBGL_compressed_texture_etc1",
              ],
            },
            severity: "fatal",
          },
        ],
        inputs: [
          SWIFTSHADER_SWITCH,
          { name: "--xrio-gl-persona", sink: "switch", value: "basharsx4-swiftshader-hidden" },
        ],
        tells: [],
        value: HIDDEN_GPU,
      },
      unpinned: { backend: "swiftshader", persona: null },
    });
  });

  it.each([
    { name: "basharsx4-swiftshader-second", seed: fixedSeed },
    { name: "basharsx4-swiftshader-hidden", seed: "0000000000000001" },
  ])("draws $name from a weighted table for the seed $seed", ({ name, seed }) => {
    expect(
      pinnedGpuOf(
        capabilities,
        [
          { name: "basharsx4-swiftshader-hidden", weight: 1 },
          { name: "basharsx4-swiftshader-second", weight: 3 },
        ],
        seed,
      ),
    ).toStrictEqual({ backend: "swiftshader", persona: { kind: "hide-only", name } });
  });

  it.each([
    {
      capabilities,
      name: "basharsx4-amd-renoir",
      reason:
        "it is a hardware persona, and the matched policy presents one only on a GPU whose own renderer equals it, never over SwiftShader",
    },
    {
      capabilities: gpuHost(forkWithGl([HIDE_ONLY, RENOIR]), RENOIR_RENDERER),
      name: "basharsx4-swiftshader-hidden",
      reason: "it claims SwiftShader, and this launch renders on the host GPU",
    },
    {
      capabilities: gpuHost(forkWithGl([RENOIR])),
      name: "basharsx4-amd-renoir",
      reason: "this host's own renderer is unknown",
    },
    {
      capabilities: swiftShaderHost(forkWithGl([{ ...HIDE_ONLY, chromeVersion: OTHER_CHROME }])),
      name: "basharsx4-swiftshader-hidden",
      reason: "it was captured on Chrome 153.0.7871.2, and this browser is Chrome 154.0.8037.57",
    },
    {
      capabilities: swiftShaderHost(
        forkWithGl([HIDE_ONLY], {
          refusedGl: [{ reason: "lacks a sha256 digest", stem: "basharsx4-swiftshader-old" }],
        }),
      ),
      name: "basharsx4-swiftshader-old",
      reason: "its artifact lacks a sha256 digest",
    },
    {
      capabilities: swiftShaderHost(forkWithGl([{ ...HIDE_ONLY, maxThreads: 2 }])),
      name: "basharsx4-swiftshader-hidden",
      reason: "its max_threads of 2 is below 4, the fewest cores of any machine class Xrio draws",
    },
    {
      capabilities,
      name: "basharsx4-intel-uhd",
      reason: "this browser's package has no GL persona named basharsx4-intel-uhd",
    },
    {
      capabilities: { permittedCpus: 32, platform: "linux" } as const,
      name: "basharsx4-swiftshader-hidden",
      reason: "this browser is not an Xrio fork package, so it has no GL personas",
    },
  ])(
    "refuses a pin of $name with INVALID_OPTIONS and the reason",
    ({ capabilities: host, name, reason }) => {
      expect(() => pinnedGpuOf(host, [{ name, weight: 1 }])).toThrow(
        expect.objectContaining(
          notEligible(`hardware.gpu ${name} is not eligible under the matched policy: ${reason}.`),
        ),
      );
    },
  );

  it("caps the drawn hardware at a pinned hide-only persona's max_threads over SwiftShader", () => {
    const host = swiftShaderHost(forkWithGl([{ ...HIDE_ONLY, maxThreads: 8 }]));

    const coresDrawn = (pins: IdentityIntent) => {
      const cores = Array.from(
        { length: 200 },
        (_, index) =>
          planIdentity(
            contextOf({
              capabilities: host,
              device: { kind: "fresh", seed: (index + 1).toString(16).padStart(16, "0") },
              pins,
            }),
          ).chosen.surfaces.hardware.cores,
      );

      return [...new Set(cores)].toSorted((left, right) => left - right);
    };

    expect({
      pinned: coresDrawn(pinningGpu([{ name: "basharsx4-swiftshader-hidden", weight: 1 }])),
      unpinned: coresDrawn(noPins),
    }).toStrictEqual({ pinned: [4, 6, 8], unpinned: [4, 6, 8, 12, 16, 24] });
  });

  it("refuses a table that lists one ineligible persona among eligible ones", () => {
    expect(() =>
      pinnedGpuOf(capabilities, [
        { name: "basharsx4-swiftshader-hidden", weight: 1 },
        { name: "basharsx4-amd-renoir", weight: 1 },
      ]),
    ).toThrow(
      expect.objectContaining(
        notEligible(
          "hardware.gpu basharsx4-amd-renoir is not eligible under the matched policy: it is a hardware persona, and the matched policy presents one only on a GPU whose own renderer equals it, never over SwiftShader.",
        ),
      ),
    );
  });

  it("counts a pin that leaves out the record's persona as a hardware override", () => {
    const hidden = recordPresenting(capabilities, HIDDEN_GPU);
    const none = recordPresenting(capabilities, { backend: "swiftshader", persona: null });

    expect([
      recordOverrides(hidden, scrapePinning([{ name: "basharsx4-swiftshader-hidden", weight: 1 }])),
      recordOverrides(hidden, scrapePinning([{ name: "basharsx4-swiftshader-second", weight: 1 }])),
      recordOverrides(none, scrapePinning([{ name: "basharsx4-swiftshader-hidden", weight: 1 }])),
      recordOverrides(hidden, { mode: "headless", pins: noPins }),
    ]).toStrictEqual([[], ["hardware"], ["hardware"], []]);
  });
});

const announcing: IdentityIntent = { ...noPins, hardware: { gpuPolicy: "announce" } };

const announcedGpuOf = (capabilities: HostCapabilities, seed = fixedSeed) =>
  resolveSurfaces(contextOf({ capabilities, device: { kind: "fresh", seed }, pins: announcing }))
    .gpu;

const ANNOUNCED_RENOIR = {
  backend: "swiftshader",
  persona: { kind: "hardware", name: "basharsx4-amd-renoir" },
  policy: "announce",
} as const;

const SECOND_HARDWARE = { ...RENOIR, name: "basharsx4-amd-second" };

const THIRD_HARDWARE = { ...RENOIR, name: "basharsx4-amd-third" };

describe("a GL persona under the announce policy", () => {
  it("presents a hardware persona over SwiftShader and expects its renderer", () => {
    expect(announcedGpuOf(swiftShaderHost(forkWithGl([HIDE_ONLY, RENOIR])))).toStrictEqual({
      claims: { laptop: true, vendor: "AMD" },
      expected: [
        webglContext,
        {
          compatibility: false,
          field: "webglRenderer",
          matcher: { kind: "equals", value: RENOIR_RENDERER },
          severity: "fatal",
        },
        {
          compatibility: false,
          field: "webglExtensions",
          matcher: { kind: "excludes-all", values: RENOIR.hiddenExtensions },
          severity: "fatal",
        },
      ],
      inputs: [
        SWIFTSHADER_SWITCH,
        { name: "--xrio-gl-persona", sink: "switch", value: "basharsx4-amd-renoir" },
      ],
      tells: ["gpu-announced-over-software", "gpu-fleet-constant"],
      value: ANNOUNCED_RENOIR,
    });
  });

  it.each([
    "0000000000000001",
    "0000000000000002",
    "0000000000000003",
    "0000000000000004",
    fixedSeed,
  ])("prefers the hardware persona to a hide-only one for the seed %s", (seed) => {
    expect(
      announcedGpuOf(swiftShaderHost(forkWithGl([HIDE_ONLY, SECOND_HIDE_ONLY, RENOIR])), seed)
        .value,
    ).toStrictEqual(ANNOUNCED_RENOIR);
  });

  it("presents no persona, and never a hide-only one, when no hardware persona is eligible", () => {
    const skewed = { ...RENOIR, chromeVersion: OTHER_CHROME };

    expect(announcedGpuOf(swiftShaderHost(forkWithGl([HIDE_ONLY, skewed])))).toMatchObject({
      tells: ["gl-persona-skew", "gl-persona-unavailable"],
      value: { backend: "swiftshader", persona: null },
    });
  });

  it.each(["matched", "announce"] as const)(
    "presents the host's own GPU on a native GPU that matches under %s, with no announce tell",
    (gpuPolicy) => {
      const capabilities = gpuHost(forkWithGl([HIDE_ONLY, RENOIR]), RENOIR_RENDERER);

      expect(
        resolveSurfaces(contextOf({ capabilities, pins: { ...noPins, hardware: { gpuPolicy } } }))
          .gpu,
      ).toStrictEqual({
        expected: [
          webglContext,
          {
            compatibility: false,
            field: "webglRenderer",
            matcher: { kind: "equals", value: RENOIR_RENDERER },
            severity: "fatal",
          },
          {
            compatibility: false,
            field: "webglExtensions",
            matcher: { kind: "excludes-all", values: RENOIR.hiddenExtensions },
            severity: "fatal",
          },
        ],
        inputs: [
          ...NATIVE_SWITCHES,
          { name: "--xrio-gl-persona", sink: "switch", value: "basharsx4-amd-renoir" },
        ],
        tells: [],
        value: { backend: "native", persona: { kind: "hardware", name: "basharsx4-amd-renoir" } },
      });
    },
  );

  it("gives the same plan under both policies on a native GPU", () => {
    const capabilities = gpuHost(forkWithGl([HIDE_ONLY, RENOIR]), RENOIR_RENDERER);

    const planned = (gpuPolicy: "matched" | "announce") =>
      planIdentity(contextOf({ capabilities, pins: { ...noPins, hardware: { gpuPolicy } } }));

    expect(planned("announce")).toStrictEqual(planned("matched"));
  });

  it("presents nothing on a native GPU whose renderer differs, as the matched policy does", () => {
    expect(announcedGpuOf(gpuHost(forkWithGl([HIDE_ONLY, RENOIR])))).toMatchObject({
      tells: ["gl-persona-unavailable"],
      value: { backend: "native", persona: null },
    });
  });

  it("presents nothing on stock Chrome and tells only gl-persona-unavailable", () => {
    expect(announcedGpuOf({ permittedCpus: 32, platform: "linux" })).toMatchObject({
      tells: ["gl-persona-unavailable"],
      value: { backend: "swiftshader", persona: null },
    });
  });

  it.each([
    { count: 1, fleet: ["gpu-fleet-constant"], hardware: [RENOIR] },
    { count: 2, fleet: ["gpu-fleet-constant"], hardware: [RENOIR, SECOND_HARDWARE] },
    { count: 3, fleet: [], hardware: [RENOIR, SECOND_HARDWARE, THIRD_HARDWARE] },
  ])(
    "tells gpu-fleet-constant only while fewer than three hardware personas are eligible ($count here)",
    ({ fleet, hardware }) => {
      expect(
        announcedGpuOf(swiftShaderHost(forkWithGl([HIDE_ONLY, ...hardware]))).tells,
      ).toStrictEqual(["gpu-announced-over-software", ...fleet]);
    },
  );

  it("does not count a skewed hardware persona toward the fleet", () => {
    const skewed = { ...THIRD_HARDWARE, chromeVersion: OTHER_CHROME };
    const forked = forkWithGl([RENOIR, SECOND_HARDWARE, skewed]);

    expect(announcedGpuOf(swiftShaderHost(forked)).tells).toStrictEqual([
      "gl-persona-skew",
      "gpu-announced-over-software",
      "gpu-fleet-constant",
    ]);
  });

  it("changes nothing for the matched policy, named or not", () => {
    const capabilities = swiftShaderHost(forkWithGl([HIDE_ONLY, RENOIR]));

    const named = resolveSurfaces(
      contextOf({ capabilities, pins: { ...noPins, hardware: { gpuPolicy: "matched" } } }),
    ).gpu;

    expect(named).toStrictEqual(gpuOf(capabilities));
    expect(named.value).toStrictEqual({ backend: "swiftshader", persona: null });
  });

  it("lets a pin name a hardware persona over SwiftShader, and a hide-only one beside it", () => {
    const capabilities = swiftShaderHost(forkWithGl([HIDE_ONLY, RENOIR]));

    const pinned = (name: string) =>
      resolveSurfaces(
        contextOf({
          capabilities,
          pins: { ...noPins, hardware: { gpu: [{ name, weight: 1 }], gpuPolicy: "announce" } },
        }),
      ).gpu.value;

    expect([pinned("basharsx4-amd-renoir"), pinned("basharsx4-swiftshader-hidden")]).toStrictEqual([
      ANNOUNCED_RENOIR,
      HIDDEN_GPU,
    ]);
  });

  it.each(["announce", "matched"] as const)(
    "names the %s policy in force when stock Chrome refuses a pin",
    (gpuPolicy) => {
      expect(() =>
        resolveSurfaces(
          contextOf({
            capabilities: { permittedCpus: 32, platform: "linux" },
            pins: {
              ...noPins,
              hardware: { gpu: [{ name: "basharsx4-amd-renoir", weight: 1 }], gpuPolicy },
            },
          }),
        ),
      ).toThrow(
        expect.objectContaining(
          notEligible(
            `hardware.gpu basharsx4-amd-renoir is not eligible under the ${gpuPolicy} policy: this browser is not an Xrio fork package, so it has no GL personas.`,
          ),
        ),
      );
    },
  );

  it("names the announce policy when a pin is refused", () => {
    expect(() =>
      resolveSurfaces(
        contextOf({
          capabilities: swiftShaderHost(forkWithGl([HIDE_ONLY, RENOIR])),
          pins: {
            ...noPins,
            hardware: { gpu: [{ name: "basharsx4-intel-uhd", weight: 1 }], gpuPolicy: "announce" },
          },
        }),
      ),
    ).toThrow(
      expect.objectContaining(
        notEligible(
          "hardware.gpu basharsx4-intel-uhd is not eligible under the announce policy: this browser's package has no GL persona named basharsx4-intel-uhd.",
        ),
      ),
    );
  });

  it("records the announcement in the device record", () => {
    const capabilities = swiftShaderHost(forkWithGl([HIDE_ONLY, RENOIR]));
    const { chosen } = planIdentity(contextOf({ capabilities, pins: announcing }));

    expect(chosen.record?.device.gpu).toStrictEqual(ANNOUNCED_RENOIR);
  });
});

describe("the battery's launch inputs", () => {
  it.each([
    swiftShaderHost(forkWithGl([HIDE_ONLY, RENOIR])),
    gpuHost(forkWithGl([HIDE_ONLY, RENOIR]), RENOIR_RENDERER),
  ])("sends no battery-status switch or knob under either policy", (capabilities) => {
    const names = (gpuPolicy: "matched" | "announce") => {
      const resolutions = resolveSurfaces(
        contextOf({ capabilities, pins: { ...noPins, hardware: { gpuPolicy } } }),
      );

      return EMISSION_ORDER.flatMap((surface) =>
        resolutions[surface].inputs.map(({ name }) => name),
      );
    };

    expect(
      [names("matched"), names("announce")].flat().filter((name) => /battery/iu.test(name)),
    ).toStrictEqual([]);
  });
});

const claimsOf = (capabilities: HostCapabilities, pins: IdentityIntent = announcing) =>
  planIdentity(contextOf({ capabilities, pins })).claims;

describe("the persona claims an announce plan hands to the after-capture read", () => {
  it("names the persona's GPU vendor and form factor under announce", () => {
    expect(claimsOf(swiftShaderHost(forkWithGl([HIDE_ONLY, RENOIR])))).toStrictEqual({
      laptop: true,
      vendor: "AMD",
    });
  });

  it("reports a desktop persona as no laptop", () => {
    const desktop = { ...RENOIR, formFactor: "desktop" } as const;

    expect(claimsOf(swiftShaderHost(forkWithGl([desktop])))).toStrictEqual({
      laptop: false,
      vendor: "AMD",
    });
  });

  it.each([
    { brand: "NVIDIA Corporation", vendor: "Google Inc. (NVIDIA Corporation)" },
    { brand: "ATI Technologies", vendor: "Google Inc. (ATI Technologies)" },
    { brand: "Intel Inc.", vendor: "Intel Inc." },
    { brand: "Google Inc.", vendor: " Google Inc. " },
    { brand: undefined, vendor: "" },
    { brand: undefined, vendor: "  " },
  ])("reads the vendor brand of $vendor as $brand", ({ brand, vendor }) => {
    expect(claimsOf(swiftShaderHost(forkWithGl([{ ...RENOIR, vendor }])))).toStrictEqual({
      laptop: true,
      vendor: brand,
    });
  });

  it("claims nothing under matched, when no hardware persona is eligible, or on stock Chrome", () => {
    const skewed = { ...RENOIR, chromeVersion: OTHER_CHROME };

    expect([
      claimsOf(swiftShaderHost(forkWithGl([HIDE_ONLY, RENOIR])), noPins),
      claimsOf(swiftShaderHost(forkWithGl([HIDE_ONLY, skewed]))),
      claimsOf({ permittedCpus: 32, platform: "linux" }),
    ]).toStrictEqual([null, null, null]);
  });

  it.each(["matched", "announce"] as const)(
    "claims nothing on a native GPU under %s, where the host's own GPU is presented",
    (gpuPolicy) => {
      const capabilities = gpuHost(forkWithGl([HIDE_ONLY, RENOIR]), RENOIR_RENDERER);

      expect(claimsOf(capabilities, { ...noPins, hardware: { gpuPolicy } })).toBeNull();
    },
  );

  it("claims the persona of a replayed announce record", () => {
    const record = recordPresenting(
      swiftShaderHost(forkWithGl([HIDE_ONLY, RENOIR])),
      ANNOUNCED_RENOIR,
    );

    const plan = planIdentity(
      contextOf({
        capabilities: swiftShaderHost(forkWithGl([HIDE_ONLY, RENOIR])),
        device: { kind: "record", record },
      }),
    );

    expect(plan.claims).toStrictEqual({ laptop: true, vendor: "AMD" });
  });
});

describe("a replayed announce record", () => {
  const forked = forkWithGl([HIDE_ONLY, RENOIR]);

  const replayed = (capabilities: HostCapabilities, pins: IdentityIntent = noPins) => {
    const record = recordPresenting(swiftShaderHost(forked), ANNOUNCED_RENOIR);

    return planIdentity(contextOf({ capabilities, device: { kind: "record", record }, pins }));
  };

  it("presents its persona under a matched client and tells it was announced, as the announce policy that drew it would", () => {
    const plan = replayed(swiftShaderHost(forked));

    expect({ presented: plan.chosen.surfaces.gpu, tells: plan.tells }).toStrictEqual({
      presented: ANNOUNCED_RENOIR,
      tells: ["gpu-announced-over-software", "gpu-fleet-constant", "host-fonts"],
    });
  });

  it("presents the same persona with the same tells under an announce client", () => {
    const plan = replayed(swiftShaderHost(forked), announcing);

    expect({ presented: plan.chosen.surfaces.gpu, tells: plan.tells }).toStrictEqual({
      presented: ANNOUNCED_RENOIR,
      tells: ["gpu-announced-over-software", "gpu-fleet-constant", "host-fonts"],
    });
  });

  it("counts the hardware personas of the announce lineup that replays it, under a matched client", () => {
    const three = swiftShaderHost(forkWithGl([HIDE_ONLY, RENOIR, SECOND_HARDWARE, THIRD_HARDWARE]));
    const record = recordPresenting(three, ANNOUNCED_RENOIR);

    const plan = planIdentity(
      contextOf({ capabilities: three, device: { kind: "record", record } }),
    );

    expect({ presented: plan.chosen.surfaces.gpu, tells: plan.tells }).toStrictEqual({
      presented: ANNOUNCED_RENOIR,
      tells: ["gpu-announced-over-software", "host-fonts"],
    });
  });

  it("keeps its own value and tells replay-host-skew where the host lacks the persona", () => {
    const plan = replayed(swiftShaderHost(forkWithGl([HIDE_ONLY])));

    expect({
      presented: plan.chosen.surfaces.gpu,
      recorded: plan.chosen.record?.device.gpu,
      tells: plan.tells,
    }).toStrictEqual({
      presented: { backend: "swiftshader", persona: null },
      recorded: ANNOUNCED_RENOIR,
      tells: ["gl-persona-unavailable", "host-fonts", "replay-host-skew"],
    });
  });

  it("replays a null persona as null under an announce client, never drawing one", () => {
    const capabilities = swiftShaderHost(forked);
    const record = recordPresenting(capabilities, { backend: "swiftshader", persona: null });

    const plan = planIdentity(
      contextOf({ capabilities, device: { kind: "record", record }, pins: announcing }),
    );

    expect({ presented: plan.chosen.surfaces.gpu, tells: plan.tells }).toStrictEqual({
      presented: { backend: "swiftshader", persona: null },
      tells: ["gl-persona-unavailable", "host-fonts"],
    });
  });

  it("replays a record that names a persona the host lacks by drawing from the host and telling replay-host-skew, under announce too", () => {
    const gone = {
      backend: "swiftshader",
      persona: { kind: "hardware", name: "basharsx4-amd-gone" },
      policy: "announce",
    } as const;

    const record = recordPresenting(swiftShaderHost(forked), gone);

    const plan = planIdentity(
      contextOf({
        capabilities: swiftShaderHost(forked),
        device: { kind: "record", record },
        pins: announcing,
      }),
    );

    expect({ presented: plan.chosen.surfaces.gpu, tells: plan.tells }).toStrictEqual({
      presented: ANNOUNCED_RENOIR,
      tells: [
        "gpu-announced-over-software",
        "gpu-fleet-constant",
        "host-fonts",
        "replay-host-skew",
      ],
    });
  });

  it("lets a matched client that pins the record's own persona replay it", () => {
    const capabilities = swiftShaderHost(forked);
    const record = recordPresenting(capabilities, ANNOUNCED_RENOIR);
    const pins = pinningGpu([{ name: "basharsx4-amd-renoir", weight: 1 }]);

    const plan = planIdentity(
      contextOf({ capabilities, device: { kind: "record", record }, pins }),
    );

    expect({
      overrides: recordOverrides(record, { mode: "headless", pins }),
      presented: plan.chosen.surfaces.gpu,
      tells: plan.tells,
    }).toStrictEqual({
      overrides: [],
      presented: ANNOUNCED_RENOIR,
      tells: ["gpu-announced-over-software", "gpu-fleet-constant", "host-fonts"],
    });
  });

  it("still refuses a pin of a persona the record's lineup does not hold", () => {
    const capabilities = swiftShaderHost(forked);
    const record = recordPresenting(capabilities, ANNOUNCED_RENOIR);
    const pins = pinningGpu([{ name: "basharsx4-intel-uhd", weight: 1 }]);

    expect(() =>
      planIdentity(contextOf({ capabilities, device: { kind: "record", record }, pins })),
    ).toThrow(expect.objectContaining({ code: "INVALID_OPTIONS" }));
  });

  it("replays a record from a native GPU on a SwiftShader host by drawing, because only an announce record replays through an announce lineup", () => {
    const native = {
      backend: "native",
      persona: { kind: "hardware", name: "basharsx4-amd-renoir" },
    } as const;

    const record = recordPresenting(swiftShaderHost(forked), native);

    const plan = planIdentity(
      contextOf({ capabilities: swiftShaderHost(forked), device: { kind: "record", record } }),
    );

    expect({ presented: plan.chosen.surfaces.gpu, tells: plan.tells }).toStrictEqual({
      presented: { backend: "swiftshader", persona: null },
      tells: ["gl-persona-unavailable", "host-fonts", "replay-host-skew"],
    });
  });

  it("does not count the policy as an override of the record", () => {
    const record = recordPresenting(swiftShaderHost(forked), ANNOUNCED_RENOIR);

    expect(recordOverrides(record, { mode: "headless", pins: announcing })).toStrictEqual([]);
  });
});

const fatalEquals = (field: string, value: number) => ({
  compatibility: true,
  field,
  matcher: { kind: "equals", value },
  severity: "fatal",
});

const hardwareExpectations = (cores: number, memoryGb: number) => [
  {
    compatibility: true,
    field: "hardwareConcurrency",
    matcher: { kind: "equals", value: cores },
    severity: "fatal",
  },
  {
    compatibility: true,
    field: "deviceMemory",
    matcher: { kind: "equals", value: memoryGb },
    severity: "note",
  },
];

const hardwareInputs = (cores: number, memoryGb: number) => [
  { name: "--xrio-hardware-concurrency", sink: "switch", value: String(cores) },
  { name: "--xrio-device-memory", sink: "switch", value: String(memoryGb) },
];

const hardwareOf = (overrides: Partial<IdentityContext>) =>
  resolveSurfaces(contextOf({ capabilities: forkWithKnobs(), ...overrides })).hardware;

const { "device-memory": _memory, ...withoutMemory } = HARDWARE_KNOBS;

const { "hardware-concurrency": _cores, ...withoutCores } = HARDWARE_KNOBS;

const { "spoof-hardware": _spoof, ...withoutSpoof } = HARDWARE_KNOBS;

const recordWith = (cores: number, memoryGb: number): DeviceRecord => {
  const { record } = planIdentity(contextOf()).chosen;

  if (record === null) {
    throw new Error("A headless plan records its device.");
  }

  return { ...record, device: { ...record.device, cores, memoryGb } };
};

describe("the hardware surface", () => {
  it("sends both knobs with the seed's drawn row and expects the cores, fatally", () => {
    expect(hardwareOf({})).toStrictEqual({
      expected: hardwareExpectations(6, 16),
      inputs: hardwareInputs(6, 16),
      tells: [],
      value: { cores: 6, memoryGb: 16, source: "drawn" },
    });
  });

  it.each([
    { cores: 6, memoryGb: 16, permitted: 32, tells: [] },
    { cores: 6, memoryGb: 16, permitted: 12, tells: ["hardware-capped"] },
    { cores: 4, memoryGb: 8, permitted: 6, tells: ["hardware-capped"] },
  ])(
    "draws $cores cores and $memoryGb GB on a host that permits $permitted CPUs, telling $tells",
    ({ cores, memoryGb, permitted, tells }) => {
      expect(hardwareOf({ capabilities: forkWithKnobs(HARDWARE_KNOBS, permitted) })).toStrictEqual({
        expected: hardwareExpectations(cores, memoryGb),
        inputs: hardwareInputs(cores, memoryGb),
        tells,
        value: { cores, memoryGb, source: "drawn" },
      });
    },
  );

  it("keeps the host's own values and tells hardware-capped when no row fits the permitted CPUs", () => {
    expect(hardwareOf({ capabilities: forkWithKnobs(HARDWARE_KNOBS, 2) })).toStrictEqual({
      expected: [],
      inputs: [],
      tells: ["hardware-capped"],
      value: { cores: 0, memoryGb: 0, source: "host" },
    });
  });

  it.each([
    { capabilities: { permittedCpus: 32, platform: "linux" } as const, name: "a stock binary" },
    { capabilities: forkWithKnobs({}), name: "a fork with no knobs" },
    { capabilities: forkWithKnobs(withoutMemory), name: "a fork without device-memory" },
    { capabilities: forkWithKnobs(withoutCores), name: "a fork without hardware-concurrency" },
    { capabilities: forkWithKnobs(withoutSpoof), name: "a fork that does not list spoof-hardware" },
    {
      capabilities: forkWithKnobs({
        ...HARDWARE_KNOBS,
        "spoof-hardware": { origin: "set", value: "false" },
      }),
      name: "a fork with spoof-hardware false",
    },
  ])("sends no knob and tells hardware-unhonored on $name", ({ capabilities }) => {
    expect(hardwareOf({ capabilities })).toStrictEqual({
      expected: [],
      inputs: [],
      tells: ["hardware-unhonored"],
      value: { cores: 0, memoryGb: 0, source: "host" },
    });
  });

  it("never sends the fork's own seed, machine-classes or machine-class-expect", () => {
    const everyKnob: KnobRegistry = {
      ...HARDWARE_KNOBS,
      "machine-class-expect": { origin: "set", value: "6,16" },
      "machine-classes": { origin: "set", value: "[[6,16,200,1]]" },
      seed: { origin: "set", value: "0x1" },
    };

    const { switches } = planIdentity(contextOf({ capabilities: forkWithKnobs(everyKnob) })).inputs;

    expect(switches.filter((entry) => entry.startsWith("--xrio-"))).toStrictEqual([
      "--xrio-hardware-concurrency=6",
      "--xrio-device-memory=16",
    ]);
  });

  it("sends the same two knobs in a headed browser", () => {
    expect(hardwareOf({ mode: "headed" }).inputs).toStrictEqual(hardwareInputs(6, 16));
  });

  it("presents what the caller pins, whatever the host permits", () => {
    expect(
      hardwareOf({
        capabilities: forkWithKnobs(HARDWARE_KNOBS, 4),
        pins: {
          ...noPins,
          hardware: { cores: [{ value: 8, weight: 1 }], memoryGb: [{ value: 16, weight: 1 }] },
        },
      }),
    ).toStrictEqual({
      expected: hardwareExpectations(8, 16),
      inputs: hardwareInputs(8, 16),
      tells: [],
      value: { cores: 8, memoryGb: 16, source: "pinned" },
    });
  });

  it("presents a pinned memory on a host under the smallest row, with the host's CPUs as cores", () => {
    expect(
      hardwareOf({
        capabilities: forkWithKnobs(HARDWARE_KNOBS, 2),
        pins: { ...noPins, hardware: { cores: undefined, memoryGb: [{ value: 16, weight: 1 }] } },
      }),
    ).toStrictEqual({
      expected: hardwareExpectations(2, 16),
      inputs: hardwareInputs(2, 16),
      tells: ["hardware-capped"],
      value: { cores: 2, memoryGb: 16, source: "pinned" },
    });
  });

  it("draws the other field from Xrio's rows that agree with a pinned one", () => {
    expect([
      hardwareOf({
        pins: { ...noPins, hardware: { cores: [{ value: 12, weight: 1 }], memoryGb: undefined } },
      }).value,
      hardwareOf({
        pins: { ...noPins, hardware: { cores: undefined, memoryGb: [{ value: 32, weight: 1 }] } },
      }).value,
    ]).toStrictEqual([
      { cores: 12, memoryGb: 16, source: "pinned" },
      { cores: 12, memoryGb: 32, source: "pinned" },
    ]);
  });

  it("presents a record's cores and memory, and keeps the host's with a hardware-unhonored tell where the record has none", () => {
    expect([
      hardwareOf({ device: { kind: "record", record: recordWith(12, 16) } }),
      hardwareOf({ device: { kind: "record", record: recordWith(0, 0) } }),
    ]).toStrictEqual([
      {
        expected: hardwareExpectations(12, 16),
        inputs: hardwareInputs(12, 16),
        tells: [],
        value: { cores: 12, memoryGb: 16, source: "record" },
      },
      {
        expected: [],
        inputs: [],
        tells: ["hardware-unhonored"],
        value: { cores: 0, memoryGb: 0, source: "host" },
      },
    ]);
  });
});

describe("the window surface", () => {
  it("maximizes the fixed seed's headless window to its work area and expects exactly that", () => {
    expect(resolveSurfaces(contextOf()).window).toStrictEqual({
      expected: [
        fatalEquals("outerWidth", 1680),
        fatalEquals("outerHeight", 1018),
        fatalEquals("screenX", 0),
        fatalEquals("screenY", 32),
      ],
      inputs: [
        { name: "--window-size", sink: "switch", value: "1680,1018" },
        { name: "--window-position", sink: "switch", value: "0,32" },
      ],
      value: { height: 1018, kind: "maximized", source: "drawn", width: 1680, x: 0, y: 32 },
    });
  });

  it("places a floating headless window where its seed drew it", () => {
    expect(
      resolveSurfaces(contextOf({ device: { kind: "fresh", seed: "0000000000000028" } })).window,
    ).toStrictEqual({
      expected: [
        fatalEquals("outerWidth", 1466),
        fatalEquals("outerHeight", 879),
        fatalEquals("screenX", 243),
        fatalEquals("screenY", 43),
      ],
      inputs: [
        { name: "--window-size", sink: "switch", value: "1466,879" },
        { name: "--window-position", sink: "switch", value: "243,43" },
      ],
      value: { height: 879, kind: "floating", source: "drawn", width: 1466, x: 243, y: 43 },
    });
  });

  it("sizes the headed window at 1600x900 and only notes one that overflows the work area", () => {
    expect(resolveSurfaces(contextOf({ mode: "headed" })).window).toStrictEqual({
      expected: [
        {
          compatibility: true,
          field: "outerWidth",
          matcher: { field: "availWidth", kind: "at-most-field" },
          severity: "note",
        },
        {
          compatibility: true,
          field: "outerHeight",
          matcher: { field: "availHeight", kind: "at-most-field" },
          severity: "note",
        },
      ],
      inputs: [{ name: "--window-size", sink: "switch", value: "1600,900" }],
      value: { size: { height: 900, width: 1600 }, source: "fixed" },
    });
  });
});

describe("the screen surface", () => {
  it.each([
    {
      expected: [1680, 1050, 1680, 1018, 0, 32],
      info: "{0,0 1680x1050 colorDepth=24 devicePixelRatio=1 isInternal=0 rotation=0 workAreaLeft=0 workAreaRight=0 workAreaTop=32 workAreaBottom=0}",
      layout: "gnome",
      seed: fixedSeed,
      size: { height: 1050, width: 1680 },
      workArea: { bottom: 0, left: 0, right: 0, top: 32 },
    },
    {
      expected: [1920, 1200, 1854, 1168, 66, 32],
      info: "{0,0 1920x1200 colorDepth=24 devicePixelRatio=1 isInternal=0 rotation=0 workAreaLeft=66 workAreaRight=0 workAreaTop=32 workAreaBottom=0}",
      layout: "ubuntu",
      seed: "0000000000000028",
      size: { height: 1200, width: 1920 },
      workArea: { bottom: 0, left: 66, right: 0, top: 32 },
    },
  ])(
    "presents $seed's drawn $layout screen and work area in headless mode",
    ({ expected, info, layout, seed, size, workArea }) => {
      const fields = [
        "screenWidth",
        "screenHeight",
        "availWidth",
        "availHeight",
        "availLeft",
        "availTop",
      ];

      expect(resolveSurfaces(contextOf({ device: { kind: "fresh", seed } })).screen).toStrictEqual({
        expected: fields.map((field, index) => fatalEquals(field, expected[index])),
        inputs: [{ name: "--screen-info", sink: "switch", value: info }],
        value: { layout, size, source: "drawn", workArea },
      });
    },
  );

  it("leaves a headed browser the real display", () => {
    expect(resolveSurfaces(contextOf({ mode: "headed" })).screen).toStrictEqual({
      expected: [],
      inputs: [],
      tells: [],
      value: { source: "host" },
    });
  });
});

describe("the leaks surface", () => {
  it("turns network prediction and DNS-over-HTTPS off", () => {
    expect(resolveSurfaces(contextOf()).leaks).toStrictEqual({
      expected: [],
      inputs: [
        { name: "net.network_prediction_options", sink: "preference", value: 2 },
        { name: "dns_over_https.mode", sink: "local-state", value: "off" },
      ],
      value: { dnsOverHttps: "off", networkPrediction: "off" },
    });
  });
});

describe("the media surface", () => {
  it("presents one microphone and one speaker and no camera on Linux", () => {
    expect(resolveSurfaces(contextOf()).media).toStrictEqual({
      expected: [],
      inputs: [
        { name: "--use-fake-device-for-media-stream", sink: "switch", value: "device-count=0" },
      ],
      value: { devices: { audioinput: 1, audiooutput: 1, videoinput: 0 }, source: "fake" },
    });
  });

  it.each(["darwin", "win32"] as const)("leaves the host's own devices alone on %s", (platform) => {
    expect(
      resolveSurfaces(contextOf({ capabilities: { permittedCpus: 32, platform } })).media,
    ).toStrictEqual({
      expected: [],
      inputs: [],
      value: { source: "host" },
    });
  });

  it("builds a fresh choice on every call, so no two plans share an object", () => {
    const first = resolveSurfaces(contextOf()).media.value;
    const second = resolveSurfaces(contextOf()).media.value;

    expect(first).toStrictEqual(second);
    expect([
      first === second,
      "devices" in first && "devices" in second && first.devices === second.devices,
    ]).toStrictEqual([false, false]);
  });
});

const expectedFontFields = (capabilities: HostCapabilities) =>
  resolveSurfaces(contextOf({ capabilities })).fonts.expected.map(({ field }) => field);

describe("the fonts surface", () => {
  it("writes a per-profile fonts.conf from the checked stack and points both fontconfig variables at it", () => {
    const { fonts } = resolveSurfaces(contextOf({ capabilities: withStack() }));

    expect(fonts.inputs).toStrictEqual([
      {
        contents: fontConfigOf(STACK),
        file: "fonts.conf",
        name: "FONTCONFIG_FILE",
        sink: "file-environment",
      },
      { name: "FONTCONFIG_PATH", sink: "environment", value: "/opt/xrio-chrome/fontstack/fonts" },
    ]);
  });

  it("names the stack's absolute share directory and the per-host cache, and drops the user's rules", () => {
    const [contents = ""] = resolveSurfaces(
      contextOf({ capabilities: withStack() }),
    ).fonts.inputs.flatMap((input) => (input.sink === "file-environment" ? [input.contents] : []));

    expect(contents.split("\n").filter((line) => line.includes("<"))).toStrictEqual([
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
      "<fontconfig>",
      "  <dir>/opt/xrio-chrome/fontstack/share</dir>",
      "  <cachedir>/tmp/xrio-501/fontcache-0123456789abcdef</cachedir>",
      '  <include ignore_missing="no">/opt/xrio-chrome/fontstack/fonts/conf.d/10-antialias.conf</include>',
      '  <include ignore_missing="no">/opt/xrio-chrome/fontstack/fonts/conf.d/60-latin.conf</include>',
      "</fontconfig>",
    ]);
  });

  it("reports the stack's payload and the digest of the config it wrote, and tells nothing", () => {
    const { fonts } = resolveSurfaces(contextOf({ capabilities: withStack() }));

    expect(fonts).not.toHaveProperty("tells");
    expect(fonts).toMatchObject({
      value: {
        config: "af5559ed3284a8ae0b81fab350523bb7110e8017285701dd499fbadfcbadbd32",
        payload: PAYLOAD,
        source: "package",
      },
    });
  });

  it("reports the same config digest for the same rules at another path, with another cache", () => {
    const moved: FontStack = {
      ...STACK,
      cacheDir: "/var/tmp/xrio-1002/fontcache-fedcba9876543210",
      directory: "/srv/other/fontstack",
    };

    const digests = [STACK, moved].map((stack) => {
      const { fonts } = resolveSurfaces(
        contextOf({
          capabilities: {
            fontStack: { ...stack, kind: "checked" },
            permittedCpus: 32,
            platform: "linux",
          },
        }),
      );

      return "config" in fonts.value ? fonts.value.config : null;
    });

    expect(digests).toStrictEqual(
      Array.from(
        { length: 2 },
        () => "af5559ed3284a8ae0b81fab350523bb7110e8017285701dd499fbadfcbadbd32",
      ),
    );
  });

  it("reports another config digest when the rules the config includes change", () => {
    const { fonts } = resolveSurfaces(
      contextOf({
        capabilities: {
          fontStack: { ...STACK, kind: "checked", rules: [...STACK.rules, "70-extra.conf"] },
          permittedCpus: 32,
          platform: "linux",
        },
      }),
    );

    expect("config" in fonts.value ? fonts.value.config : null).not.toBe(
      "af5559ed3284a8ae0b81fab350523bb7110e8017285701dd499fbadfcbadbd32",
    );
  });

  it("tells host-fonts on Linux with no stack beside the binary", () => {
    expect(resolveSurfaces(contextOf()).fonts).toStrictEqual({
      expected: [],
      inputs: [],
      tells: ["host-fonts"],
      value: { reason: "no fontstack/ beside the binary", source: "host" },
    });
  });

  it("tells host-fonts with the reason a stack failed its check, and emits nothing", () => {
    const capabilities: HostCapabilities = {
      fontStack: { kind: "refused", reason: "fc-list printed 0 families, the manifest lists 175" },
      permittedCpus: 32,
      platform: "linux",
    };

    expect(resolveSurfaces(contextOf({ capabilities })).fonts).toStrictEqual({
      expected: [],
      inputs: [],
      tells: ["host-fonts"],
      value: { reason: "fc-list printed 0 families, the manifest lists 175", source: "host" },
    });
  });

  it.each([
    { capabilities: withStack(), name: "with a checked stack on Linux" },
    {
      capabilities: { permittedCpus: 32, platform: "linux" as const },
      name: "with no stack on Linux",
    },
    { capabilities: { permittedCpus: 32, platform: "darwin" as const }, name: "on macOS" },
  ])(
    "expects a note on the stored sentinel $name, and none without evidence",
    ({ capabilities }) => {
      const evidence = { ageMs: 1, digest: "2eeb6d13", key: "5be0c7d2", sentinel: "c6755abb" };

      expect([
        expectedFontFields(capabilities).filter((field) => field === "fontsSentinel"),
        expectedFontFields({ ...capabilities, fontEvidence: evidence }).filter(
          (field) => field === "fontsSentinel",
        ),
      ]).toStrictEqual([[], ["fontsSentinel"]]);
    },
  );

  it("expects the sentinel families to resolve, as a note, only under a pinned stack", () => {
    const resolves = {
      compatibility: false,
      field: "fontsSentinelResolved",
      matcher: { kind: "equals", value: true },
      severity: "note",
    };

    expect([
      resolveSurfaces(contextOf({ capabilities: withStack() })).fonts.expected,
      resolveSurfaces(contextOf({ capabilities: { permittedCpus: 32, platform: "linux" } })).fonts
        .expected,
      resolveSurfaces(contextOf({ capabilities: withStack("darwin") })).fonts.expected,
    ]).toStrictEqual([[resolves], [], []]);
  });

  it("sets no variable and tells nothing on macOS, whatever stack the capabilities carry", () => {
    expect(resolveSurfaces(contextOf({ capabilities: withStack("darwin") })).fonts).toStrictEqual({
      expected: [],
      inputs: [],
      value: { reason: null, source: "host" },
    });
  });
});

describe("the speech surface", () => {
  it("chooses nothing and emits nothing on a stock binary", () => {
    expect(resolveSurfaces(contextOf()).speech).toStrictEqual({
      expected: [],
      inputs: [],
      tells: [],
      value: { persona: null },
    });
  });

  it("reports the package's persona when its artifact matches the probed version", () => {
    expect(
      resolveSurfaces(contextOf({ capabilities: forkWith(LINUX_SPEECH, ["154.0.8037.57"]) }))
        .speech,
    ).toStrictEqual({ expected: [], inputs: [], tells: [], value: { persona: LINUX_SPEECH } });
  });

  it("tells speech-persona-skew when the persona was recorded on another Chrome version", () => {
    expect(
      resolveSurfaces(contextOf({ capabilities: forkWith(LINUX_SPEECH, ["153.0.7900.10"]) }))
        .speech,
    ).toStrictEqual({
      expected: [],
      inputs: [],
      tells: ["speech-persona-skew"],
      value: { persona: LINUX_SPEECH },
    });
  });

  it("tells speech-persona-skew when the selected persona ships no artifact", () => {
    expect(
      resolveSurfaces(contextOf({ capabilities: forkWith(LINUX_SPEECH) })).speech.tells,
    ).toStrictEqual(["speech-persona-skew"]);
  });

  it("reports no persona and no tell on a fork with no speech persona selected", () => {
    expect(resolveSurfaces(contextOf({ capabilities: forkWith(null) })).speech).toStrictEqual({
      expected: [],
      inputs: [],
      tells: [],
      value: { persona: null },
    });
  });
});

describe("the automation surface", () => {
  const noWebdriver = {
    compatibility: true,
    field: "webdriver",
    matcher: { kind: "equals", value: false },
    severity: "fatal",
  };

  it("expects webdriver false and notes a colour scheme other than light on Linux", () => {
    expect(resolveSurfaces(contextOf()).automation).toStrictEqual({
      expected: [
        noWebdriver,
        {
          compatibility: true,
          field: "colorScheme",
          matcher: { kind: "equals", value: "light" },
          severity: "note",
        },
      ],
      inputs: [],
      tells: [],
      value: null,
    });
  });

  it("expects no HeadlessChrome token where the fork suppresses it", () => {
    expect(resolveSurfaces(contextOf({ capabilities: forkWith(null) })).automation).toStrictEqual({
      expected: [
        noWebdriver,
        {
          compatibility: false,
          field: "userAgent",
          matcher: { kind: "no-headless-token" },
          severity: "fatal",
        },
        {
          compatibility: true,
          field: "colorScheme",
          matcher: { kind: "equals", value: "light" },
          severity: "note",
        },
      ],
      inputs: [],
      tells: [],
      value: null,
    });
  });

  it("expects no colour scheme on macOS, where it follows the host", () => {
    expect(
      resolveSurfaces(contextOf({ capabilities: { permittedCpus: 32, platform: "darwin" } }))
        .automation,
    ).toStrictEqual({ expected: [noWebdriver], inputs: [], tells: [], value: null });
  });
});

const forkWithInfobarKnob = (value: string): HostCapabilities => {
  const { fork } = forkWith(null);

  if (fork === undefined) {
    throw new Error("forkWith builds a fork.");
  }

  return {
    ...forkWith(null),
    fork: {
      ...fork,
      knobs: { ...fork.knobs, "suppress-startup-infobars": { origin: "set", value } },
    },
  };
};

const flagInfobarTells = (overrides: Partial<IdentityContext>): readonly string[] =>
  resolveSurfaces(contextOf(overrides)).automation.tells ?? [];

describe("the flag-infobar tell", () => {
  it("marks every headed stock launch, which always sends the AutomationControlled switch", () => {
    expect(flagInfobarTells({ mode: "headed" })).toStrictEqual(["flag-infobar"]);
    expect(
      flagInfobarTells({ capabilities: { permittedCpus: 32, platform: "darwin" }, mode: "headed" }),
    ).toStrictEqual(["flag-infobar"]);
  });

  it("does not mark a headless launch, which has no infobar to show", () => {
    expect(flagInfobarTells({ mode: "headless" })).toStrictEqual([]);
  });

  it("does not mark a fork whose suppress-startup-infobars knob is true", () => {
    expect(
      flagInfobarTells({ capabilities: forkWithInfobarKnob("true"), mode: "headed" }),
    ).toStrictEqual([]);
  });

  it("marks a fork whose suppress-startup-infobars knob is false", () => {
    expect(
      flagInfobarTells({ capabilities: forkWithInfobarKnob("false"), mode: "headed" }),
    ).toStrictEqual(["flag-infobar"]);
  });

  it("marks a fork that does not list the knob", () => {
    expect(flagInfobarTells({ capabilities: forkWith(null), mode: "headed" })).toStrictEqual([
      "flag-infobar",
    ]);
  });

  it("carries the tell into the plan for a headed stock launch only", () => {
    expect(planIdentity(contextOf({ mode: "headed" })).tells).toContain("flag-infobar");
    expect(planIdentity(contextOf({ mode: "headless" })).tells).not.toContain("flag-infobar");
  });
});

describe("the fork in the plan", () => {
  it("names the fork and carries the surfaces' tells", () => {
    const plan = planIdentity(contextOf({ capabilities: forkWith(LINUX_SPEECH) }));

    expect({ binary: plan.chosen.binary, tells: plan.tells }).toStrictEqual({
      binary: { commit: null, dirty: null, fork: "xrio" },
      tells: ["gl-persona-unavailable", "hardware-unhonored", "host-fonts", "speech-persona-skew"],
    });
  });
});

describe("emission order", () => {
  it("lists every surface once", () => {
    expect([...EMISSION_ORDER].toSorted()).toStrictEqual(
      Object.keys(resolveSurfaces(contextOf())).toSorted(),
    );
  });
});

describe("the planned tells", () => {
  it("gathers what each surface's facts show", () => {
    const capabilities = withStack();

    expect(
      planIdentity(contextOf({ capabilities, exit: proxyRoute, hostZone: "America/Chicago" }))
        .tells,
    ).toStrictEqual(["exit-unknown", "gl-persona-unavailable", "hardware-unhonored"]);
    expect(planIdentity(contextOf({ capabilities, hostZone: "UTC" })).tells).toStrictEqual([
      "host-zone-utc",
      "gl-persona-unavailable",
      "hardware-unhonored",
    ]);
    expect(
      planIdentity(contextOf({ capabilities, hostZone: "America/Chicago" })).tells,
    ).toStrictEqual(["gl-persona-unavailable", "hardware-unhonored"]);
    expect(planIdentity(contextOf({ hostZone: "America/Chicago" })).tells).toStrictEqual([
      "gl-persona-unavailable",
      "hardware-unhonored",
      "host-fonts",
    ]);
  });
});

describe("the chosen identity", () => {
  it("names the mode, the exit, the seed and every surface's choice, with no input or expectation", () => {
    expect(
      planIdentity(
        contextOf({
          capabilities: { permittedCpus: 32, platform: "darwin" },
          exit: { facts: { kind: "unknown" }, route: "proxy" },
          hostZone: "Europe/Berlin",
          mode: "headed",
        }),
      ).chosen,
    ).toStrictEqual({
      binary: { commit: null, dirty: null, fork: null },
      digests: {
        device: null,
        host: "3c671ef210d1991ead8ece83faa2e2eb5f4dbdcc60c3d57e7876227d2ff2b308",
      },
      exit: { facts: { kind: "unknown" }, route: "proxy" },
      mode: "headed",
      record: null,
      seed: fixedSeed,
      surfaces: {
        automation: null,
        fonts: { reason: null, source: "host" },
        gpu: { backend: "native", persona: null },
        hardware: { cores: 0, memoryGb: 0, source: "host" },
        leaks: { dnsOverHttps: "off", networkPrediction: "off" },
        locale: { languages: ["en-US", "en"], tag: "en-US" },
        media: { source: "host" },
        screen: { source: "host" },
        seed: { source: "fresh" },
        speech: { persona: null },
        timezone: { source: "host", zone: "Europe/Berlin" },
        window: { size: { height: 900, width: 1600 }, source: "fixed" },
      },
    });
  });
});

const lane5 = {
  screens: [{ height: 900, weight: 1, width: 1440 }],
  taskbars: [{ bottom: 48, left: 0, right: 0, top: 0, weight: 1 }],
  windows: [{ kind: "maximized", weight: 1 }],
} as const;

const pinned = (display: IdentityIntent["display"], mode: IdentityContext["mode"] = "headless") =>
  planIdentity(contextOf({ mode, pins: { ...noPins, display } })).chosen.surfaces;

describe("a display the caller pins", () => {
  it("presents the pinned screen, taskbar and maximized window in headless mode", () => {
    expect(pinned(lane5)).toMatchObject({
      screen: {
        layout: null,
        size: { height: 900, width: 1440 },
        source: "display",
        workArea: { bottom: 48, left: 0, right: 0, top: 0 },
      },
      window: { height: 852, kind: "maximized", source: "display", width: 1440, x: 0, y: 0 },
    });
  });

  it("draws what the caller leaves out, and places a sized window inside the work area", () => {
    const surfaces = pinned({
      screens: undefined,
      taskbars: undefined,
      windows: [{ height: 700, kind: "sized", weight: 1, width: 1300 }],
    });

    expect(surfaces).toMatchObject({
      screen: { layout: "gnome", size: { height: 1050, width: 1680 }, source: "drawn" },
      window: { height: 700, kind: "floating", source: "display", width: 1300 },
    });
    expect(surfaces.window).toSatisfy(
      (window: SurfaceChoices["window"]) =>
        "x" in window &&
        window.x >= 0 &&
        window.y >= 32 &&
        window.x + window.width <= 1680 &&
        window.y + window.height <= 1050,
    );
  });

  it("changes nothing in headed mode and tells that the pin was not honoured", () => {
    const headed = planIdentity(contextOf({ mode: "headed", pins: { ...noPins, display: lane5 } }));

    expect({
      screen: headed.chosen.surfaces.screen,
      tells: headed.tells,
      window: headed.chosen.surfaces.window,
    }).toStrictEqual({
      screen: { source: "host" },
      tells: [
        "gl-persona-unavailable",
        "hardware-unhonored",
        "display-pin-unhonored",
        "host-fonts",
        "flag-infobar",
      ],
      window: { size: { height: 900, width: 1600 }, source: "fixed" },
    });
  });
});
