import type { DeviceRecord, HostCapabilities } from "../humanizer/contracts.ts";
import type { HttpPlan, IdentityPlan } from "../humanizer/humanizer.ts";
import type { ScrapeIntent } from "../intent.ts";
import type { HeldDeadline } from "../lifetime.ts";
import type { SeedCookie } from "../seed-cookies.ts";
import type { Slot } from "../slot.ts";
import type { ProxyEndpoint, SourceDocument } from "../types.ts";
import type { Closed } from "./browser/chrome-scope.ts";
import type { FontClaim } from "./browser/font-evidence.ts";

export interface Visit {
  readonly document: Promise<SourceDocument>;
  readonly closed: Promise<Closed>;
}

type BrowserIntent = Exclude<ScrapeIntent["source"], { mode: "http" }>;

export type VisitPlan =
  | ({
      readonly kind: "browser";
      readonly url: URL;
      readonly cookies: readonly SeedCookie[];
      readonly capabilities: HostCapabilities;
      readonly identity: IdentityPlan;
      readonly fonts: FontClaim;
      readonly proxy: ProxyEndpoint | undefined;
    } & BrowserIntent)
  | {
      readonly kind: "http";
      readonly headers: Readonly<Record<string, string>>;
      readonly url: URL;
      readonly cookies: readonly SeedCookie[];
      readonly capabilities: HostCapabilities | null;
      readonly identity: HttpPlan;
      readonly proxy: ProxyEndpoint | undefined;
    };

export interface FinishedVisit {
  readonly record: DeviceRecord | null;
  readonly closed: Closed;
}

export interface Sources {
  readonly start: (plan: VisitPlan, slot: Slot, deadline: HeldDeadline) => Visit;
  readonly close: () => Promise<void>;
}
