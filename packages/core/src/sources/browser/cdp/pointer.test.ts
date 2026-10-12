import { describe, expect, it } from "vite-plus/test";

import { planClick } from "./pointer.ts";

const lowest = (low: number): number => low;

const highest = (_low: number, high: number): number => high;

const CHECKBOX = { height: 10, width: 10, x: 123, y: 147.5 } as const;

const pointsOf = (gesture: ReturnType<typeof planClick>) => gesture.approach.map(({ at }) => at);

describe("a planned click", () => {
  it("enters beside the area, curves onto a whole pixel inside it, then hovers and holds", () => {
    expect(planClick(undefined, CHECKBOX, lowest)).toStrictEqual({
      approach: [
        { at: { x: 163, y: 124 }, pauseMs: 8 },
        { at: { x: 160, y: 127 }, pauseMs: 8 },
        { at: { x: 151, y: 135 }, pauseMs: 8 },
        { at: { x: 138, y: 142 }, pauseMs: 8 },
        { at: { x: 127, y: 147 }, pauseMs: 8 },
        { at: { x: 123, y: 148 }, pauseMs: 8 },
      ],
      holdMs: 60,
      hoverMs: 90,
      target: { x: 123, y: 148 },
    });
  });

  it("enters at most 120 px right of the target and takes more steps over the longer way", () => {
    const gesture = planClick(undefined, CHECKBOX, highest);

    expect({
      entry: gesture.approach[0]?.at,
      holdMs: gesture.holdMs,
      hoverMs: gesture.hoverMs,
      landing: gesture.approach.at(-1)?.at,
      moves: gesture.approach.length,
      pauses: [...new Set(gesture.approach.map(({ pauseMs }) => pauseMs))],
      target: gesture.target,
    }).toStrictEqual({
      entry: { x: 253, y: 181 },
      holdMs: 130,
      hoverMs: 260,
      landing: { x: 133, y: 157 },
      moves: 13,
      pauses: [20],
      target: { x: 133, y: 157 },
    });
  });

  it("starts from where the pointer rests, without moving onto that point again", () => {
    expect(pointsOf(planClick({ x: 128, y: 152 }, CHECKBOX, lowest))).toStrictEqual([
      { x: 127, y: 152 },
      { x: 126, y: 151 },
      { x: 124, y: 150 },
      { x: 123, y: 149 },
      { x: 123, y: 148 },
    ]);
  });

  it("aims at the centre of an area narrower than a pixel and enters no higher than the page top", () => {
    const gesture = planClick(undefined, { height: 0.4, width: 0.5, x: 10.2, y: 20.3 }, lowest);

    expect(gesture.target).toStrictEqual({ x: 10, y: 21 });
    expect(gesture.approach[0]?.at).toStrictEqual({ x: 50, y: 0 });
  });
});
