import { createHash } from "node:crypto";

import type { ChromeProduct } from "../sources/browser/port.ts";
import {
  chromeAcceptLanguages,
  FORK_MAX_CORES,
  holdsHostHardware,
  REPORTABLE_MEMORY_GB,
} from "./owned-inputs.ts";
import { canonicalZone } from "./zone-name.ts";

export type Seed = string;

export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

interface Weighted {
  readonly weight: number;
}

interface ValueRow extends Weighted {
  readonly value: number;
}

export interface HardwareTables {
  readonly cores?: readonly ValueRow[];
  readonly memoryGb?: readonly ValueRow[];
}

export type WindowPin =
  | { readonly kind: "maximized" }
  | {
      readonly kind: "sized";
      readonly width: number;
      readonly height: number;
      readonly position?: { readonly x: number; readonly y: number };
    };

export interface DisplayTables {
  readonly screens?: readonly (Size & Weighted)[];
  readonly taskbars?: readonly (Insets & Weighted)[];
  readonly windows?: readonly (WindowPin & Weighted)[];
}

export type WindowState =
  | { readonly kind: "chrome-default" }
  | { readonly kind: "maximized" }
  | {
      readonly kind: "floating";
      readonly width: number;
      readonly height: number;
      readonly x: number;
      readonly y: number;
    };

export type GpuChoice =
  | { readonly backend: "native" }
  | { readonly backend: "swiftshader"; readonly persona: string | null };

export interface PresentedDevice {
  readonly screen: { readonly width: number; readonly height: number; readonly workArea: Insets };
  readonly window: WindowState;
  readonly cores: number;
  readonly memoryGb: number;
  readonly gpu: GpuChoice;
  readonly fonts: { readonly kind: "system" } | { readonly kind: "stack"; readonly digest: string };
  readonly voices:
    | { readonly kind: "system" }
    | { readonly kind: "persona"; readonly name: string };
}

export type TimezonePolicy =
  | { readonly kind: "pinned"; readonly zone: string }
  | { readonly kind: "exit" }
  | { readonly kind: "host"; readonly zone: string };

const DEVICE_SCHEMA = 1;

export interface DeviceRecord {
  readonly schema: typeof DEVICE_SCHEMA;
  readonly seed: Seed;
  readonly device: PresentedDevice;
  readonly policy: { readonly locale: string; readonly timezone: TimezonePolicy };
}

export interface MediaDeviceCounts {
  readonly audioinput: number;
  readonly audiooutput: number;
  readonly videoinput: number;
}

export type KnobOrigin = "set" | "def" | "umb" | "der";

export type KnobRegistry = Readonly<
  Record<string, { readonly origin: KnobOrigin; readonly value: string | null }>
>;

interface PersonaArtifact {
  readonly schema: string;
  readonly name: string;
  readonly digest: string;
  readonly chromeVersion: string;
}

export type SpeechPersona = PersonaArtifact;

export interface ForkFacts {
  readonly dialect: "xrio";
  readonly packageDir: string;
  readonly version: string;
  readonly commit: string | null;
  readonly dirty: number | null;
  readonly buildUnreadable: boolean;
  readonly knobs: KnobRegistry;
  readonly personas: {
    readonly speech: readonly SpeechPersona[];
  };
}

export interface FontStack {
  readonly directory: string;
  readonly payload: string;
  readonly families: number;
  readonly rules: readonly string[];
  readonly cacheDir: string;
}

export type FontStackFacts =
  | ({ readonly kind: "checked" } & FontStack)
  | { readonly kind: "refused"; readonly reason: string };

export interface FontEvidence {
  readonly key: string;
  readonly ageMs: number;
  readonly digest: string;
  readonly sentinel: string;
}

export interface HostCapabilities {
  readonly platform: NodeJS.Platform;
  readonly permittedCpus: number;
  readonly readableRenderNode?: true;
  readonly fork?: ForkFacts;
  readonly fontStack?: FontStackFacts;
  readonly fontEvidence?: FontEvidence;
}

export const knobOf = (capabilities: HostCapabilities, key: string): string | null =>
  capabilities.fork?.knobs[key]?.value ?? null;

interface Brand {
  readonly brand: string;
  readonly version: string;
}

export interface ClientHints {
  readonly architecture: string | null;
  readonly bitness: string | null;
  readonly brands: readonly Brand[] | null;
  readonly fullVersionList: readonly Brand[] | null;
  readonly mobile: boolean | null;
  readonly model: string | null;
  readonly platform: string | null;
  readonly platformVersion: string | null;
  readonly wow64: boolean | null;
}

export interface SecureContextReading {
  readonly kind: "secure";
  readonly deviceMemory: number | null;
  readonly clientHints: ClientHints | null;
  readonly battery: boolean;
  readonly webgpu: boolean;
}

export type AfterCapture =
  | SecureContextReading
  | { readonly kind: "insecure" }
  | { readonly kind: "failed" }
  | { readonly kind: "skipped" }
  | { readonly kind: "not-navigated" };

export interface Observation {
  readonly product: ChromeProduct;
  readonly afterCapture: AfterCapture;
  readonly zone: string | null;
  readonly requestedZone: string;
  readonly zoneOffsets: readonly string[];
  readonly requestedOffsets: readonly string[] | null;
  readonly intlLocale: string;
  readonly languages: readonly string[];
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly availWidth: number;
  readonly availHeight: number;
  readonly availLeft: number;
  readonly availTop: number;
  readonly colorDepth: number;
  readonly outerWidth: number;
  readonly outerHeight: number;
  readonly screenX: number;
  readonly screenY: number;
  readonly devicePixelRatio: number;
  readonly colorScheme: string | null;
  readonly reducedMotion: string | null;
  readonly pointer: string | null;
  readonly hover: string | null;
  readonly anyPointer: string | null;
  readonly maxTouchPoints: number;
  readonly webdriver: boolean;
  readonly webgl: boolean;
  readonly userAgent: string;
  readonly fontsSentinel: string;
  readonly fontsSentinelResolved: boolean;
  readonly fontsDigest: string | null;
  readonly hardwareConcurrency: number;
}

interface DeviceRecordRefusal {
  readonly kind: "unreplayable";
  readonly field: "device" | "policy";
  readonly reason: string;
}

const describeRefusal = (refusal: DeviceRecordRefusal): string =>
  `Device record cannot replay: ${refusal.reason}.`;

class DeviceRecordRefusedError extends Error {
  override readonly name = "DeviceRecordRefusedError";
  readonly refusal: DeviceRecordRefusal;

  constructor(refusal: DeviceRecordRefusal, options?: ErrorOptions) {
    super(describeRefusal(refusal), options);
    this.refusal = refusal;
  }
}

export const CHROME_MIN_WINDOW = { height: 88, width: 500 } as const;

const isWholeAtLeast = (value: number, min: number): boolean =>
  Number.isSafeInteger(value) && value >= min;

const screenProblem = ({ height, width, workArea }: PresentedDevice["screen"]) => {
  const insets = [workArea.top, workArea.right, workArea.bottom, workArea.left];

  if (!isWholeAtLeast(width, 1) || !isWholeAtLeast(height, 1)) {
    return `its screen ${width}x${height} is not a size in whole pixels`;
  }

  if (!insets.every((inset) => isWholeAtLeast(inset, 0))) {
    return "its screen's work area insets are not whole pixels";
  }

  const areaWidth = width - workArea.left - workArea.right;
  const areaHeight = height - workArea.top - workArea.bottom;
  const fits = areaWidth >= CHROME_MIN_WINDOW.width && areaHeight >= CHROME_MIN_WINDOW.height;

  return fits
    ? undefined
    : `its screen's ${areaWidth}x${areaHeight} work area is under Chrome's ${CHROME_MIN_WINDOW.width}x${CHROME_MIN_WINDOW.height} px minimum window`;
};

type FloatingWindow = Extract<WindowState, { kind: "floating" }>;

const floatsInside = (screen: PresentedDevice["screen"], window: FloatingWindow): boolean => {
  const { height, width, x, y } = window;

  return (
    [height, width, x, y].every((value) => Number.isSafeInteger(value)) &&
    width >= CHROME_MIN_WINDOW.width &&
    height >= CHROME_MIN_WINDOW.height &&
    x >= screen.workArea.left &&
    y >= screen.workArea.top &&
    x + width <= screen.width - screen.workArea.right &&
    y + height <= screen.height - screen.workArea.bottom
  );
};

const windowProblem = ({ screen, window }: PresentedDevice): string | undefined =>
  window.kind !== "floating" || floatsInside(screen, window)
    ? undefined
    : `its ${window.width}x${window.height} window at ${window.x},${window.y} is not a whole-pixel window inside its screen's work area`;

const hardwareProblem = ({ cores, memoryGb }: PresentedDevice): string | undefined => {
  if (holdsHostHardware({ cores, memoryGb })) {
    return undefined;
  }

  if (!isWholeAtLeast(cores, 1) || cores > FORK_MAX_CORES) {
    return `its ${cores} cores are not a positive whole number of at most ${FORK_MAX_CORES}`;
  }

  return REPORTABLE_MEMORY_GB.some((memory) => memory === memoryGb)
    ? undefined
    : `its ${memoryGb} GB of memory is not one of 2, 4, 8, 16 or 32`;
};

const policyProblem = ({ locale, timezone }: DeviceRecord["policy"]) => {
  if (chromeAcceptLanguages(locale) === undefined) {
    return `Xrio has not measured Chrome's language list for its locale ${locale}`;
  }

  return timezone.kind === "exit" || canonicalZone(timezone.zone) !== undefined
    ? undefined
    : `its zone ${timezone.zone} is not one Chrome names`;
};

const unreplayable = (field: "device" | "policy", reason: string): DeviceRecordRefusedError =>
  new DeviceRecordRefusedError({ field, kind: "unreplayable", reason });

export const refuseUnreplayable = (record: DeviceRecord): DeviceRecord => {
  const deviceProblem =
    screenProblem(record.device.screen) ??
    windowProblem(record.device) ??
    hardwareProblem(record.device);

  if (deviceProblem !== undefined) {
    throw unreplayable("device", deviceProblem);
  }

  const problem = policyProblem(record.policy);

  if (problem !== undefined) {
    throw unreplayable("policy", problem);
  }

  return record;
};

export const headlessWindowOf = ({
  device,
}: DeviceRecord): Exclude<WindowState, { kind: "chrome-default" }> => {
  if (device.window.kind === "chrome-default") {
    throw unreplayable(
      "device",
      "its window is a headed Chrome's own, which a headless browser cannot present",
    );
  }

  return device.window;
};

type StackContent =
  | ({ readonly kind: "checked" } & Pick<FontStack, "families" | "payload" | "rules">)
  | { readonly kind: "refused" };

interface DigestedHost {
  readonly platform: NodeJS.Platform;
  readonly permittedCpus: number;
  readonly readableRenderNode: true | undefined;
  readonly fork: ForkFacts | undefined;
  readonly fontStack: StackContent | undefined;
}

type Digested = PresentedDevice | DigestedHost;

const canonicalJson = (value: Digested): string => {
  const keys = new Set<string>();

  JSON.stringify(value, (key: string, member: Digested) => {
    keys.add(key);

    return member;
  });

  return JSON.stringify(value, [...keys].toSorted());
};

const sha256Of = (value: Digested): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export const deviceDigest = (record: DeviceRecord): string => sha256Of(record.device);

const stackContentOf = (stack: FontStackFacts): StackContent =>
  stack.kind === "checked"
    ? { families: stack.families, kind: stack.kind, payload: stack.payload, rules: stack.rules }
    : { kind: stack.kind };

export const hostDigest = ({
  fontStack,
  fork,
  permittedCpus,
  platform,
  readableRenderNode,
}: HostCapabilities): string =>
  sha256Of({
    fontStack: fontStack === undefined ? undefined : stackContentOf(fontStack),
    fork,
    permittedCpus,
    platform,
    readableRenderNode,
  });

export type ExitFacts =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "observed";
      readonly address: string;
      readonly zone: string;
      readonly country: string;
      readonly provider: string;
      readonly observedAt: number;
      readonly destination: string;
      readonly route: string;
      readonly generation: number;
    };
