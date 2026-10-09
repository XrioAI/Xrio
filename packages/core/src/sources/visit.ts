import type { DeviceRecord, HostCapabilities } from "../humanizer/contracts.ts";
import type { HttpPlan, IdentityPlan } from "../humanizer/humanizer.ts";
import type { ScrapeIntent } from "../intent.ts";
import type { HeldDeadline } from "../lifetime.ts";
import type { SeedCookie } from "../seed-cookies.ts";
import type { Slot } from "../slot.ts";
import type { ProxyEndpoint, SourceDocument } from "../types.ts";
import type { Closed } from "./browser/chrome-scope.ts";
import type { FontClaim } from "./browser/font-evidence.ts";

export type Profile =
  | { readonly kind: "scratch" }
  | { readonly kind: "persistent"; readonly dir: string };

export type SessionBinding =
  | { readonly kind: "unbound"; readonly stickyId: string }
  | { readonly kind: "direct"; readonly stickyId: string }
  | {
      readonly kind: "proxy";
      readonly stickyId: string;
      readonly region: { readonly country: string; readonly zone: string };
    };

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
      readonly profile?: Profile;
      readonly sessionBinding?: SessionBinding;
      readonly exitAddress?: string;
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

export interface SiteVisit {
  readonly site: string;
  readonly verdict: SourceDocument["block"]["verdict"];
  readonly vendor: SourceDocument["block"]["vendor"];
  readonly challengeOutcome: string | null;
  readonly challengeRules: readonly string[];
  readonly exitAddress: string | null;
  readonly deviceDigest: string;
}

export interface FinishedVisit {
  readonly siteVisit?: SiteVisit;
  readonly binding?: SessionBinding;
  readonly record: DeviceRecord | null;
  readonly browserArgs: readonly string[];
  readonly closed: Closed;
}

export interface Sources {
  readonly start: (plan: VisitPlan, slot: Slot, deadline: HeldDeadline) => Visit;
  readonly close: () => Promise<void>;
}
