import type { BlockVerdict } from "../blocks/classify.ts";

export type Warmth = "cold" | "contacted" | "warm" | "cooling";

export interface SiteWarmth {
  readonly state: Warmth;
  readonly lastVisitAt: number;
}

export const DEFAULT_WARMTH_MAX_AGE_MS = 30 * 60 * 1000;

export const warmthAt = (history: SiteWarmth | undefined, now: number, maxAgeMs: number): Warmth =>
  history === undefined || history.lastVisitAt > now || now - history.lastVisitAt > maxAgeMs
    ? "cold"
    : history.state;

export const warmthAfter = (before: Warmth, verdict: BlockVerdict): Warmth => {
  if (verdict === "ok") {
    return "warm";
  }

  if (verdict !== "blocked") {
    return before;
  }

  return before === "warm" || before === "cooling" ? "cooling" : "contacted";
};
