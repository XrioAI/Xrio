import { createHash } from "node:crypto";

import { CHROME_MIN_WINDOW } from "./contracts.ts";
import type {
  DisplayTables,
  HardwareTables,
  Insets,
  PresentedDevice,
  Seed,
  WindowPin,
  WindowState,
} from "./contracts.ts";
import {
  DESKTOP_LAYOUTS,
  DESKTOP_SCREENS,
  MACHINE_CLASSES,
  WINDOW_STATES,
} from "./owned-inputs.ts";

export const SEED_BYTES = 8;

const DRAW_DOMAIN = "xrio-identity/v1";

const UNIT_BITS = 53;

const DROPPED_BITS = 2n ** BigInt(64 - UNIT_BITS);

const UNIT_SCALE = 2 ** UNIT_BITS;

const ZERO_SEED = /^0+$/u;

const MIN_INNER_WIDTH = 1265;

const MIN_FLOATING_WORK_WIDTH = 1680;

const MIN_FLOATING_WIDTH = 1280;

const FLOATING_HEIGHT = { max: 0.95, min: 0.7 } as const;

export const seedOf = (bytes: Uint8Array): Seed => {
  const hex = Buffer.from(bytes).toString("hex");

  return ZERO_SEED.test(hex) ? `${"0".repeat(hex.length - 1)}1` : hex;
};

const draw = (seed: Seed, purpose: string): bigint =>
  createHash("sha256").update(`${DRAW_DOMAIN}\0${purpose}\0${seed}`).digest().readBigUInt64BE(0);

const unit = (seed: Seed, purpose: string): number =>
  Number(draw(seed, purpose) / DROPPED_BITS) / UNIT_SCALE;

const between = (seed: Seed, purpose: string, min: number, max: number): number =>
  min + Math.floor(unit(seed, purpose) * (max - min + 1));

interface Weighted {
  readonly weight: number;
}

const pick = <Row extends Weighted>(rows: readonly Row[], seed: Seed, purpose: string): Row => {
  const total = rows.reduce((sum, { weight }) => sum + weight, 0);
  let remaining = unit(seed, purpose) * total;

  for (const row of rows) {
    remaining -= row.weight;

    if (remaining < 0) {
      return row;
    }
  }

  const last = rows.at(-1);

  if (last === undefined) {
    throw new Error(`The ${purpose} draw has no rows.`);
  }

  return last;
};

type MachineClass = (typeof MACHINE_CLASSES)[number];

const pinnedValue = (
  rows: readonly (Weighted & { readonly value: number })[] | undefined,
  seed: Seed,
  purpose: string,
): number | undefined => (rows === undefined ? undefined : pick(rows, seed, purpose).value);

export interface DrawnHardware {
  readonly cores: number;
  readonly memoryGb: number;
  readonly source: "drawn" | "pinned";
  readonly capped: boolean;
}

export const drawHardware = (
  seed: Seed,
  tables: HardwareTables = {},
  ceilings: readonly number[] = [],
): DrawnHardware | undefined => {
  const eligible = MACHINE_CLASSES.filter(({ cores }) =>
    ceilings.every((ceiling) => cores <= ceiling),
  );

  const cores = pinnedValue(tables.cores, seed, "hardware-cores");
  const memoryGb = pinnedValue(tables.memoryGb, seed, "hardware-memory");

  if (cores !== undefined && memoryGb !== undefined) {
    return { capped: false, cores, memoryGb, source: "pinned" };
  }

  const pool = cores === undefined ? eligible : MACHINE_CLASSES;

  const rowsFrom = (candidates: readonly MachineClass[]): readonly MachineClass[] => {
    const agreeing = candidates.filter(
      (row) =>
        (cores === undefined || row.cores === cores) &&
        (memoryGb === undefined || row.memoryGb === memoryGb),
    );

    return agreeing.length > 0 ? agreeing : candidates;
  };

  const rows = rowsFrom(pool);
  const uncapped = rowsFrom(MACHINE_CLASSES);

  if (rows.length === 0) {
    return memoryGb === undefined
      ? undefined
      : { capped: true, cores: Math.min(...ceilings), memoryGb, source: "pinned" };
  }

  const row = pick(rows, seed, "hardware");

  return {
    capped:
      rows.length !== uncapped.length || rows.some((candidate) => !uncapped.includes(candidate)),
    cores: cores ?? row.cores,
    memoryGb: memoryGb ?? row.memoryGb,
    source: cores === undefined && memoryGb === undefined ? "drawn" : "pinned",
  };
};

export interface Bounds {
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
}

type DrawnWindow = Exclude<WindowState, { kind: "chrome-default" }>;

export interface DrawnDisplay {
  readonly screen: PresentedDevice["screen"];
  readonly layout: string | null;
  readonly window: DrawnWindow;
}

export const workAreaOf = ({ height, width, workArea }: PresentedDevice["screen"]): Bounds => ({
  height: height - workArea.top - workArea.bottom,
  width: width - workArea.left - workArea.right,
  x: workArea.left,
  y: workArea.top,
});

export const windowBounds = (screen: PresentedDevice["screen"], window: DrawnWindow): Bounds =>
  window.kind === "maximized" ? workAreaOf(screen) : window;

const keepsDesktopLayout = (width: number, insets: Insets): boolean =>
  width - insets.left - insets.right >= MIN_INNER_WIDTH;

const insetsOf = ({ bottom, left, right, top }: Insets): Insets => ({ bottom, left, right, top });

interface Layout {
  readonly name: string | null;
  readonly insets: Insets;
  readonly weight: number;
}

const desktopLayoutsFor = (width: number): readonly Layout[] => {
  const fitting = DESKTOP_LAYOUTS.filter(({ insets }) => keepsDesktopLayout(width, insets));

  return fitting.length > 0 ? fitting : DESKTOP_LAYOUTS;
};

const layoutsFor = (width: number, { taskbars }: DisplayTables): readonly Layout[] =>
  taskbars === undefined
    ? desktopLayoutsFor(width)
    : taskbars.map((row) => ({ insets: insetsOf(row), name: null, weight: row.weight }));

const placedIn = (seed: Seed, area: Bounds, width: number, height: number): DrawnWindow => ({
  height,
  kind: "floating",
  width,
  x: between(seed, "window-x", area.x, area.x + area.width - width),
  y: between(seed, "window-y", area.y, area.y + area.height - height),
});

const floatingIn = (seed: Seed, area: Bounds): DrawnWindow =>
  placedIn(
    seed,
    area,
    between(seed, "window-width", MIN_FLOATING_WIDTH, area.width),
    between(
      seed,
      "window-height",
      Math.ceil(area.height * FLOATING_HEIGHT.min),
      Math.floor(area.height * FLOATING_HEIGHT.max),
    ),
  );

const floats = (area: Bounds): boolean =>
  area.width >= MIN_FLOATING_WORK_WIDTH &&
  Math.ceil(area.height * FLOATING_HEIGHT.min) >= CHROME_MIN_WINDOW.height;

const drawWindow = (seed: Seed, area: Bounds): DrawnWindow =>
  floats(area) && pick(WINDOW_STATES, seed, "window").kind === "floating"
    ? floatingIn(seed, area)
    : { kind: "maximized" };

const pinnedWindow = (seed: Seed, area: Bounds, pin: WindowPin): DrawnWindow => {
  if (pin.kind === "maximized") {
    return { kind: "maximized" };
  }

  return pin.position === undefined
    ? placedIn(seed, area, pin.width, pin.height)
    : { height: pin.height, kind: "floating", width: pin.width, ...pin.position };
};

export const drawDisplay = (seed: Seed, tables: DisplayTables = {}): DrawnDisplay => {
  const { height, width } = pick(tables.screens ?? DESKTOP_SCREENS, seed, "screen");
  const { insets, name } = pick(layoutsFor(width, tables), seed, "layout");
  const screen = { height, width, workArea: insetsOf(insets) };
  const area = workAreaOf(screen);

  const window =
    tables.windows === undefined
      ? drawWindow(seed, area)
      : pinnedWindow(seed, area, pick(tables.windows, seed, "window"));

  return { layout: name, screen, window };
};

const describeArea = (area: Bounds, screen: PresentedDevice["screen"]): string =>
  `the ${area.width}x${area.height} work area at ${area.x},${area.y} of a ${screen.width}x${screen.height} screen`;

const contains = (area: Bounds, window: Bounds): boolean =>
  window.x >= area.x &&
  window.y >= area.y &&
  window.x + window.width <= area.x + area.width &&
  window.y + window.height <= area.y + area.height;

const boundsOf = (area: Bounds, pin: WindowPin): Bounds =>
  pin.kind === "maximized"
    ? area
    : { height: pin.height, width: pin.width, ...(pin.position ?? { x: area.x, y: area.y }) };

const misfitOf = (screen: PresentedDevice["screen"], pin: WindowPin): string | undefined => {
  const area = workAreaOf(screen);
  const window = boundsOf(area, pin);
  const size = `${window.width}x${window.height}`;

  if (window.width < CHROME_MIN_WINDOW.width || window.height < CHROME_MIN_WINDOW.height) {
    return `display leaves a ${size} window in ${describeArea(area, screen)}, under Chrome's ${CHROME_MIN_WINDOW.width}x${CHROME_MIN_WINDOW.height} px minimum window.`;
  }

  return contains(area, window)
    ? undefined
    : `display window ${size} at ${window.x},${window.y} does not fit ${describeArea(area, screen)}.`;
};

const MAXIMIZED: readonly WindowPin[] = [{ kind: "maximized" }];

export const displayMisfit = (tables: DisplayTables): string | undefined => {
  for (const { height, width } of tables.screens ?? DESKTOP_SCREENS) {
    for (const { insets } of layoutsFor(width, tables)) {
      const screen = { height, width, workArea: insetsOf(insets) };

      for (const pin of tables.windows ?? MAXIMIZED) {
        const misfit = misfitOf(screen, pin);

        if (misfit !== undefined) {
          return misfit;
        }
      }
    }
  }

  return undefined;
};
