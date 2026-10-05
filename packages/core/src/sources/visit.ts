import type { HostCapabilities } from "../humanizer/contracts.ts";
import type { IdentityPlan } from "../humanizer/humanizer.ts";
import type { ScrapeIntent } from "../intent.ts";
import type { HeldDeadline } from "../lifetime.ts";
import type { Slot } from "../slot.ts";
import type { SourceDocument } from "../types.ts";
import type { Closed } from "./browser/chrome-scope.ts";
import type { FontClaim } from "./browser/font-evidence.ts";

interface Visit {
  readonly document: Promise<SourceDocument>;
  readonly closed: Promise<Closed>;
}

type BrowserIntent = Exclude<ScrapeIntent["source"], { mode: "http" }>;

export type VisitPlan = {
  readonly kind: "browser";
  readonly url: URL;
  readonly capabilities: HostCapabilities;
  readonly identity: IdentityPlan;
  readonly fonts: FontClaim;
} & BrowserIntent;

export interface Sources {
  readonly start: (plan: VisitPlan, slot: Slot, deadline: HeldDeadline) => Visit;
  readonly close: () => Promise<void>;
}
