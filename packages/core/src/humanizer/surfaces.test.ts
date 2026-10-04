import { describe, expect, it } from "vite-plus/test";

import { noPins } from "../testing/no-pins.ts";
import type { HostCapabilities } from "./contracts.ts";
import { planIdentity } from "./humanizer.ts";
import { chromeAcceptLanguages } from "./owned-inputs.ts";
import { EMISSION_ORDER, resolveSurfaces } from "./surfaces.ts";
import type { IdentityContext } from "./surfaces.ts";

const contextOf = (overrides: Partial<IdentityContext> = {}): IdentityContext => ({
  capabilities: { platform: "linux" },
  exit: { facts: { kind: "unknown" }, route: "direct" },
  hostZone: "America/Chicago",
  mode: "headless",
  pins: noPins,
  ...overrides,
});

const pinnedTo = (locale: string): Partial<IdentityContext> => ({
  pins: { locale, timezone: undefined },
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
    dialect: "xrio",
    knobs: {
      "speech-persona": { origin: speechPersona === null ? "def" : "set", value: speechPersona },
      "suppress-headless-token": { origin: "def", value: "true" },
    },
    packageDir: "/opt/xrio-chrome",
    personas: {
      speech: artifactVersions.map((chromeVersion) => ({
        chromeVersion,
        digest: `sha256:${"0".repeat(64)}`,
        name: LINUX_SPEECH,
        schema: "xrio-speech-table/v1",
      })),
    },
    version: "154.0.8037.57",
  },
  platform: "linux",
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
      resolveSurfaces(contextOf({ ...pinnedTo("de-DE"), capabilities: { platform: "darwin" } }))
        .locale.expected,
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

describe("the gpu surface", () => {
  it("selects ANGLE on SwiftShader on Linux", () => {
    expect(resolveSurfaces(contextOf()).gpu).toStrictEqual({
      expected: [],
      inputs: [
        { name: "--use-gl", sink: "switch", value: "angle" },
        { name: "--use-angle", sink: "switch", value: "swiftshader" },
      ],
      value: { backend: "swiftshader", persona: null },
    });
  });

  it.each(["darwin", "win32"] as const)("leaves the system's backend alone on %s", (platform) => {
    expect(resolveSurfaces(contextOf({ capabilities: { platform } })).gpu).toStrictEqual({
      expected: [],
      inputs: [],
      value: { backend: "native" },
    });
  });
});

describe("the window surface", () => {
  it("sizes the headless window at 1600x900 and expects exactly that", () => {
    expect(resolveSurfaces(contextOf()).window).toStrictEqual({
      expected: [
        {
          compatibility: true,
          field: "outerWidth",
          matcher: { kind: "equals", value: 1600 },
          severity: "fatal",
        },
        {
          compatibility: true,
          field: "outerHeight",
          matcher: { kind: "equals", value: 900 },
          severity: "fatal",
        },
      ],
      inputs: [{ name: "--window-size", sink: "switch", value: "1600,900" }],
      value: { size: { height: 900, width: 1600 }, source: "fixed" },
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
  it("describes a 1920x1080 screen with a 40 px bottom inset in headless mode", () => {
    expect(resolveSurfaces(contextOf()).screen).toStrictEqual({
      expected: [
        {
          compatibility: true,
          field: "screenWidth",
          matcher: { kind: "equals", value: 1920 },
          severity: "fatal",
        },
        {
          compatibility: true,
          field: "screenHeight",
          matcher: { kind: "equals", value: 1080 },
          severity: "fatal",
        },
        {
          compatibility: true,
          field: "availWidth",
          matcher: { kind: "equals", value: 1920 },
          severity: "fatal",
        },
        {
          compatibility: true,
          field: "availHeight",
          matcher: { kind: "equals", value: 1040 },
          severity: "fatal",
        },
      ],
      inputs: [
        {
          name: "--screen-info",
          sink: "switch",
          value:
            "{0,0 1920x1080 colorDepth=24 devicePixelRatio=1 isInternal=0 rotation=0 workAreaLeft=0 workAreaRight=0 workAreaTop=0 workAreaBottom=40}",
        },
      ],
      value: {
        size: { height: 1080, width: 1920 },
        source: "fixed",
        workArea: { bottom: 40, left: 0, right: 0, top: 0 },
      },
    });
  });

  it("leaves a headed browser the real display", () => {
    expect(resolveSurfaces(contextOf({ mode: "headed" })).screen).toStrictEqual({
      expected: [],
      inputs: [],
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
    expect(resolveSurfaces(contextOf({ capabilities: { platform } })).media).toStrictEqual({
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
      value: null,
    });
  });

  it("expects no colour scheme on macOS, where it follows the host", () => {
    expect(
      resolveSurfaces(contextOf({ capabilities: { platform: "darwin" } })).automation,
    ).toStrictEqual({ expected: [noWebdriver], inputs: [], value: null });
  });
});

describe("the fork in the plan", () => {
  it("names the fork and carries the surfaces' tells", () => {
    const plan = planIdentity(contextOf({ capabilities: forkWith(LINUX_SPEECH) }));

    expect({ fork: plan.chosen.fork, tells: plan.tells }).toStrictEqual({
      fork: "xrio",
      tells: ["speech-persona-skew"],
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
    expect(
      planIdentity(contextOf({ exit: proxyRoute, hostZone: "America/Chicago" })).tells,
    ).toStrictEqual(["exit-unknown"]);
    expect(planIdentity(contextOf({ hostZone: "UTC" })).tells).toStrictEqual(["host-zone-utc"]);
    expect(planIdentity(contextOf({ hostZone: "America/Chicago" })).tells).toStrictEqual([]);
  });
});

describe("the chosen identity", () => {
  it("names the mode, the exit and every surface's choice, with no input or expectation", () => {
    expect(
      planIdentity(
        contextOf({
          capabilities: { platform: "darwin" },
          exit: { facts: { kind: "unknown" }, route: "proxy" },
          hostZone: "Europe/Berlin",
          mode: "headed",
        }),
      ).chosen,
    ).toStrictEqual({
      exit: { facts: { kind: "unknown" }, route: "proxy" },
      fork: null,
      mode: "headed",
      surfaces: {
        automation: null,
        gpu: { backend: "native" },
        leaks: { dnsOverHttps: "off", networkPrediction: "off" },
        locale: { languages: ["en-US", "en"], tag: "en-US" },
        media: { source: "host" },
        screen: { source: "host" },
        speech: { persona: null },
        timezone: { source: "host", zone: "Europe/Berlin" },
        window: { size: { height: 900, width: 1600 }, source: "fixed" },
      },
    });
  });
});
