import type { AfterCapture, ClientHints, Observation } from "./contracts.ts";
import type { ExitChoice, IdentityContext, SurfaceChoices } from "./surfaces.ts";
import type { IdentityMismatch, IdentityTell } from "./verify.ts";

export type CoverageReason =
  | "insecure-origin"
  | "read-failed"
  | "no-time"
  | "no-request-log"
  | "lanes-only"
  | "not-observed";

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
  readonly deviceMemory: number | null;
  readonly clientHints: ClientHints | null;
  readonly battery: boolean | null;
  readonly webgpu: boolean | null;
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

const AFTER_CAPTURE_REASON: Readonly<
  Record<Exclude<AfterCapture["kind"], "secure">, CoverageReason>
> = {
  failed: "read-failed",
  insecure: "insecure-origin",
  "not-navigated": "not-observed",
  skipped: "no-time",
};

const afterCaptureCoverage = (afterCapture: AfterCapture): Coverage =>
  afterCapture.kind === "secure"
    ? observedCoverage()
    : unchecked(AFTER_CAPTURE_REASON[afterCapture.kind]);

const secureContextOf = (afterCapture: AfterCapture) =>
  afterCapture.kind === "secure"
    ? afterCapture
    : { battery: null, clientHints: null, deviceMemory: null, webgpu: null };

const readCoverage = (afterCapture: AfterCapture, gotValue: boolean): Coverage =>
  afterCapture.kind === "secure" && !gotValue
    ? unchecked("read-failed")
    : afterCaptureCoverage(afterCapture);

const timezoneCoverage = ({ requestedOffsets, zone }: Observation): Coverage =>
  zone === null || requestedOffsets === null ? unchecked("read-failed") : observedCoverage();

export const coverageOf = (observation: Observation): IdentityCoverage => {
  const { afterCapture } = observation;
  const { clientHints, deviceMemory } = secureContextOf(afterCapture);

  return {
    automation: observedCoverage(),
    battery: afterCaptureCoverage(afterCapture),
    clientHints: readCoverage(afterCapture, clientHints !== null),
    colorDepth: observedCoverage(),
    colorScheme: observedCoverage(),
    cores: unchecked("not-observed"),
    deviceMemory: readCoverage(afterCapture, deviceMemory !== null),
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
    webgpu: afterCaptureCoverage(afterCapture),
    webrtc: unchecked("not-observed"),
    window: observedCoverage(),
    workArea: observedCoverage(),
  };
};

export const observedOf = (observation: Observation): ObservedIdentity => {
  const { battery, clientHints, deviceMemory, webgpu } = secureContextOf(observation.afterCapture);

  return {
    anyPointer: observation.anyPointer,
    battery,
    clientHints,
    colorScheme: observation.colorScheme,
    deviceMemory,
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
    webgpu,
    window: { outerHeight: observation.outerHeight, outerWidth: observation.outerWidth },
  };
};

export const httpReport = (locale: string, profile: HttpProfile): HttpIdentityReport => ({
  coverage: { requestHeaders: unchecked("no-request-log") },
  locale,
  mode: "http",
  profile: { ...profile },
  tells: [],
});
