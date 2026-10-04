import { describe, expect, it } from "vite-plus/test";

import { CHECKED_FONT_STACK } from "../testing/fake-font-stack.ts";
import { fixedDevice, fixedSeed } from "../testing/fixed-seed.ts";
import { noPins } from "../testing/no-pins.ts";
import { DeviceRecordRefusedError, readDeviceRecord } from "./contracts.ts";
import type { DeviceRecord, Observation } from "./contracts.ts";
import { displayMisfit, drawDisplay, seedOf, windowBounds, workAreaOf } from "./draws.ts";
import type { DrawnDisplay } from "./draws.ts";
import { planIdentity } from "./humanizer.ts";
import type { IdentityPlan } from "./humanizer.ts";
import { DESKTOP_LAYOUTS, DESKTOP_SCREENS, WINDOW_STATES } from "./owned-inputs.ts";
import { recordOverrides } from "./surfaces.ts";
import type { IdentityContext } from "./surfaces.ts";
import { evaluate } from "./verify.ts";

const CONTAINMENT_SEEDS = 10_000;

const FREQUENCY_SEEDS = 100_000;

const POINT = 0.01;

const seedAt = (index: number): string => index.toString(16).padStart(16, "0");

const draws = (count: number): DrawnDisplay[] =>
  Array.from({ length: count }, (_, index) => drawDisplay(seedAt(index + 1)));

const shareOf = <Row extends { readonly weight: number }>(rows: readonly Row[], row: Row) =>
  row.weight / rows.reduce((sum, { weight }) => sum + weight, 0);

const frequency = (
  displays: readonly DrawnDisplay[],
  holds: (display: DrawnDisplay) => boolean,
): number => displays.filter(holds).length / displays.length;

describe(seedOf, () => {
  it("spells eight bytes as sixteen hex digits", () => {
    expect(seedOf(Buffer.from("9f2c41d07a3be815", "hex"))).toBe("9f2c41d07a3be815");
  });

  it("replaces the zero seed with one", () => {
    expect(seedOf(new Uint8Array(8))).toBe("0000000000000001");
  });
});

describe(drawDisplay, () => {
  it.each([
    {
      display: {
        layout: "gnome",
        screen: { height: 1050, width: 1680, workArea: { bottom: 0, left: 0, right: 0, top: 32 } },
        window: { kind: "maximized" },
      },
      seed: fixedSeed,
    },
    {
      display: {
        layout: "ubuntu",
        screen: { height: 1200, width: 1920, workArea: { bottom: 0, left: 66, right: 0, top: 32 } },
        window: { height: 879, kind: "floating", width: 1466, x: 243, y: 43 },
      },
      seed: "0000000000000028",
    },
  ])("draws a frozen device from $seed", ({ display, seed }) => {
    expect(drawDisplay(seed)).toStrictEqual(display);
  });

  it("keeps every window inside its work area and at least 1265 px wide over 10,000 seeds", () => {
    const outside = draws(CONTAINMENT_SEEDS).filter(({ screen, window }) => {
      const area = workAreaOf(screen);
      const bounds = windowBounds(screen, window);

      return (
        bounds.width < 1265 ||
        bounds.x < area.x ||
        bounds.y < area.y ||
        bounds.x + bounds.width > area.x + area.width ||
        bounds.y + bounds.height > area.y + area.height
      );
    });

    expect(outside).toStrictEqual([]);
  });

  it("floats only a window of at least 1280 px and 70 to 95% of a work area at least 1680 px wide", () => {
    const misplaced = draws(CONTAINMENT_SEEDS).filter(({ screen, window }) => {
      if (window.kind === "maximized") {
        return false;
      }

      const area = workAreaOf(screen);

      return (
        area.width < 1680 ||
        window.width < 1280 ||
        window.height < area.height * 0.7 ||
        window.height > area.height * 0.95
      );
    });

    expect(misplaced).toStrictEqual([]);
  });

  describe("over 100,000 seeds", () => {
    const displays = draws(FREQUENCY_SEEDS);

    it.each(DESKTOP_SCREENS)("draws $width x $height within one point of its weight", (row) => {
      const drawn = frequency(
        displays,
        ({ screen }) => screen.width === row.width && screen.height === row.height,
      );

      expect(Math.abs(drawn - shareOf(DESKTOP_SCREENS, row))).toBeLessThan(POINT);
    });

    const roomy = displays.filter(({ screen }) => screen.width >= 1366);

    it.each(DESKTOP_LAYOUTS)(
      "draws the $name layout within one point of its weight where every layout fits",
      (row) => {
        const drawn = frequency(roomy, ({ layout }) => layout === row.name);

        expect(Math.abs(drawn - shareOf(DESKTOP_LAYOUTS, row))).toBeLessThan(POINT);
      },
    );

    const floatable = displays.filter(({ screen }) => workAreaOf(screen).width >= 1680);

    it.each(WINDOW_STATES)(
      "draws a $kind window within one point of its weight where a window can float",
      (row) => {
        const drawn = frequency(floatable, ({ window }) => window.kind === row.kind);

        expect(Math.abs(drawn - shareOf(WINDOW_STATES, row))).toBeLessThan(POINT);
      },
    );
  });
});

const launchOf = ({ chosen, expected, inputs, read }: IdentityPlan) => ({
  expected,
  inputs,
  read,
  record: chosen.record,
  timezone: chosen.surfaces.timezone,
});

const DISPLAY_SWITCH = /^--(?:window-size|window-position|screen-info)=/u;

describe("a display the caller narrows", () => {
  it("draws only maximized windows on a pinned work area too short to float one at 88 px", () => {
    const tables = { screens: [{ height: 132, weight: 1, width: 1700 }] };

    const windows = new Set(
      Array.from({ length: 400 }, (_, index) => {
        const { screen, window } = drawDisplay(seedAt(index + 1), tables);

        return `${window.kind} ${windowBounds(screen, window).height}`;
      }),
    );

    expect({ misfit: displayMisfit(tables), windows }).toStrictEqual({
      misfit: undefined,
      windows: new Set(["maximized 100", "maximized 88", "maximized 92"]),
    });
  });

  it("draws any of Xrio's layouts on a pinned screen too narrow for the 1265 px floor", () => {
    const layouts = new Set(
      Array.from(
        { length: 200 },
        (_, index) =>
          drawDisplay(seedAt(index + 1), { screens: [{ height: 768, weight: 1, width: 1024 }] })
            .layout,
      ),
    );

    expect(layouts).toStrictEqual(new Set(["gnome", "ubuntu", "kde", "cinnamon"]));
  });
});

const fixedRecord: DeviceRecord = {
  device: {
    cores: 0,
    fonts: { kind: "system" },
    gpu: { backend: "swiftshader", persona: null },
    memoryGb: 0,
    screen: { height: 1050, width: 1680, workArea: { bottom: 0, left: 0, right: 0, top: 32 } },
    voices: { kind: "system" },
    window: { kind: "maximized" },
  },
  policy: { locale: "en-US", timezone: { kind: "host", zone: "UTC" } },
  schema: 1,
  seed: fixedSeed,
};

describe("the device record", () => {
  const context: IdentityContext = {
    capabilities: { platform: "linux" },
    device: fixedDevice,
    exit: { facts: { kind: "unknown" }, route: "direct" },
    hostZone: "UTC",
    mode: "headless",
    pins: noPins,
  };

  const plan = planIdentity(context);
  const record = fixedRecord;

  it("holds the fixed seed's device and policy, with a pinned device digest", () => {
    expect({ digest: plan.chosen.digests.device, record: plan.chosen.record }).toStrictEqual({
      digest: "86b5a7953a4dbd0eb5cd26213f154086232b261e0cb35988f33c308e3668c366",
      record,
    });
  });

  it("survives storage, as readDeviceRecord reads it back", () => {
    expect(readDeviceRecord(JSON.stringify(record))).toStrictEqual(record);
  });

  it("replays into the same plan, even after the host's zone and the caller's pins move", () => {
    const replayed = planIdentity({
      ...context,
      device: { kind: "record", record },
      hostZone: "Asia/Tokyo",
      pins: { display: undefined, locale: "de-DE", timezone: "America/New_York" },
    });

    expect(launchOf(replayed)).toStrictEqual(launchOf(plan));
    expect(replayed.chosen.surfaces.seed).toStrictEqual({ source: "record" });
  });

  it("replays a pinned zone, a floating window and a device Xrio's tables no longer draw", () => {
    const stored: DeviceRecord = {
      ...record,
      device: {
        ...record.device,
        screen: { height: 1000, width: 1700, workArea: { bottom: 50, left: 0, right: 0, top: 0 } },
        window: { height: 800, kind: "floating", width: 1300, x: 100, y: 60 },
      },
      policy: { locale: "fr-FR", timezone: { kind: "pinned", zone: "Europe/Paris" } },
    };

    const replayed = planIdentity({ ...context, device: { kind: "record", record: stored } });

    expect({
      record: replayed.chosen.record,
      surfaces: replayed.chosen.surfaces,
      switches: replayed.inputs.switches.filter((entry) => DISPLAY_SWITCH.test(entry)),
      zone: replayed.inputs.environment.TZ,
    }).toMatchObject({
      record: stored,
      surfaces: {
        locale: { tag: "fr-FR" },
        screen: { layout: null, size: { height: 1000, width: 1700 }, source: "record" },
        timezone: { source: "pin", zone: "Europe/Paris" },
        window: { height: 800, kind: "floating", source: "record", width: 1300, x: 100, y: 60 },
      },
      switches: [
        "--window-size=1300,800",
        "--window-position=100,60",
        "--screen-info={0,0 1700x1000 colorDepth=24 devicePixelRatio=1 isInternal=0 rotation=0 workAreaLeft=0 workAreaRight=0 workAreaTop=0 workAreaBottom=50}",
      ],
      zone: "Europe/Paris",
    });
  });
});

const hostScreen: Observation = {
  afterCapture: { kind: "not-navigated" },
  anyPointer: "fine",
  availHeight: 1080,
  availLeft: 0,
  availTop: 0,
  availWidth: 1920,
  colorDepth: 24,
  colorScheme: "light",
  devicePixelRatio: 1,
  fontsDigest: null,
  fontsSentinel: "0",
  fontsSentinelResolved: false,
  hover: "hover",
  intlLocale: "en-US",
  languages: ["en-US", "en"],
  maxTouchPoints: 0,
  outerHeight: 900,
  outerWidth: 1600,
  pointer: "fine",
  product: { headless: false, major: 154, version: "154.0.8037.57" },
  reducedMotion: "no-preference",
  requestedOffsets: ["GMT+00:00", "GMT+00:00"],
  requestedZone: "UTC",
  screenHeight: 1080,
  screenWidth: 1920,
  screenX: 10,
  screenY: 10,
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/154.0.0.0 Safari/537.36",
  webdriver: false,
  webgl: true,
  zone: "UTC",
  zoneOffsets: ["GMT+00:00", "GMT+00:00"],
};

const headedContext: IdentityContext = {
  capabilities: { platform: "linux" },
  device: fixedDevice,
  exit: { facts: { kind: "unknown" }, route: "direct" },
  hostZone: "UTC",
  mode: "headed",
  pins: noPins,
};

describe("a headed browser's record", () => {
  it("holds the host display and Chrome's own window it presented, whatever its seed", () => {
    const reports = [fixedSeed, "0000000000000028"].map(
      (seed) =>
        evaluate(planIdentity({ ...headedContext, device: { kind: "fresh", seed } }), hostScreen)
          .report,
    );

    expect(
      reports.map(({ digests, record }) => ({
        device: digests.device,
        screen: record.device.screen,
        window: record.device.window,
      })),
    ).toStrictEqual([
      {
        device: reports[0].digests.device,
        screen: { height: 1080, width: 1920, workArea: { bottom: 0, left: 0, right: 0, top: 0 } },
        window: { kind: "chrome-default" },
      },
      {
        device: reports[0].digests.device,
        screen: { height: 1080, width: 1920, workArea: { bottom: 0, left: 0, right: 0, top: 0 } },
        window: { kind: "chrome-default" },
      },
    ]);
    expect(planIdentity(headedContext).chosen).toMatchObject({
      digests: { device: null },
      record: null,
    });
  });

  it("is refused in headless mode, where Chrome's own window cannot be presented", () => {
    const { record } = evaluate(planIdentity(headedContext), hostScreen).report;

    expect(() =>
      planIdentity({ ...headedContext, device: { kind: "record", record }, mode: "headless" }),
    ).toThrow(
      new DeviceRecordRefusedError({
        field: "device",
        kind: "unreplayable",
        reason: "its window is a headed Chrome's own, which a headless browser cannot present",
      }),
    );
  });

  it("notes a headed replay on another display than the one it stored", () => {
    const { record } = evaluate(planIdentity(headedContext), hostScreen).report;
    const replayed = planIdentity({ ...headedContext, device: { kind: "record", record } });

    expect(
      evaluate(replayed, { ...hostScreen, availWidth: 1366, screenWidth: 1366 }).report.notes,
    ).toStrictEqual([
      { expected: 1366, field: "outerWidth", observed: 1600, surface: "window" },
      { expected: 1920, field: "screenWidth", observed: 1366, surface: "screen" },
      { expected: 1920, field: "availWidth", observed: 1366, surface: "screen" },
    ]);
  });
});

describe("a headed record from a browser off the primary display", () => {
  it.each([
    {
      name: "the primary display under a macOS menu bar",
      observed: { availHeight: 1055, availTop: 25 },
      workArea: { bottom: 0, left: 0, right: 0, top: 25 },
    },
    {
      name: "a display right of the primary",
      observed: { availLeft: 1920 },
      workArea: { bottom: 0, left: 0, right: 0, top: 0 },
    },
    {
      name: "a display left of the primary",
      observed: { availLeft: -1920 },
      workArea: { bottom: 0, left: 0, right: 0, top: 0 },
    },
    {
      name: "a display above the primary",
      observed: { availTop: -1080 },
      workArea: { bottom: 0, left: 0, right: 0, top: 0 },
    },
    {
      name: "a display right of the primary with a bottom panel",
      observed: { availHeight: 1040, availLeft: 1920 },
      workArea: { bottom: 40, left: 0, right: 0, top: 0 },
    },
  ])("reads back from $name", ({ observed, workArea }) => {
    const { record } = evaluate(planIdentity(headedContext), { ...hostScreen, ...observed }).report;

    expect(readDeviceRecord(JSON.stringify(record)).device.screen).toStrictEqual({
      height: 1080,
      width: 1920,
      workArea,
    });
  });
});

describe("a record replayed on another host", () => {
  it("keeps the stored device and tells that the host's GPU or voices differ", () => {
    const replayed = planIdentity({
      ...headedContext,
      capabilities: { platform: "darwin" },
      device: { kind: "record", record: fixedRecord },
      mode: "headless",
    });

    expect({
      gpu: replayed.chosen.surfaces.gpu,
      record: replayed.chosen.record?.device.gpu,
      tells: replayed.tells,
    }).toStrictEqual({
      gpu: { backend: "native" },
      record: { backend: "swiftshader", persona: null },
      tells: ["host-zone-utc", "replay-host-skew"],
    });
  });

  it("records the checked font stack and tells when a host without it replays the record", () => {
    const stacked = planIdentity({
      ...headedContext,
      capabilities: { fontStack: CHECKED_FONT_STACK, platform: "linux" },
      mode: "headless",
    }).chosen.record;

    const replayed = planIdentity({
      ...headedContext,
      device: { kind: "record", record: stacked ?? fixedRecord },
      mode: "headless",
    });

    expect({ fonts: stacked?.device.fonts, tells: replayed.tells }).toStrictEqual({
      fonts: {
        digest: "62bbc5617946311ab21ed9ec8ef22f68a15e4ccf06cebf01aca807fedb1def3d",
        kind: "stack",
      },
      tells: ["host-zone-utc", "host-fonts", "replay-host-skew"],
    });
  });
});

describe("a record made from a scrape's pins", () => {
  const pins = {
    display: {
      screens: [{ height: 900, weight: 1, width: 1440 }],
      taskbars: [{ bottom: 48, left: 0, right: 0, top: 0, weight: 1 }],
      windows: [{ kind: "maximized", weight: 1 }],
    },
    locale: "de-DE",
    timezone: "Europe/Berlin",
  } as const;

  it.each(["headless", "headed"] as const)("never conflicts with those pins in %s mode", (mode) => {
    const context: IdentityContext = { ...headedContext, mode, pins };
    const { record } = evaluate(planIdentity(context), hostScreen).report;
    const replayed = planIdentity({ ...context, device: { kind: "record", record } });

    expect({
      overrides: recordOverrides(record, { mode, pins }),
      unhonored: replayed.tells.includes("display-pin-unhonored"),
    }).toStrictEqual({ overrides: [], unhonored: mode === "headed" });
  });
});
