/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-object-parameters -- This module is the runtime parser for untrusted host configuration. */
import { invalidOptions } from "./errors.ts";
import { GPU_POLICIES } from "./humanizer/contracts.ts";
import type {
  DisplayTables,
  GpuPolicy,
  HardwareTables,
  Insets,
  WindowPin,
} from "./humanizer/contracts.ts";
import { displayMisfit } from "./humanizer/draws.ts";
import type { IdentityIntent } from "./humanizer/intent.ts";
import {
  chromeAcceptLanguages,
  FORK_MAX_CORES,
  isGlPersonaName,
  measuredLocalesFor,
  REPORTABLE_MEMORY_GB,
} from "./humanizer/owned-inputs.ts";
import { canonicalZone } from "./humanizer/zone-name.ts";
import { parseBrowserArgs } from "./sources/browser/launch-plan.ts";

export interface ScreenSize {
  width: number;
  height: number;
}

export interface Taskbar {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

interface SizedWindow {
  width: number;
  height: number;
}

export type WindowSize =
  | (SizedWindow & { x?: never; y?: never })
  | (SizedWindow & { x: number; y: number });

interface MaximizedWindow {
  maximized: true;
  width?: never;
  height?: never;
  x?: never;
  y?: never;
}

type Weighted<Value> = Value & { weight: number };

export interface DisplayOptions {
  screen?: ScreenSize | readonly Weighted<ScreenSize>[];
  taskbar?: Taskbar | readonly Weighted<Taskbar>[];
  window?: "maximized" | WindowSize | readonly (Weighted<WindowSize> | Weighted<MaximizedWindow>)[];
}

type ReportableMemoryGb = (typeof REPORTABLE_MEMORY_GB)[number];

export interface HardwareOptions {
  cores?: number | readonly Weighted<{ value: number }>[];
  memoryGb?: ReportableMemoryGb | readonly Weighted<{ value: ReportableMemoryGb }>[];
  gpu?: string | readonly Weighted<{ name: string }>[];
  gpuPolicy?: GpuPolicy;
}

export interface HostConfig {
  locale?: string;
  timezone?: string;
  display?: DisplayOptions;
  hardware?: HardwareOptions;
  browserArgs?: readonly string[];
}

export interface HostSettings {
  readonly identity: IdentityIntent;
  readonly browserArgs: readonly string[] | undefined;
}

interface Entry<Weight> {
  readonly row: object;
  readonly weight: Weight;
}

const POSIX_LOCALE_MARKS = /[_.@]/u;

const POSIX_LOCALE_MESSAGE =
  "host.locale must be a BCP 47 language tag such as de-DE, not a POSIX locale such as en_US.UTF-8.";

const BCP47_LOCALE_MESSAGE = "host.locale must be one BCP 47 language tag such as de-DE.";

const HOST_FIELDS = new Set(["locale", "timezone", "display", "hardware", "browserArgs"]);

const DISPLAY_FIELDS = new Set(["screen", "taskbar", "window"]);

const EDGES = ["top", "right", "bottom", "left"] as const;

const TASKBAR_FIELDS = new Set<string>([...EDGES, "weight"]);

const SCREEN_FIELDS = new Set(["width", "height", "weight"]);

const WINDOW_FIELDS = new Set(["width", "height", "x", "y", "weight"]);

const MAXIMIZED_FIELDS = new Set(["maximized", "weight"]);

const HARDWARE_FIELDS = new Set(["cores", "memoryGb", "gpu", "gpuPolicy"]);

const HARDWARE_ROW_FIELDS = new Set(["value", "weight"]);

const GPU_ROW_FIELDS = new Set(["name", "weight"]);

const GPU_PERSONAS_EXPECTED =
  "host.hardware.gpu must be a GL persona name, or a non-empty weighted table of them.";

export const isPlainObject = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const fieldOf = (row: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);

  return descriptor?.get === undefined ? descriptor?.value : descriptor.get.call(row);
};

const holdsOnly = (row: object, fields: ReadonlySet<string>): boolean =>
  Object.keys(row).every((key) => fields.has(key));

const isWhole = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;

const isPositiveWeight = (entry: Entry<unknown>): entry is Entry<number> =>
  typeof entry.weight === "number" && Number.isFinite(entry.weight) && entry.weight > 0;

const tableOf = (value: unknown, field: string): readonly Entry<number>[] => {
  const expected = `${field} must be a value or a non-empty weighted table.`;

  if (!Array.isArray(value)) {
    if (!isPlainObject(value)) {
      throw invalidOptions(expected);
    }

    if (fieldOf(value, "weight") !== undefined) {
      throw invalidOptions(`${field} weight applies only to rows of a weighted table.`);
    }

    return [{ row: value, weight: 1 }];
  }

  const rows: unknown[] = value;

  if (rows.length === 0 || !rows.every(isPlainObject)) {
    throw invalidOptions(expected);
  }

  const entries = rows.map((row) => ({ row, weight: fieldOf(row, "weight") }));

  if (!entries.every(isPositiveWeight)) {
    throw invalidOptions(`${field} weights must be positive numbers.`);
  }

  if (!Number.isFinite(entries.reduce((total, { weight }) => total + weight, 0))) {
    throw invalidOptions(`${field} weights must add up to a finite number.`);
  }

  return entries;
};

const malformedLocale = (locale: string, cause?: unknown) =>
  invalidOptions(
    POSIX_LOCALE_MARKS.test(locale) ? POSIX_LOCALE_MESSAGE : BCP47_LOCALE_MESSAGE,
    cause,
  );

const canonicalLocales = (locale: string): readonly string[] => {
  try {
    return Intl.getCanonicalLocales(locale);
  } catch (error) {
    throw malformedLocale(locale, error);
  }
};

const unmeasuredLocale = (tag: string) => {
  const measured = measuredLocalesFor(tag);

  const suggestion =
    measured.length === 0
      ? ""
      : ` Try ${new Intl.ListFormat("en", { type: "disjunction" }).format(measured)}.`;

  return invalidOptions(
    `host.locale ${tag} is not one Xrio has measured Chrome's language list for.${suggestion}`,
  );
};

const resolveLocale = (locale: unknown): string | undefined => {
  if (locale === undefined) {
    return undefined;
  }

  if (typeof locale !== "string") {
    throw invalidOptions(BCP47_LOCALE_MESSAGE);
  }

  const [tag, ...extra] = canonicalLocales(locale);

  if (tag === undefined || extra.length > 0) {
    throw malformedLocale(locale);
  }

  if (chromeAcceptLanguages(tag) === undefined) {
    throw unmeasuredLocale(tag);
  }

  if (tag !== locale) {
    throw invalidOptions(`host.locale ${locale} is spelled ${tag}.`);
  }

  return tag;
};

const resolveTimezone = (timezone: unknown): string | undefined => {
  if (timezone === undefined) {
    return undefined;
  }

  const zone = typeof timezone === "string" ? canonicalZone(timezone) : undefined;

  if (zone === undefined) {
    throw invalidOptions("host.timezone must be an IANA zone name such as America/New_York.");
  }

  return zone;
};

const parseScreen = ({ row, weight }: Entry<number>) => {
  const width = fieldOf(row, "width");
  const height = fieldOf(row, "height");

  if (!holdsOnly(row, SCREEN_FIELDS) || !isWhole(width, 1) || !isWhole(height, 1)) {
    throw invalidOptions(
      "host.display.screen takes a width and a height in whole pixels, such as { width: 1440, height: 900 }.",
    );
  }

  return { height, weight, width };
};

const edgeOf = (row: object, edge: (typeof EDGES)[number]): unknown => {
  const inset = fieldOf(row, edge);

  return inset === undefined ? 0 : inset;
};

const parseTaskbar = ({ row, weight }: Entry<number>): Insets & { weight: number } => {
  const edges = EDGES.map((edge) => edgeOf(row, edge));

  if (!holdsOnly(row, TASKBAR_FIELDS) || !edges.every((edge) => isWhole(edge, 0))) {
    throw invalidOptions(
      "host.display.taskbar takes top, right, bottom and left insets in whole pixels, such as { bottom: 48 }.",
    );
  }

  const [top, right, bottom, left] = edges;

  return { bottom, left, right, top, weight };
};

const parseSize = (row: object): WindowPin => {
  const width = fieldOf(row, "width");
  const height = fieldOf(row, "height");
  const x = fieldOf(row, "x");
  const y = fieldOf(row, "y");

  if (!holdsOnly(row, WINDOW_FIELDS) || !isWhole(width, 1) || !isWhole(height, 1)) {
    throw invalidOptions(
      "host.display.window takes a width and a height in whole pixels, with an optional x and y.",
    );
  }

  if (x === undefined && y === undefined) {
    return { height, kind: "sized", width };
  }

  if (!isWhole(x, 0) || !isWhole(y, 0)) {
    throw invalidOptions("host.display.window x and y must be given together, as whole pixels.");
  }

  return { height, kind: "sized", position: { x, y }, width };
};

const parseWindow = ({ row, weight }: Entry<number>): WindowPin & { weight: number } => {
  if (fieldOf(row, "maximized") !== undefined) {
    if (!Object.is(fieldOf(row, "maximized"), true) || !holdsOnly(row, MAXIMIZED_FIELDS)) {
      throw invalidOptions(
        "host.display.window rows that maximize take only { maximized: true, weight }, with no size.",
      );
    }

    return { kind: "maximized", weight };
  }

  if (fieldOf(row, "width") === undefined) {
    throw invalidOptions(
      'host.display.window must be "maximized" or a size such as { width: 1440, height: 860 }.',
    );
  }

  return { ...parseSize(row), weight };
};

const parseWindows = (window: unknown) => {
  if (window === "maximized") {
    return [{ kind: "maximized", weight: 1 } as const];
  }

  const entries = tableOf(window, "host.display.window");

  const isSingleMaximizedRow =
    !Array.isArray(window) && entries.some(({ row }) => fieldOf(row, "maximized") !== undefined);

  if (isSingleMaximizedRow) {
    throw invalidOptions(
      'A single maximized host.display.window is written "maximized"; { maximized: true } is only for rows of a weighted table.',
    );
  }

  return entries.map(parseWindow);
};

const parseDisplay = (display: unknown): DisplayTables => {
  if (!isPlainObject(display) || !holdsOnly(display, DISPLAY_FIELDS)) {
    throw invalidOptions("host.display takes screen, taskbar and window.");
  }

  const screen = fieldOf(display, "screen");
  const taskbar = fieldOf(display, "taskbar");
  const window = fieldOf(display, "window");

  return {
    screens:
      screen === undefined ? undefined : tableOf(screen, "host.display.screen").map(parseScreen),
    taskbars:
      taskbar === undefined
        ? undefined
        : tableOf(taskbar, "host.display.taskbar").map(parseTaskbar),
    windows: window === undefined ? undefined : parseWindows(window),
  };
};

const resolveDisplay = (display: unknown): DisplayTables | undefined => {
  if (display === undefined) {
    return undefined;
  }

  const tables = parseDisplay(display);
  const misfit = displayMisfit(tables);

  if (misfit !== undefined) {
    throw invalidOptions(`host.${misfit}`);
  }

  return tables;
};

type HardwareField = "cores" | "memoryGb";

const isCoreCount = (value: unknown): value is number =>
  isWhole(value, 1) && value <= FORK_MAX_CORES;

const isReportableMemory = (value: unknown): value is number =>
  REPORTABLE_MEMORY_GB.some((memory) => memory === value);

const MEMORY_CHOICES = new Intl.ListFormat("en-GB", { type: "disjunction" }).format(
  REPORTABLE_MEMORY_GB.map(String),
);

const HARDWARE_VALUES = {
  cores: {
    isValid: isCoreCount,
    message: `host.hardware.cores must be a positive whole number of at most ${FORK_MAX_CORES}, or a weighted table of them.`,
  },
  memoryGb: {
    isValid: isReportableMemory,
    message: `host.hardware.memoryGb must be ${MEMORY_CHOICES} GB, or a weighted table of them.`,
  },
} as const satisfies Record<
  HardwareField,
  { isValid: (value: unknown) => value is number; message: string }
>;

const parseHardwareField = (
  field: HardwareField,
  value: unknown,
): NonNullable<HardwareTables[HardwareField]> => {
  const { isValid, message } = HARDWARE_VALUES[field];

  if (!Array.isArray(value)) {
    if (!isValid(value)) {
      throw invalidOptions(message);
    }

    return [{ value, weight: 1 }];
  }

  const entries = tableOf(value, `host.hardware.${field}`);

  if (!entries.every(({ row }) => holdsOnly(row, HARDWARE_ROW_FIELDS))) {
    throw invalidOptions(`host.hardware.${field} rows take only a value and a weight.`);
  }

  return entries.map(({ row, weight }) => {
    const entry = fieldOf(row, "value");

    if (!isValid(entry)) {
      throw invalidOptions(message);
    }

    return { value: entry, weight };
  });
};

const parseGpu = (gpu: unknown): NonNullable<HardwareTables["gpu"]> => {
  if (Array.isArray(gpu) && gpu.length === 0) {
    throw invalidOptions(GPU_PERSONAS_EXPECTED);
  }

  const entries = Array.isArray(gpu)
    ? tableOf(gpu, "host.hardware.gpu").map(({ row, weight }) => ({
        fields: row,
        name: fieldOf(row, "name"),
        weight,
      }))
    : [{ fields: {}, name: gpu, weight: 1 }];

  return entries.map(({ fields, name, weight }) => {
    if (!holdsOnly(fields, GPU_ROW_FIELDS) || !isGlPersonaName(name)) {
      throw invalidOptions(GPU_PERSONAS_EXPECTED);
    }

    return { name, weight };
  });
};

const parseGpuPolicy = (policy: unknown): GpuPolicy | undefined => {
  if (policy === undefined) {
    return undefined;
  }

  const parsed = GPU_POLICIES.find((candidate) => candidate === policy);

  if (parsed === undefined) {
    throw invalidOptions('host.hardware.gpuPolicy must be "matched" or "announce".');
  }

  return parsed;
};

const resolveHardware = (hardware: unknown): HardwareTables | undefined => {
  if (hardware === undefined) {
    return undefined;
  }

  if (!isPlainObject(hardware) || !holdsOnly(hardware, HARDWARE_FIELDS)) {
    throw invalidOptions("host.hardware takes cores, memoryGb, gpu and gpuPolicy.");
  }

  const cores = fieldOf(hardware, "cores");
  const gpu = fieldOf(hardware, "gpu");
  const memoryGb = fieldOf(hardware, "memoryGb");

  return {
    cores: cores === undefined ? undefined : parseHardwareField("cores", cores),
    gpu: gpu === undefined ? undefined : parseGpu(gpu),
    gpuPolicy: parseGpuPolicy(fieldOf(hardware, "gpuPolicy")),
    memoryGb: memoryGb === undefined ? undefined : parseHardwareField("memoryGb", memoryGb),
  };
};

const resolveBrowserArgs = (browserArgs: unknown): readonly string[] | undefined => {
  if (browserArgs === undefined) {
    return undefined;
  }

  if (!Array.isArray(browserArgs)) {
    throw invalidOptions("host.browserArgs must be an array of strings.");
  }

  return parseBrowserArgs(browserArgs, "host.browserArgs");
};

export const resolveHostConfig = (value?: unknown): HostSettings => {
  if (value === undefined) {
    return {
      browserArgs: undefined,
      identity: { display: undefined, hardware: undefined, locale: undefined, timezone: undefined },
    };
  }

  if (!isPlainObject(value) || !holdsOnly(value, HOST_FIELDS)) {
    throw invalidOptions("host takes locale, timezone, display, hardware and browserArgs.");
  }

  return {
    browserArgs: resolveBrowserArgs(fieldOf(value, "browserArgs")),
    identity: {
      display: resolveDisplay(fieldOf(value, "display")),
      hardware: resolveHardware(fieldOf(value, "hardware")),
      locale: resolveLocale(fieldOf(value, "locale")),
      timezone: resolveTimezone(fieldOf(value, "timezone")),
    },
  };
};
