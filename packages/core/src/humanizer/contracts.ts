import { createHash } from "node:crypto";

import type { ChromeProduct } from "../sources/browser/port.ts";

export type Seed = string;

interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
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

export type { Closed } from "../sources/browser/chrome-scope.ts";

export interface HostCapabilities {
  readonly platform: NodeJS.Platform;
}

export interface Observation {
  readonly product: ChromeProduct;
}

export type DeviceRecordRefusal =
  | { readonly kind: "unknown-schema"; readonly schema: number }
  | { readonly kind: "malformed"; readonly field: "record" | keyof DeviceRecord };

const describeRefusal = (refusal: DeviceRecordRefusal): string =>
  refusal.kind === "unknown-schema"
    ? `Device record schema ${refusal.schema} is unknown; Xrio reads schema ${DEVICE_SCHEMA} only.`
    : `Device record field ${refusal.field} is malformed.`;

export class DeviceRecordRefusedError extends Error {
  override readonly name = "DeviceRecordRefusedError";
  readonly refusal: DeviceRecordRefusal;

  constructor(refusal: DeviceRecordRefusal, options?: ErrorOptions) {
    super(describeRefusal(refusal), options);
    this.refusal = refusal;
  }
}

const malformed = (
  field: "record" | keyof DeviceRecord,
  cause?: unknown,
): DeviceRecordRefusedError =>
  new DeviceRecordRefusedError({ field, kind: "malformed" }, { cause });

const SEED = /^[\da-f]{16}$/u;

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSize = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isText = (value: unknown): value is string => typeof value === "string";

const isSeed = (value: unknown): value is Seed => isText(value) && SEED.test(value);

const holdsOnly = (value: unknown, keys: readonly string[]): value is object =>
  isObject(value) && Object.keys(value).every((key) => keys.includes(key));

const isInsets = (value: unknown): value is Insets =>
  holdsOnly(value, ["top", "right", "bottom", "left"]) &&
  "top" in value &&
  isSize(value.top) &&
  "right" in value &&
  isSize(value.right) &&
  "bottom" in value &&
  isSize(value.bottom) &&
  "left" in value &&
  isSize(value.left);

const isScreen = (value: unknown): value is PresentedDevice["screen"] =>
  holdsOnly(value, ["width", "height", "workArea"]) &&
  "width" in value &&
  isSize(value.width) &&
  "height" in value &&
  isSize(value.height) &&
  "workArea" in value &&
  isInsets(value.workArea);

const isFloating = (value: unknown): value is Extract<WindowState, { kind: "floating" }> =>
  holdsOnly(value, ["kind", "width", "height", "x", "y"]) &&
  "kind" in value &&
  value.kind === "floating" &&
  "width" in value &&
  isSize(value.width) &&
  "height" in value &&
  isSize(value.height) &&
  "x" in value &&
  isSize(value.x) &&
  "y" in value &&
  isSize(value.y);

const isFixedWindow = (value: unknown): value is Exclude<WindowState, { kind: "floating" }> =>
  holdsOnly(value, ["kind"]) &&
  "kind" in value &&
  (value.kind === "chrome-default" || value.kind === "maximized");

const isWindow = (value: unknown): value is WindowState =>
  isFixedWindow(value) || isFloating(value);

const isNative = (value: unknown): value is Extract<GpuChoice, { backend: "native" }> =>
  holdsOnly(value, ["backend"]) && "backend" in value && value.backend === "native";

const isSwiftshader = (value: unknown): value is Extract<GpuChoice, { backend: "swiftshader" }> =>
  holdsOnly(value, ["backend", "persona"]) &&
  "backend" in value &&
  value.backend === "swiftshader" &&
  "persona" in value &&
  (value.persona === null || isText(value.persona));

const isGpu = (value: unknown): value is GpuChoice => isNative(value) || isSwiftshader(value);

const isSystem = (value: unknown): value is { readonly kind: "system" } =>
  holdsOnly(value, ["kind"]) && "kind" in value && value.kind === "system";

const isStack = (value: unknown): value is Extract<PresentedDevice["fonts"], { kind: "stack" }> =>
  holdsOnly(value, ["kind", "digest"]) &&
  "kind" in value &&
  value.kind === "stack" &&
  "digest" in value &&
  isText(value.digest);

const isFonts = (value: unknown): value is PresentedDevice["fonts"] =>
  isSystem(value) || isStack(value);

const isPersona = (
  value: unknown,
): value is Extract<PresentedDevice["voices"], { kind: "persona" }> =>
  holdsOnly(value, ["kind", "name"]) &&
  "kind" in value &&
  value.kind === "persona" &&
  "name" in value &&
  isText(value.name);

const isVoices = (value: unknown): value is PresentedDevice["voices"] =>
  isSystem(value) || isPersona(value);

const isDevice = (value: unknown): value is PresentedDevice =>
  holdsOnly(value, ["screen", "window", "cores", "memoryGb", "gpu", "fonts", "voices"]) &&
  "screen" in value &&
  isScreen(value.screen) &&
  "window" in value &&
  isWindow(value.window) &&
  "cores" in value &&
  isSize(value.cores) &&
  "memoryGb" in value &&
  isSize(value.memoryGb) &&
  "gpu" in value &&
  isGpu(value.gpu) &&
  "fonts" in value &&
  isFonts(value.fonts) &&
  "voices" in value &&
  isVoices(value.voices);

const isExitPolicy = (value: unknown): value is Extract<TimezonePolicy, { kind: "exit" }> =>
  holdsOnly(value, ["kind"]) && "kind" in value && value.kind === "exit";

const isZoned = (value: unknown): value is Extract<TimezonePolicy, { zone: string }> =>
  holdsOnly(value, ["kind", "zone"]) &&
  "kind" in value &&
  (value.kind === "pinned" || value.kind === "host") &&
  "zone" in value &&
  isText(value.zone);

const isTimezonePolicy = (value: unknown): value is TimezonePolicy =>
  isExitPolicy(value) || isZoned(value);

const isPolicy = (value: unknown): value is DeviceRecord["policy"] =>
  holdsOnly(value, ["locale", "timezone"]) &&
  "locale" in value &&
  isText(value.locale) &&
  "timezone" in value &&
  isTimezonePolicy(value.timezone);

const parseObject = (stored: string): object => {
  let record: unknown;

  try {
    record = JSON.parse(stored);
  } catch (error) {
    throw malformed("record", error);
  }

  if (!isObject(record)) {
    throw malformed("record");
  }

  return record;
};

export const readDeviceRecord = (stored: string): DeviceRecord => {
  const record = parseObject(stored);

  if (!("schema" in record) || !isSize(record.schema)) {
    throw malformed("schema");
  }

  if (record.schema !== DEVICE_SCHEMA) {
    throw new DeviceRecordRefusedError({ kind: "unknown-schema", schema: record.schema });
  }

  const seed = "seed" in record ? record.seed : undefined;
  const device = "device" in record ? record.device : undefined;
  const policy = "policy" in record ? record.policy : undefined;

  if (!isSeed(seed)) {
    throw malformed("seed");
  }

  if (!isDevice(device)) {
    throw malformed("device");
  }

  if (!isPolicy(policy)) {
    throw malformed("policy");
  }

  if (!holdsOnly(record, ["schema", "seed", "device", "policy"])) {
    throw malformed("record");
  }

  return { device, policy, schema: DEVICE_SCHEMA, seed };
};

type Digested = PresentedDevice | HostCapabilities;

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

export const hostDigest = (capabilities: HostCapabilities): string => sha256Of(capabilities);
