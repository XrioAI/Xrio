import { describe, expect, it } from "vite-plus/test";

import { warmthAfter, warmthAt } from "./warmth.ts";
import type { Warmth } from "./warmth.ts";

describe("warmth", () => {
  it.each<{ before: Warmth; served: Warmth; blocked: Warmth }>([
    { before: "cold", blocked: "contacted", served: "warm" },
    { before: "contacted", blocked: "contacted", served: "warm" },
    { before: "warm", blocked: "cooling", served: "warm" },
    { before: "cooling", blocked: "cooling", served: "warm" },
  ])("moves $before warmth only for served or blocked visits", ({ before, served, blocked }) => {
    expect(warmthAfter(before, "ok")).toBe(served);
    expect(warmthAfter(before, "blocked")).toBe(blocked);
    expect(warmthAfter(before, "unknown")).toBe(before);
  });

  it("expires warmth beyond its age and refuses future history", () => {
    expect(warmthAt(undefined, 2000, 1000)).toBe("cold");
    expect(warmthAt({ lastVisitAt: 1000, state: "warm" }, 2000, 1000)).toBe("warm");
    expect(warmthAt({ lastVisitAt: 1000, state: "warm" }, 2001, 1000)).toBe("cold");
    expect(warmthAt({ lastVisitAt: 2001, state: "cooling" }, 2000, 1000)).toBe("cold");
    expect(warmthAt({ lastVisitAt: 2000, state: "contacted" }, 2000, 1000)).toBe("contacted");
  });
});
