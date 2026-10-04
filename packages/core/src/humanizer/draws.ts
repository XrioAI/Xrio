import { createHash } from "node:crypto";

import type { Insets, PresentedDevice, Seed, WindowState } from "./contracts.ts";
import { DESKTOP_LAYOUTS, DESKTOP_SCREENS, WINDOW_STATES } from "./owned-inputs.ts";

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

export interface Bounds {
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
}

type DrawnWindow = Exclude<WindowState, { kind: "chrome-default" }>;

export interface DrawnDisplay {
  readonly screen: PresentedDevice["screen"];
  readonly layout: string;
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

const floatingIn = (seed: Seed, area: Bounds): DrawnWindow => {
  const width = between(seed, "window-width", MIN_FLOATING_WIDTH, area.width);

  const height = between(
    seed,
    "window-height",
    Math.ceil(area.height * FLOATING_HEIGHT.min),
    Math.floor(area.height * FLOATING_HEIGHT.max),
  );

  return {
    height,
    kind: "floating",
    width,
    x: between(seed, "window-x", area.x, area.x + area.width - width),
    y: between(seed, "window-y", area.y, area.y + area.height - height),
  };
};

const drawWindow = (seed: Seed, screen: PresentedDevice["screen"]): DrawnWindow => {
  const area = workAreaOf(screen);
  const floats = area.width >= MIN_FLOATING_WORK_WIDTH;

  return floats && pick(WINDOW_STATES, seed, "window").kind === "floating"
    ? floatingIn(seed, area)
    : { kind: "maximized" };
};

export const drawDisplay = (seed: Seed): DrawnDisplay => {
  const { height, width } = pick(DESKTOP_SCREENS, seed, "screen");

  const layouts = DESKTOP_LAYOUTS.filter(({ insets }) => keepsDesktopLayout(width, insets));
  const { insets, name } = pick(layouts, seed, "layout");
  const screen = { height, width, workArea: { ...insets } };

  return { layout: name, screen, window: drawWindow(seed, screen) };
};
