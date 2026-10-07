import type {
  AfterCapture,
  BatteryReading,
  ClientHints,
  FontEvidence,
  HostCapabilities,
  DeviceRecord,
  Observation,
  SecureContextReading,
  WebGpuAdapterReading,
} from "./contracts.ts";
import type { ExitChoice, IdentityContext, SurfaceChoices } from "./surfaces.ts";
import type { IdentityMismatch, IdentityTell } from "./verify.ts";

export type CoverageReason =
  | "fonts-drift"
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
  readonly fontsDigest: string | null;
  readonly screen: {
    readonly width: number;
    readonly height: number;
    readonly availWidth: number;
    readonly availHeight: number;
    readonly availLeft: number;
    readonly availTop: number;
    readonly colorDepth: number;
    readonly devicePixelRatio: number;
  };
  readonly window: {
    readonly outerWidth: number;
    readonly outerHeight: number;
    readonly screenX: number;
    readonly screenY: number;
  };
  readonly colorScheme: string | null;
  readonly reducedMotion: string | null;
  readonly pointer: string | null;
  readonly hover: string | null;
  readonly anyPointer: string | null;
  readonly maxTouchPoints: number;
  readonly hardwareConcurrency: number;
  readonly deviceMemory: number | null;
  readonly clientHints: ClientHints | null;
  readonly battery: boolean | null;
  readonly batteryState: { readonly charging: boolean; readonly level: number } | null;
  readonly webgpu: boolean | null;
  readonly webgpuAdapter: { readonly vendor: string; readonly architecture: string } | null;
  readonly webgl: {
    readonly vendor: string | null;
    readonly renderer: string | null;
    readonly extensions: readonly string[] | null;
  };
}

export interface BrowserIdentityReport {
  readonly mode: IdentityContext["mode"];
  readonly seed: string;
  readonly record: DeviceRecord;
  readonly digests: { readonly device: string; readonly host: string };
  readonly binary: {
    readonly version: string;
    readonly fork: "xrio" | null;
    readonly commit: string | null;
    readonly dirty: number | null;
  };
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
  readonly coverage: { readonly requestHeaders: Coverage; readonly httpProfileSkew: Coverage };
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

const BOUNDED_UNREAD_REASON: Readonly<Record<"timed-out" | "failed", CoverageReason>> = {
  failed: "read-failed",
  "timed-out": "no-time",
};

const boundedCoverage = (
  afterCapture: AfterCapture,
  readingOf: (secure: SecureContextReading) => WebGpuAdapterReading | BatteryReading,
): Coverage => {
  if (afterCapture.kind !== "secure") {
    return afterCaptureCoverage(afterCapture);
  }

  const reading = readingOf(afterCapture);

  return reading.kind === "timed-out" || reading.kind === "failed"
    ? unchecked(BOUNDED_UNREAD_REASON[reading.kind])
    : observedCoverage();
};

const batteryStateOf = (afterCapture: AfterCapture): ObservedIdentity["batteryState"] =>
  afterCapture.kind === "secure" && afterCapture.batteryState.kind === "state"
    ? { charging: afterCapture.batteryState.charging, level: afterCapture.batteryState.level }
    : null;

const webgpuAdapterOf = (afterCapture: AfterCapture): ObservedIdentity["webgpuAdapter"] =>
  afterCapture.kind === "secure" && afterCapture.webgpuAdapter.kind === "adapter"
    ? {
        architecture: afterCapture.webgpuAdapter.architecture,
        vendor: afterCapture.webgpuAdapter.vendor,
      }
    : null;

const readCoverage = (afterCapture: AfterCapture, gotValue: boolean): Coverage =>
  afterCapture.kind === "secure" && !gotValue
    ? unchecked("read-failed")
    : afterCaptureCoverage(afterCapture);

const timezoneCoverage = ({ requestedOffsets, zone }: Observation): Coverage =>
  zone === null || requestedOffsets === null ? unchecked("read-failed") : observedCoverage();

const fontsCoverage = (
  evidence: FontEvidence | undefined,
  drifted: boolean,
  { fontsDigest }: Observation,
): Coverage => {
  if (evidence === undefined || fontsDigest !== null) {
    return observedCoverage();
  }

  return drifted
    ? unchecked("fonts-drift")
    : { ageMs: evidence.ageMs, key: evidence.key, state: "cached" };
};

export const coverageOf = (
  evidence: {
    readonly fonts: FontEvidence | undefined;
    readonly fontsDrifted: boolean;
  },
  observation: Observation,
): IdentityCoverage => {
  const { afterCapture } = observation;
  const { clientHints, deviceMemory } = secureContextOf(afterCapture);

  return {
    automation: observedCoverage(),
    battery: boundedCoverage(afterCapture, ({ batteryState }) => batteryState),
    clientHints: readCoverage(afterCapture, clientHints !== null),
    colorDepth: observedCoverage(),
    colorScheme: observedCoverage(),
    cores: observedCoverage(),
    deviceMemory: readCoverage(afterCapture, deviceMemory !== null),
    devicePixelRatio: observedCoverage(),
    dns: unchecked("not-observed"),
    fonts: fontsCoverage(evidence.fonts, evidence.fontsDrifted, observation),
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
    webglStrings: observedCoverage(),
    webgpu: boundedCoverage(afterCapture, ({ webgpuAdapter }) => webgpuAdapter),
    webrtc: unchecked("not-observed"),
    window: observedCoverage(),
    workArea: observedCoverage(),
  };
};

export const observedOf = (
  observation: Observation,
  fonts: FontEvidence | undefined,
): ObservedIdentity => {
  const { battery, clientHints, deviceMemory, webgpu } = secureContextOf(observation.afterCapture);

  return {
    anyPointer: observation.anyPointer,
    battery,
    batteryState: batteryStateOf(observation.afterCapture),
    clientHints,
    colorScheme: observation.colorScheme,
    deviceMemory,
    fontsDigest: observation.fontsDigest ?? fonts?.digest ?? null,
    hardwareConcurrency: observation.hardwareConcurrency,
    hover: observation.hover,
    intlLocale: observation.intlLocale,
    languages: [...observation.languages],
    maxTouchPoints: observation.maxTouchPoints,
    offsets: [...observation.zoneOffsets],
    pointer: observation.pointer,
    reducedMotion: observation.reducedMotion,
    screen: {
      availHeight: observation.availHeight,
      availLeft: observation.availLeft,
      availTop: observation.availTop,
      availWidth: observation.availWidth,
      colorDepth: observation.colorDepth,
      devicePixelRatio: observation.devicePixelRatio,
      height: observation.screenHeight,
      width: observation.screenWidth,
    },
    timeZone: observation.zone,
    userAgent: observation.userAgent,
    webdriver: observation.webdriver,
    webgl: {
      extensions: observation.webglExtensions === null ? null : [...observation.webglExtensions],
      renderer: observation.webglRenderer,
      vendor: observation.webglVendor,
    },
    webgpu,
    webgpuAdapter: webgpuAdapterOf(observation.afterCapture),
    window: {
      outerHeight: observation.outerHeight,
      outerWidth: observation.outerWidth,
      screenX: observation.screenX,
      screenY: observation.screenY,
    },
  };
};

const profileSkewed = (profile: HttpProfile, client: HostCapabilities | null): boolean => {
  const version = client?.fork?.version;

  return version !== undefined && Number(version.split(".", 1)[0]) !== profile.chromeMajor;
};

export const httpReport = (
  locale: string,
  profile: HttpProfile,
  client: HostCapabilities | null,
): HttpIdentityReport => ({
  coverage: {
    httpProfileSkew: client?.fork === undefined ? unchecked("not-observed") : observedCoverage(),
    requestHeaders: unchecked("no-request-log"),
  },
  locale,
  mode: "http",
  profile: { ...profile },
  tells: profileSkewed(profile, client) ? ["http-profile-skew"] : [],
});
