import { describe, expect, it } from "vite-plus/test";

import { planIdentity } from "./humanizer.ts";
import { EMISSION_ORDER, resolveSurfaces } from "./surfaces.ts";
import type { IdentityContext } from "./surfaces.ts";

const contextOf = (overrides: Partial<IdentityContext> = {}): IdentityContext => ({
  capabilities: { platform: "linux" },
  exit: { facts: { kind: "unknown" }, route: "direct" },
  hostZone: undefined,
  mode: "headless",
  ...overrides,
});

const languagesOnLinux = {
  compatibility: true,
  field: "languages",
  matcher: { kind: "equals", value: ["en-US", "en"] },
  severity: "fatal",
};

describe("the locale surface", () => {
  it("chooses en-US with Chrome's two-language list", () => {
    expect(resolveSurfaces(contextOf()).locale).toStrictEqual({
      expected: [
        languagesOnLinux,
        {
          compatibility: true,
          field: "intlLocale",
          matcher: { kind: "same-language", locale: "en-US" },
          severity: "fatal",
        },
      ],
      inputs: [
        { name: "--lang", sink: "switch", value: "en-US" },
        { name: "--accept-lang", sink: "switch", value: "en-US,en" },
        { name: "LANG", sink: "environment", value: "C.UTF-8" },
        { name: "LANGUAGE", sink: "environment", value: "en_US" },
        { name: "intl.accept_languages", sink: "preference", value: "en-US,en" },
      ],
      value: { languages: ["en-US", "en"], tag: "en-US" },
    });
  });

  it("only notes an Intl language off the plan on macOS, where Intl follows the host", () => {
    expect(
      resolveSurfaces(contextOf({ capabilities: { platform: "darwin" } })).locale.expected,
    ).toStrictEqual([
      languagesOnLinux,
      {
        compatibility: true,
        field: "intlLocale",
        matcher: { kind: "same-language", locale: "en-US" },
        severity: "note",
      },
    ]);
  });
});

describe("the timezone surface", () => {
  it("forwards the host zone to Chrome", () => {
    expect(resolveSurfaces(contextOf({ hostZone: "America/Chicago" })).timezone).toStrictEqual({
      expected: [
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
      ],
      inputs: [{ name: "TZ", sink: "forwarded-environment", value: "America/Chicago" }],
      value: { source: "host", zone: "America/Chicago" },
    });
  });

  it("emits and expects nothing when there is no host zone, so Chrome keeps the system zone", () => {
    expect(resolveSurfaces(contextOf()).timezone).toStrictEqual({
      expected: [],
      inputs: [],
      value: { source: "host", zone: null },
    });
  });

  it("forwards an empty host zone as it always has, with no zone to expect", () => {
    expect(resolveSurfaces(contextOf({ hostZone: "" })).timezone).toStrictEqual({
      expected: [],
      inputs: [{ name: "TZ", sink: "forwarded-environment", value: "" }],
      value: { source: "host", zone: "" },
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

describe("emission order", () => {
  it("lists every surface once", () => {
    expect([...EMISSION_ORDER].toSorted()).toStrictEqual(
      Object.keys(resolveSurfaces(contextOf())).toSorted(),
    );
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
      mode: "headed",
      surfaces: {
        automation: null,
        gpu: { backend: "native" },
        leaks: { dnsOverHttps: "off", networkPrediction: "off" },
        locale: { languages: ["en-US", "en"], tag: "en-US" },
        screen: { source: "host" },
        timezone: { source: "host", zone: "Europe/Berlin" },
        window: { size: { height: 900, width: 1600 }, source: "fixed" },
      },
    });
  });
});
