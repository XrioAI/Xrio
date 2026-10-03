import { describe, expect, it } from "vite-plus/test";

import { EMISSION_ORDER, resolveSurfaces } from "./surfaces.ts";
import type { IdentityContext } from "./surfaces.ts";

const contextOf = (overrides: Partial<IdentityContext> = {}): IdentityContext => ({
  capabilities: { platform: "linux" },
  hostZone: undefined,
  mode: "headless",
  ...overrides,
});

describe("the locale surface", () => {
  it("chooses en-US with Chrome's two-language list", () => {
    expect(resolveSurfaces(contextOf()).locale).toStrictEqual({
      inputs: [
        { name: "--lang", sink: "switch", value: "en-US" },
        { name: "--accept-lang", sink: "switch", value: "en-US,en" },
        { name: "LANG", sink: "environment", value: "C.UTF-8" },
        { name: "LANGUAGE", sink: "environment", value: "en_US" },
        { name: "intl.accept_languages", sink: "preference", value: "en-US,en" },
      ],
    });
  });
});

describe("the timezone surface", () => {
  it("forwards the host zone to Chrome", () => {
    expect(resolveSurfaces(contextOf({ hostZone: "America/Chicago" })).timezone).toStrictEqual({
      inputs: [{ name: "TZ", sink: "forwarded-environment", value: "America/Chicago" }],
    });
  });

  it("emits nothing when there is no host zone, so Chrome keeps the system zone", () => {
    expect(resolveSurfaces(contextOf()).timezone).toStrictEqual({ inputs: [] });
  });

  it("forwards an empty host zone as it always has", () => {
    expect(resolveSurfaces(contextOf({ hostZone: "" })).timezone.inputs).toStrictEqual([
      { name: "TZ", sink: "forwarded-environment", value: "" },
    ]);
  });
});

describe("the gpu surface", () => {
  it("selects ANGLE on SwiftShader on Linux", () => {
    expect(resolveSurfaces(contextOf()).gpu).toStrictEqual({
      inputs: [
        { name: "--use-gl", sink: "switch", value: "angle" },
        { name: "--use-angle", sink: "switch", value: "swiftshader" },
      ],
    });
  });

  it.each(["darwin", "win32"] as const)("leaves the system's backend alone on %s", (platform) => {
    expect(resolveSurfaces(contextOf({ capabilities: { platform } })).gpu).toStrictEqual({
      inputs: [],
    });
  });
});

describe("the window surface", () => {
  it.each(["headless", "headed"] as const)("sizes the %s window at 1600x900", (mode) => {
    expect(resolveSurfaces(contextOf({ mode })).window).toStrictEqual({
      inputs: [{ name: "--window-size", sink: "switch", value: "1600,900" }],
    });
  });
});

describe("the screen surface", () => {
  it("describes a 1920x1080 screen with a 40 px bottom inset in headless mode", () => {
    expect(resolveSurfaces(contextOf()).screen).toStrictEqual({
      inputs: [
        {
          name: "--screen-info",
          sink: "switch",
          value:
            "{0,0 1920x1080 colorDepth=24 devicePixelRatio=1 isInternal=0 rotation=0 workAreaLeft=0 workAreaRight=0 workAreaTop=0 workAreaBottom=40}",
        },
      ],
    });
  });

  it("leaves a headed browser the real display", () => {
    expect(resolveSurfaces(contextOf({ mode: "headed" })).screen).toStrictEqual({ inputs: [] });
  });
});

describe("the leaks surface", () => {
  it("turns network prediction and DNS-over-HTTPS off", () => {
    expect(resolveSurfaces(contextOf()).leaks).toStrictEqual({
      inputs: [
        { name: "net.network_prediction_options", sink: "preference", value: 2 },
        { name: "dns_over_https.mode", sink: "local-state", value: "off" },
      ],
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
