import { createHash } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { CHECKED_FONT_STACK } from "../testing/fake-font-stack.ts";
import { fixedDevice, fixedSeed } from "../testing/fixed-seed.ts";
import { forkWithKnobs } from "../testing/hardware-fork.ts";
import { noPins } from "../testing/no-pins.ts";
import type { DeviceRecord, Observation } from "./contracts.ts";
import {
  displayMisfit,
  drawDisplay,
  drawHardware,
  seedOf,
  windowBounds,
  workAreaOf,
} from "./draws.ts";
import type { DrawnDisplay } from "./draws.ts";
import { planIdentity } from "./humanizer.ts";
import type { IdentityPlan } from "./humanizer.ts";
import {
  DESKTOP_LAYOUTS,
  DESKTOP_SCREENS,
  MACHINE_CLASSES,
  WINDOW_STATES,
} from "./owned-inputs.ts";
import { recordOverrides } from "./surfaces.ts";
import type { IdentityContext } from "./surfaces.ts";
import { evaluate } from "./verify.ts";

const CONTAINMENT_SEEDS = 10_000;

const FREQUENCY_SEEDS = 100_000;

const POINT = 0.01;

const seedAt = (index: number): string => index.toString(16).padStart(16, "0");

const PARENT_DISPLAY_DIGEST = "0072162c4e7b714f1ffb1b536c8ab71ad4837de2c068149d29faa6d4213c7360";

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

const planFor = (seed: string, capabilities: IdentityContext["capabilities"]) =>
  planIdentity({
    capabilities,
    device: { kind: "fresh", seed },
    exit: { facts: { kind: "unknown" }, route: "direct" },
    hostZone: "UTC",
    mode: "headless",
    pins: noPins,
  }).chosen.surfaces;

const DISPLAY_GOLDEN = [
  {
    screen: {
      layout: "gnome",
      size: {
        height: 1024,
        width: 1280,
      },
      source: "drawn",
      workArea: {
        bottom: 0,
        left: 0,
        right: 0,
        top: 32,
      },
    },
    seed: "0000000000000001",
    window: {
      height: 992,
      kind: "maximized",
      source: "drawn",
      width: 1280,
      x: 0,
      y: 32,
    },
  },
  {
    screen: {
      layout: "gnome",
      size: {
        height: 900,
        width: 1440,
      },
      source: "drawn",
      workArea: {
        bottom: 0,
        left: 0,
        right: 0,
        top: 32,
      },
    },
    seed: "0000000000000002",
    window: {
      height: 868,
      kind: "maximized",
      source: "drawn",
      width: 1440,
      x: 0,
      y: 32,
    },
  },
  {
    screen: {
      layout: "gnome",
      size: {
        height: 900,
        width: 1600,
      },
      source: "drawn",
      workArea: {
        bottom: 0,
        left: 0,
        right: 0,
        top: 32,
      },
    },
    seed: "0000000000000003",
    window: {
      height: 868,
      kind: "maximized",
      source: "drawn",
      width: 1600,
      x: 0,
      y: 32,
    },
  },
  {
    screen: {
      layout: "kde",
      size: {
        height: 800,
        width: 1280,
      },
      source: "drawn",
      workArea: {
        bottom: 44,
        left: 0,
        right: 0,
        top: 0,
      },
    },
    seed: "0000000000000005",
    window: {
      height: 756,
      kind: "maximized",
      source: "drawn",
      width: 1280,
      x: 0,
      y: 0,
    },
  },
  {
    screen: {
      layout: "cinnamon",
      size: {
        height: 1080,
        width: 1920,
      },
      source: "drawn",
      workArea: {
        bottom: 40,
        left: 0,
        right: 0,
        top: 0,
      },
    },
    seed: "0000000000000008",
    window: {
      height: 1040,
      kind: "maximized",
      source: "drawn",
      width: 1920,
      x: 0,
      y: 0,
    },
  },
  {
    screen: {
      layout: "kde",
      size: {
        height: 900,
        width: 1440,
      },
      source: "drawn",
      workArea: {
        bottom: 44,
        left: 0,
        right: 0,
        top: 0,
      },
    },
    seed: "000000000000000d",
    window: {
      height: 856,
      kind: "maximized",
      source: "drawn",
      width: 1440,
      x: 0,
      y: 0,
    },
  },
  {
    screen: {
      layout: "gnome",
      size: {
        height: 900,
        width: 1440,
      },
      source: "drawn",
      workArea: {
        bottom: 0,
        left: 0,
        right: 0,
        top: 32,
      },
    },
    seed: "0000000000000015",
    window: {
      height: 868,
      kind: "maximized",
      source: "drawn",
      width: 1440,
      x: 0,
      y: 32,
    },
  },
  {
    screen: {
      layout: "cinnamon",
      size: {
        height: 1200,
        width: 1920,
      },
      source: "drawn",
      workArea: {
        bottom: 40,
        left: 0,
        right: 0,
        top: 0,
      },
    },
    seed: "0000000000000022",
    window: {
      height: 1160,
      kind: "maximized",
      source: "drawn",
      width: 1920,
      x: 0,
      y: 0,
    },
  },
  {
    screen: {
      layout: "gnome",
      size: {
        height: 1080,
        width: 1920,
      },
      source: "drawn",
      workArea: {
        bottom: 0,
        left: 0,
        right: 0,
        top: 32,
      },
    },
    seed: "0000000000000059",
    window: {
      height: 829,
      kind: "floating",
      source: "drawn",
      width: 1396,
      x: 2,
      y: 166,
    },
  },
  {
    screen: {
      layout: "ubuntu",
      size: {
        height: 1080,
        width: 1920,
      },
      source: "drawn",
      workArea: {
        bottom: 0,
        left: 66,
        right: 0,
        top: 32,
      },
    },
    seed: "000000000000063d",
    window: {
      height: 829,
      kind: "floating",
      source: "drawn",
      width: 1635,
      x: 181,
      y: 136,
    },
  },
  {
    screen: {
      layout: "cinnamon",
      size: {
        height: 1080,
        width: 1920,
      },
      source: "drawn",
      workArea: {
        bottom: 40,
        left: 0,
        right: 0,
        top: 0,
      },
    },
    seed: "0000000000006ff1",
    window: {
      height: 821,
      kind: "floating",
      source: "drawn",
      width: 1879,
      x: 13,
      y: 114,
    },
  },
  {
    screen: {
      layout: "kde",
      size: {
        height: 1080,
        width: 1920,
      },
      source: "drawn",
      workArea: {
        bottom: 44,
        left: 0,
        right: 0,
        top: 0,
      },
    },
    seed: "0000000000012511",
    window: {
      height: 817,
      kind: "floating",
      source: "drawn",
      width: 1790,
      x: 62,
      y: 5,
    },
  },
] as const;

const single = (value: number) => [{ value, weight: 1 }];

describe(drawHardware, () => {
  it.each([
    { permitted: 32, row: { capped: false, cores: 6, memoryGb: 16, source: "drawn" } },
    { permitted: 24, row: { capped: false, cores: 6, memoryGb: 16, source: "drawn" } },
    { permitted: 12, row: { capped: true, cores: 6, memoryGb: 16, source: "drawn" } },
    { permitted: 8, row: { capped: true, cores: 8, memoryGb: 8, source: "drawn" } },
    { permitted: 6, row: { capped: true, cores: 4, memoryGb: 8, source: "drawn" } },
    { permitted: 4, row: { capped: true, cores: 4, memoryGb: 8, source: "drawn" } },
    { permitted: 2, row: undefined },
  ])(
    "draws $row for the fixed seed on a host that permits $permitted CPUs",
    ({ permitted, row }) => {
      expect(drawHardware(fixedSeed, undefined, [permitted])).toStrictEqual(row);
    },
  );

  it("filters the rows before the roll, so every ceiling renormalises the weights that remain", () => {
    const permitted = [32, 12, 6];

    for (const ceiling of permitted) {
      const rows = MACHINE_CLASSES.filter(({ cores }) => cores <= ceiling);
      const total = rows.reduce((sum, { weight }) => sum + weight, 0);

      const counts = new Map<string, number>();

      for (let index = 1; index <= FREQUENCY_SEEDS; index += 1) {
        const drawn = drawHardware(seedAt(index), undefined, [ceiling]);
        const key = `${drawn?.cores}/${drawn?.memoryGb}`;

        counts.set(key, (counts.get(key) ?? 0) + 1);
      }

      expect([...counts.keys()].toSorted()).toStrictEqual(
        rows.map(({ cores, memoryGb }) => `${cores}/${memoryGb}`).toSorted(),
      );

      for (const row of rows) {
        const drawn = (counts.get(`${row.cores}/${row.memoryGb}`) ?? 0) / FREQUENCY_SEEDS;

        expect(Math.abs(drawn - row.weight / total)).toBeLessThan(POINT);
      }
    }
  });

  it("never draws more cores than any ceiling in the list allows", () => {
    for (let index = 1; index <= CONTAINMENT_SEEDS; index += 1) {
      expect(drawHardware(seedAt(index), undefined, [16, 12])?.cores).toBeLessThanOrEqual(12);
    }
  });

  it.each(DISPLAY_GOLDEN)(
    "draws the display the parent commit drew for $seed, whatever the hardware draw",
    ({ screen, seed, window }) => {
      const drawn = planFor(seed, forkWithKnobs());

      expect({ screen: drawn.screen, window: drawn.window }).toStrictEqual({ screen, window });
    },
  );

  it("draws the display the parent commit drew for each of 10,000 seeds", () => {
    const lines = draws(CONTAINMENT_SEEDS).map((drawn) => JSON.stringify(drawn));

    expect(createHash("sha256").update(lines.join("\n")).digest("hex")).toBe(PARENT_DISPLAY_DIGEST);
  });

  it.each([
    {
      ceilings: [3],
      name: "a pinned memory on a host under the smallest row presents it with the host's CPUs as cores",
      row: { capped: true, cores: 3, memoryGb: 16, source: "pinned" },
      tables: { memoryGb: single(16) },
    },
    {
      ceilings: [6],
      name: "a pinned memory no row has caps when the ceiling trims the rows it draws from",
      row: { capped: true, cores: 4, memoryGb: 2, source: "pinned" },
      tables: { memoryGb: single(2) },
    },
    {
      ceilings: [4],
      name: "a pinned 4 GB no row has caps to the one row under the ceiling",
      row: { capped: true, cores: 4, memoryGb: 4, source: "pinned" },
      tables: { memoryGb: single(4) },
    },
    {
      ceilings: [8],
      name: "a pinned 8 GB caps nothing when the ceiling keeps every row with 8 GB",
      row: { capped: false, cores: 4, memoryGb: 8, source: "pinned" },
      tables: { memoryGb: single(8) },
    },
    {
      ceilings: [16, 2],
      name: "a pinned memory under an unsorted ceiling list obeys the smallest ceiling",
      row: { capped: true, cores: 2, memoryGb: 16, source: "pinned" },
      tables: { memoryGb: single(16) },
    },
    {
      ceilings: [32],
      name: "a pinned memory under a ceiling that removes no row caps nothing",
      row: { capped: false, cores: 12, memoryGb: 32, source: "pinned" },
      tables: { memoryGb: single(32) },
    },
    {
      ceilings: [8],
      name: "a pinned memory caps only when the ceiling removed a row with that memory",
      row: { capped: true, cores: 6, memoryGb: 16, source: "pinned" },
      tables: { memoryGb: single(16) },
    },
    {
      name: "a pinned core count draws its memory from the rows with those cores",
      row: { capped: false, cores: 12, memoryGb: 16, source: "pinned" },
      tables: { cores: single(12) },
    },
    {
      name: "a pinned memory draws its cores from the rows with that memory",
      row: { capped: false, cores: 12, memoryGb: 32, source: "pinned" },
      tables: { memoryGb: single(32) },
    },
    {
      ceilings: [6],
      name: "a pinned memory with no row under the ceiling draws its cores from the rows that remain",
      row: { capped: true, cores: 4, memoryGb: 32, source: "pinned" },
      tables: { memoryGb: single(32) },
    },
    {
      name: "a core count Xrio's rows never name draws its memory from all of them",
      row: { capped: false, cores: 3, memoryGb: 16, source: "pinned" },
      tables: { cores: single(3) },
    },
    {
      ceilings: [6],
      name: "a pinned core count ignores the ceiling",
      row: { capped: false, cores: 16, memoryGb: 16, source: "pinned" },
      tables: { cores: single(16) },
    },
    {
      ceilings: [2],
      name: "both fields pinned ignore the ceiling and Xrio's rows",
      row: { capped: false, cores: 3, memoryGb: 32, source: "pinned" },
      tables: { cores: single(3), memoryGb: single(32) },
    },
    {
      name: "a weighted table of cores replaces Xrio's weights",
      row: { capped: false, cores: 4, memoryGb: 8, source: "pinned" },
      tables: {
        cores: [
          { value: 4, weight: 1 },
          { value: 8, weight: 3 },
        ],
      },
    },
  ])("gives $name", ({ ceilings = [32], row, tables }) => {
    expect(drawHardware(fixedSeed, tables, ceilings)).toStrictEqual(row);
  });

  it("draws a pinned 8 GB's row as it would with no ceiling when the ceiling removes none of its rows", () => {
    expect(drawHardware(fixedSeed, { memoryGb: single(8) }, [8])).toStrictEqual(
      drawHardware(fixedSeed, { memoryGb: single(8) }),
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
    capabilities: { permittedCpus: 32, platform: "linux" },
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

  it("replays into the same plan, even after the host's zone and the caller's pins move", () => {
    const replayed = planIdentity({
      ...context,
      device: { kind: "record", record },
      hostZone: "Asia/Tokyo",
      pins: {
        display: undefined,
        hardware: undefined,
        locale: "de-DE",
        timezone: "America/New_York",
      },
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
  hardwareConcurrency: 32,
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
  capabilities: { permittedCpus: 32, platform: "linux" },
  device: fixedDevice,
  exit: { facts: { kind: "unknown" }, route: "direct" },
  hostZone: "UTC",
  mode: "headed",
  pins: noPins,
};

const recorded = (plan: IdentityPlan) => {
  const { cores, memoryGb } = evaluate(plan, {
    ...hostScreen,
    hardwareConcurrency: plan.chosen.surfaces.hardware.cores,
  }).report.record.device;

  return { cores, memoryGb };
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

  it("holds the drawn cores and memory the fork presented, and none where the host's own showed", () => {
    const forked = planIdentity({ ...headedContext, capabilities: forkWithKnobs() });
    const stock = planIdentity(headedContext);

    expect([recorded(forked), recorded(stock)]).toStrictEqual([
      { cores: 6, memoryGb: 16 },
      { cores: 0, memoryGb: 0 },
    ]);
  });

  it("is refused in headless mode, where Chrome's own window cannot be presented", () => {
    const { record } = evaluate(planIdentity(headedContext), hostScreen).report;

    expect(() =>
      planIdentity({ ...headedContext, device: { kind: "record", record }, mode: "headless" }),
    ).toThrow(
      expect.objectContaining({
        name: "DeviceRecordRefusedError",
        refusal: {
          field: "device",
          kind: "unreplayable",
          reason: "its window is a headed Chrome's own, which a headless browser cannot present",
        },
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

    expect(record.device.screen).toStrictEqual({
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
      capabilities: { permittedCpus: 32, platform: "darwin" },
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
      tells: ["host-zone-utc", "hardware-unhonored", "replay-host-skew"],
    });
  });

  it("records the checked font stack and tells when a host without it replays the record", () => {
    const stacked = planIdentity({
      ...headedContext,
      capabilities: { fontStack: CHECKED_FONT_STACK, permittedCpus: 32, platform: "linux" },
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
      tells: ["host-zone-utc", "hardware-unhonored", "host-fonts", "replay-host-skew"],
    });
  });
});

const replayedOn = (record: DeviceRecord, capabilities: IdentityContext["capabilities"]) => {
  const plan = planIdentity({
    capabilities,
    device: { kind: "record", record },
    exit: { facts: { kind: "unknown" }, route: "direct" },
    hostZone: "UTC",
    mode: "headless",
    pins: noPins,
  });

  return {
    cores: plan.inputs.switches.filter((entry) => entry.startsWith("--xrio-")),
    hardware: plan.chosen.surfaces.hardware,
    tells: plan.tells.filter(
      (tell) => tell === "replay-host-skew" || tell === "hardware-unhonored",
    ),
  };
};

const stored = (cores: number, memoryGb: number): DeviceRecord => ({
  ...fixedRecord,
  device: { ...fixedRecord.device, cores, memoryGb },
});

describe("a record replayed with another core count or memory", () => {
  it("presents the stored cores and memory on a host that permits them, with no skew", () => {
    expect(replayedOn(stored(12, 16), forkWithKnobs(undefined, 12))).toStrictEqual({
      cores: ["--xrio-hardware-concurrency=12", "--xrio-device-memory=16"],
      hardware: { cores: 12, memoryGb: 16, source: "record" },
      tells: [],
    });
  });

  it("still presents cores a host does not permit, and tells replay-host-skew", () => {
    expect(replayedOn(stored(12, 16), forkWithKnobs(undefined, 8))).toStrictEqual({
      cores: ["--xrio-hardware-concurrency=12", "--xrio-device-memory=16"],
      hardware: { cores: 12, memoryGb: 16, source: "record" },
      tells: ["replay-host-skew"],
    });
  });

  it("tells replay-host-skew where a stock binary shows the host's values instead", () => {
    expect(replayedOn(stored(12, 16), { permittedCpus: 32, platform: "linux" })).toStrictEqual({
      cores: [],
      hardware: { cores: 0, memoryGb: 0, source: "host" },
      tells: ["hardware-unhonored", "replay-host-skew"],
    });
  });

  it("sends nothing, tells hardware-unhonored and no skew for a record made where the host's values showed", () => {
    expect(replayedOn(stored(0, 0), forkWithKnobs())).toStrictEqual({
      cores: [],
      hardware: { cores: 0, memoryGb: 0, source: "host" },
      tells: ["hardware-unhonored"],
    });
  });

  it("keeps the host's values and tells hardware-unhonored for that record under any hardware pin", () => {
    const plan = planIdentity({
      capabilities: forkWithKnobs(),
      device: { kind: "record", record: stored(0, 0) },
      exit: { facts: { kind: "unknown" }, route: "direct" },
      hostZone: "UTC",
      mode: "headless",
      pins: { ...noPins, hardware: { cores: single(8), memoryGb: single(16) } },
    });

    expect({ hardware: plan.chosen.surfaces.hardware, tells: plan.tells }).toStrictEqual({
      hardware: { cores: 0, memoryGb: 0, source: "host" },
      tells: ["host-zone-utc", "hardware-unhonored", "host-fonts"],
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
    hardware: undefined,
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
