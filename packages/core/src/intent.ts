import type { CacheDir } from "./cache-dir.ts";
import type { IdentityIntent } from "./humanizer/intent.ts";
import type { ProxyEndpoint, ScrapeFormat, WaitFor } from "./types.ts";

type SourceIntent =
  | { readonly mode: "http" }
  | {
      readonly mode: "headless" | "headed";
      readonly browserPath: string;
      readonly browserArgs: readonly string[];
      readonly waitFor?: WaitFor;
    };

interface SessionIntent {
  readonly kind: "anonymous";
}

export interface ScrapeIntent {
  readonly url: URL;
  readonly format: ScrapeFormat;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly source: SourceIntent;
  readonly identity: IdentityIntent;
  readonly session: SessionIntent;
  readonly route: ProxyEndpoint | undefined;
}

type BrowserIntent = Extract<SourceIntent, { mode: "headless" | "headed" }>;

export type ClientDefaults = Pick<ScrapeIntent, "identity" | "session" | "route"> & {
  readonly cacheDir: CacheDir;
  readonly maxBrowsers: number | undefined;
  readonly mode: SourceIntent["mode"];
  readonly browser: Pick<BrowserIntent, "browserArgs"> & {
    readonly browserPath: BrowserIntent["browserPath"] | undefined;
  };
};
