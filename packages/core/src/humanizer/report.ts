import type { Observation } from "./contracts.ts";
import { DEFAULT_LOCALE } from "./surfaces.ts";
import type { ExitChoice, IdentityContext, SurfaceChoices } from "./surfaces.ts";
import type { IdentityMismatch, IdentityTell } from "./verify.ts";

export type CoverageReason = "no-request-log" | "lanes-only" | "not-observed";

export type Coverage =
  | { readonly state: "observed" }
  | { readonly state: "cached"; readonly key: string; readonly ageMs: number }
  | { readonly state: "unchecked"; readonly reason: CoverageReason };

export type CoveredSurface =
  | "timezone"
  | "languages"
  | "userAgent"
  | "clientHints"
  | "requestHeaders"
  | "platform"
  | "screen"
  | "workArea"
  | "devicePixelRatio"
  | "colorDepth"
  | "window"
  | "colorScheme"
  | "reducedMotion"
  | "pointer"
  | "cores"
  | "deviceMemory"
  | "webglStrings"
  | "webglPixels"
  | "webgpu"
  | "fonts"
  | "voices"
  | "mediaDevices"
  | "battery"
  | "webrtc"
  | "dns"
  | "automation"
  | "storageQuota"
  | "permissions";

export type IdentityCoverage = { readonly [Surface in CoveredSurface]: Coverage };

export interface ObservedIdentity {
  readonly timeZone: string | null;
  readonly offsets: readonly string[];
  readonly intlLocale: string;
  readonly languages: readonly string[];
  readonly userAgent: string;
  readonly webdriver: boolean;
  readonly screen: {
    readonly width: number;
    readonly height: number;
    readonly availWidth: number;
    readonly availHeight: number;
    readonly colorDepth: number;
    readonly devicePixelRatio: number;
  };
  readonly window: { readonly outerWidth: number; readonly outerHeight: number };
  readonly colorScheme: string | null;
  readonly reducedMotion: string | null;
  readonly pointer: string | null;
  readonly hover: string | null;
  readonly anyPointer: string | null;
  readonly maxTouchPoints: number;
}

export interface BrowserIdentityReport {
  readonly mode: IdentityContext["mode"];
  readonly binary: { readonly version: string };
  readonly exit: ExitChoice;
  readonly surfaces: SurfaceChoices;
  readonly observed: ObservedIdentity;
  readonly coverage: IdentityCoverage;
  readonly notes: readonly IdentityMismatch[];
  readonly tells: readonly IdentityTell[];
}

export interface HttpProfile {
  readonly chromeMajor: number;
  readonly platform: string;
}

export interface HttpIdentityReport {
  readonly mode: "http";
  readonly locale: string;
  readonly profile: HttpProfile;
  readonly coverage: { readonly requestHeaders: Coverage };
  readonly tells: readonly IdentityTell[];
}

export type IdentityReport = BrowserIdentityReport | HttpIdentityReport;

const observedCoverage = (): Coverage => ({ state: "observed" });

const unchecked = (reason: CoverageReason): Coverage => ({ reason, state: "unchecked" });

const timezoneCoverage = ({ requestedZone, requestedOffsets, zone }: Observation): Coverage =>
  requestedZone === null || zone === null || requestedOffsets === null
    ? unchecked("not-observed")
    : observedCoverage();

export const coverageOf = (observation: Observation): IdentityCoverage => ({
  automation: observedCoverage(),
  battery: unchecked("not-observed"),
  clientHints: unchecked("not-observed"),
  colorDepth: observedCoverage(),
  colorScheme: observedCoverage(),
  cores: unchecked("not-observed"),
  deviceMemory: unchecked("not-observed"),
  devicePixelRatio: observedCoverage(),
  dns: unchecked("not-observed"),
  fonts: unchecked("not-observed"),
  languages: observedCoverage(),
  mediaDevices: unchecked("not-observed"),
  permissions: unchecked("not-observed"),
  platform: unchecked("not-observed"),
  pointer: observedCoverage(),
  reducedMotion: observedCoverage(),
  requestHeaders: unchecked("no-request-log"),
  screen: observedCoverage(),
  storageQuota: unchecked("not-observed"),
  timezone: timezoneCoverage(observation),
  userAgent: observedCoverage(),
  voices: unchecked("not-observed"),
  webglPixels: unchecked("lanes-only"),
  webglStrings: unchecked("not-observed"),
  webgpu: unchecked("not-observed"),
  webrtc: unchecked("not-observed"),
  window: observedCoverage(),
  workArea: observedCoverage(),
});

export const observedOf = (observation: Observation): ObservedIdentity => ({
  anyPointer: observation.anyPointer,
  colorScheme: observation.colorScheme,
  hover: observation.hover,
  intlLocale: observation.intlLocale,
  languages: [...observation.languages],
  maxTouchPoints: observation.maxTouchPoints,
  offsets: [...observation.zoneOffsets],
  pointer: observation.pointer,
  reducedMotion: observation.reducedMotion,
  screen: {
    availHeight: observation.availHeight,
    availWidth: observation.availWidth,
    colorDepth: observation.colorDepth,
    devicePixelRatio: observation.devicePixelRatio,
    height: observation.screenHeight,
    width: observation.screenWidth,
  },
  timeZone: observation.zone,
  userAgent: observation.userAgent,
  webdriver: observation.webdriver,
  window: { outerHeight: observation.outerHeight, outerWidth: observation.outerWidth },
});

export const httpIdentity = (profile: HttpProfile): HttpIdentityReport => ({
  coverage: { requestHeaders: unchecked("no-request-log") },
  locale: DEFAULT_LOCALE,
  mode: "http",
  profile: { ...profile },
  tells: [],
});
