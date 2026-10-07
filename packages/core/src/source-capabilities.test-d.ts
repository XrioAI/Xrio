import { describe, expectTypeOf, it } from "vite-plus/test";

import type { Deadline } from "./deadline.ts";
import type { HeldDeadline } from "./lifetime.ts";
import type { Slot } from "./slot.ts";
import type { Sources, VisitPlan } from "./sources/visit.ts";

declare const sources: Sources;

declare const plan: VisitPlan;

declare const plain: Deadline;

declare const held: HeldDeadline;

declare const slot: Slot;

describe("source capability types", () => {
  it("requires both held ownership and an admission slot", () => {
    expectTypeOf(sources.start).parameter(2).toEqualTypeOf<HeldDeadline>();
    sources.start(plan, slot, held);
    // @ts-expect-error A request deadline does not prove session ownership.
    sources.start(plan, slot, plain);
    // @ts-expect-error A held deadline does not prove admission.
    sources.start(plan, held, held);
  });
});
