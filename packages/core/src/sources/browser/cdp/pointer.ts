import type { PageArea, PagePoint } from "../port.ts";

type Draw = (lowest: number, highest: number) => number;

interface PointerStep {
  readonly at: PagePoint;
  readonly pauseMs: number;
}

interface ClickGesture {
  readonly approach: readonly PointerStep[];
  readonly target: PagePoint;
  readonly hoverMs: number;
  readonly holdMs: number;
}

const LEAD_IN_PX = { longest: 120, shortest: 40 } as const;

const LEAD_IN_DRIFT_PX = 24;

const PX_PER_STEP = 10;

const STEPS = { fewest: 5, most: 14 } as const;

const BEND_PERCENT = 15;

const PERCENT = 100;

const STEP_PAUSE_MS = { longest: 20, shortest: 8 } as const;

const HOVER_MS = { longest: 260, shortest: 90 } as const;

const HOLD_MS = { longest: 130, shortest: 60 } as const;

const coordinateWithin = (start: number, length: number, draw: Draw): number => {
  const lowest = Math.ceil(start);
  const highest = Math.floor(start + length);

  return highest < lowest ? Math.round(start + length / 2) : draw(lowest, highest);
};

const pointWithin = (area: PageArea, draw: Draw): PagePoint => ({
  x: coordinateWithin(area.x, area.width, draw),
  y: coordinateWithin(area.y, area.height, draw),
});

const leadInTo = (target: PagePoint, draw: Draw): PagePoint => ({
  x: target.x + draw(LEAD_IN_PX.shortest, LEAD_IN_PX.longest),
  y: Math.max(0, target.y + draw(-LEAD_IN_DRIFT_PX, LEAD_IN_DRIFT_PX)),
});

const easeInOut = (progress: number): number => 0.5 - Math.cos(Math.PI * progress) / 2;

const stepsAcross = (distance: number): number =>
  Math.min(STEPS.most, Math.max(STEPS.fewest, Math.round(distance / PX_PER_STEP)));

const quadraticAt = (start: number, pull: number, end: number, along: number): number => {
  const before = 1 - along;

  return Math.round(before * before * start + 2 * before * along * pull + along * along * end);
};

const curveFrom = (from: PagePoint, to: PagePoint, draw: Draw): PagePoint[] => {
  const across = { x: to.x - from.x, y: to.y - from.y };
  const steps = stepsAcross(Math.hypot(across.x, across.y));
  const bend = draw(-BEND_PERCENT, BEND_PERCENT) / PERCENT;

  const pull = {
    x: (from.x + to.x) / 2 - bend * across.y,
    y: (from.y + to.y) / 2 + bend * across.x,
  };

  return Array.from({ length: steps }, (_unused, index) => {
    const along = easeInOut((index + 1) / steps);

    return {
      x: quadraticAt(from.x, pull.x, to.x, along),
      y: quadraticAt(from.y, pull.y, to.y, along),
    };
  });
};

const withoutRepeats = (points: readonly PagePoint[]): PagePoint[] =>
  points.filter(
    (point, index) =>
      index === 0 || point.x !== points[index - 1]?.x || point.y !== points[index - 1]?.y,
  );

export const planClick = (
  pointer: PagePoint | undefined,
  area: PageArea,
  draw: Draw,
): ClickGesture => {
  const target = pointWithin(area, draw);
  const from = pointer ?? leadInTo(target, draw);
  const entry = pointer === undefined ? [from] : [];
  const path = withoutRepeats([...entry, ...curveFrom(from, target, draw)]);

  return {
    approach: path.map((at) => ({
      at,
      pauseMs: draw(STEP_PAUSE_MS.shortest, STEP_PAUSE_MS.longest),
    })),
    holdMs: draw(HOLD_MS.shortest, HOLD_MS.longest),
    hoverMs: draw(HOVER_MS.shortest, HOVER_MS.longest),
    target,
  };
};
