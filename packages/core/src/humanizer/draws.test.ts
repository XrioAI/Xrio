import { describe, expect, it } from "vite-plus/test";

import { fixedSeed } from "../testing/fixed-seed.ts";
import { drawDisplay, seedOf, windowBounds, workAreaOf } from "./draws.ts";
import type { DrawnDisplay } from "./draws.ts";
import { DESKTOP_LAYOUTS, DESKTOP_SCREENS, WINDOW_STATES } from "./owned-inputs.ts";

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
