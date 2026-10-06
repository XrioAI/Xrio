import { isDeepStrictEqual } from "node:util";

import type { ChromeProduct } from "../sources/browser/port.ts";
import { deviceDigest } from "./contracts.ts";
import type {
  AfterCapture,
  ClientHints,
  FontEvidence,
  Observation,
  SecureContextReading,
  WebGpuAdapterReading,
} from "./contracts.ts";
import { FONT_PROBE_FAMILIES, FONT_SENTINEL_FAMILIES } from "./fonts.ts";
import type { FontRead } from "./fonts.ts";
import type { IdentityPlan } from "./humanizer.ts";
import { presentedScreen, recordOf } from "./record.ts";
import { coverageOf, observedOf } from "./report.ts";
import type { BrowserIdentityReport } from "./report.ts";
import type { SurfaceName } from "./surfaces.ts";

const HEADED_WINDOW = { kind: "chrome-default" } as const;

const MEASURED_MAJORS: ReadonlySet<number> = new Set([154]);

const PLAUSIBLE_MIN_WIDTH = 1280;

const PLAUSIBLE_COLOR_DEPTH = 24;

const UNRESOLVED_ZONE = "Etc/Unknown";

const HEADLESS_TOKEN = "HeadlessChrome/";

const WEBGPU_ADAPTER_CAP_MS = 100;

type ReadField = Exclude<keyof Observation, "product" | "afterCapture">;

export type ObservedField = ReadField | "deviceMemory";

export type Observed = Observation[ReadField];

export type Matcher =
  | { readonly kind: "equals"; readonly value: Observed }
  | { readonly kind: "same-language"; readonly locale: string }
  | { readonly kind: "named-zone" }
  | { readonly kind: "zone-offsets" }
  | { readonly kind: "at-most-field"; readonly field: ObservedField }
  | { readonly kind: "no-headless-token" }
  | { readonly kind: "excludes-all"; readonly values: readonly string[] };

export interface Expectation {
  readonly field: ObservedField;
  readonly matcher: Matcher;
  readonly severity: "fatal" | "note";
  readonly compatibility: boolean;
}

export interface SurfaceExpectation extends Expectation {
  readonly surface: SurfaceName;
}

export interface IdentityMismatch {
  readonly surface: SurfaceName;
  readonly field: ObservedField;
  readonly expected: Observed;
  readonly observed: Observed;
}

export type FactTell =
  | "host-zone-utc"
  | "exit-unknown"
  | "speech-persona-skew"
  | "http-profile-skew"
  | "fork-commit-unreadable"
  | "host-fonts"
  | "replay-host-skew"
  | "display-pin-unhonored"
  | "flag-infobar"
  | "hardware-capped"
  | "hardware-unhonored";

export type IdentityTell =
  | "no-taskbar"
  | "display-implausible"
  | "headless-token"
  | "unmeasured-chrome"
  | FactTell
  | "fonts-drift"
  | "hardware-drift";

type ObservedTell = Exclude<IdentityTell, FactTell | "fonts-drift" | "hardware-drift">;

export type FontEvidenceOutcome =
  | { readonly kind: "gathered"; readonly digest: string; readonly sentinel: string }
  | { readonly kind: "confirmed" }
  | { readonly kind: "drifted" }
  | { readonly kind: "unproven" };

export interface Evaluation {
  readonly report: BrowserIdentityReport;
  readonly mismatches: readonly IdentityMismatch[];
  readonly fontEvidence: FontEvidenceOutcome;
}

type Reading = Omit<Observation, "product" | "afterCapture">;

const isText = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isFlag = (value: unknown): value is boolean => typeof value === "boolean";

const isTexts = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isText);

const isTextOrNull = (value: unknown): value is string | null => value === null || isText(value);

const isTextsOrNull = (value: unknown): value is readonly string[] | null =>
  value === null || isTexts(value);

const READING = {
  anyPointer: isTextOrNull,
  availHeight: isNumber,
  availLeft: isNumber,
  availTop: isNumber,
  availWidth: isNumber,
  colorDepth: isNumber,
  colorScheme: isTextOrNull,
  devicePixelRatio: isNumber,
  fontsDigest: isTextOrNull,
  fontsSentinel: isText,
  fontsSentinelResolved: isFlag,
  hardwareConcurrency: isNumber,
  hover: isTextOrNull,
  intlLocale: isText,
  languages: isTexts,
  maxTouchPoints: isNumber,
  outerHeight: isNumber,
  outerWidth: isNumber,
  pointer: isTextOrNull,
  reducedMotion: isTextOrNull,
  requestedOffsets: isTextsOrNull,
  requestedZone: isText,
  screenHeight: isNumber,
  screenWidth: isNumber,
  screenX: isNumber,
  screenY: isNumber,
  userAgent: isText,
  webdriver: isFlag,
  webgl: isFlag,
  webglExtensions: isTextsOrNull,
  webglRenderer: isTextOrNull,
  webglVendor: isTextOrNull,
  zone: isTextOrNull,
  zoneOffsets: isTexts,
} satisfies { readonly [Field in ReadField]: (value: unknown) => value is Reading[Field] };

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

const malformedFieldsOf = (fields: ReadonlyMap<string, unknown>): string[] =>
  Object.entries(READING)
    .filter(([field, isValid]) => !isValid(fields.get(field)))
    .map(([field]) => field);

const isReading = (value: unknown): value is Reading =>
  isObject(value) && malformedFieldsOf(new Map(Object.entries(value))).length === 0;

export const readObservation = (product: ChromeProduct, text: string): Observation => {
  const reading: unknown = JSON.parse(text);

  if (isReading(reading)) {
    return { ...reading, afterCapture: { kind: "not-navigated" }, product };
  }

  const malformed = malformedFieldsOf(new Map(isObject(reading) ? Object.entries(reading) : []));

  throw new Error(`The identity read returned a malformed ${malformed.join(", ")}.`);
};

const isFlagOrNull = (value: unknown): value is boolean | null => value === null || isFlag(value);

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || isNumber(value);

type Guards<Parsed> = {
  readonly [Key in keyof Parsed]-?: (value: unknown) => value is Parsed[Key];
};

type Brands = readonly { brand: string; version: string }[];

const fieldsHold = (
  guards: Readonly<Record<string, (value: unknown) => value is unknown>>,
  fields: ReadonlyMap<string, unknown>,
): boolean => Object.entries(guards).every(([key, isValid]) => isValid(fields.get(key)));

const BRAND = { brand: isText, version: isText } satisfies Guards<Brands[number]>;

const isBrand = (value: unknown): value is Brands[number] =>
  isObject(value) && fieldsHold(BRAND, new Map(Object.entries(value)));

const isBrandsOrNull = (value: unknown): value is Brands | null =>
  value === null || (Array.isArray(value) && value.every(isBrand));

const CLIENT_HINTS = {
  architecture: isTextOrNull,
  bitness: isTextOrNull,
  brands: isBrandsOrNull,
  fullVersionList: isBrandsOrNull,
  mobile: isFlagOrNull,
  model: isTextOrNull,
  platform: isTextOrNull,
  platformVersion: isTextOrNull,
  wow64: isFlagOrNull,
} satisfies Guards<ClientHints>;

const isClientHintsOrNull = (value: unknown): value is ClientHints | null =>
  value === null || (isObject(value) && fieldsHold(CLIENT_HINTS, new Map(Object.entries(value))));

const hasText = (fields: ReadonlyMap<string, unknown>, key: string): boolean =>
  isText(fields.get(key));

const isWebGpuAdapterReading = (value: unknown): value is WebGpuAdapterReading => {
  if (!isObject(value)) {
    return false;
  }

  const fields = new Map(Object.entries(value));

  switch (fields.get("kind")) {
    case "adapter": {
      return hasText(fields, "vendor") && hasText(fields, "architecture");
    }

    case "none":
    case "timed-out":
    case "failed": {
      return true;
    }

    default: {
      return false;
    }
  }
};

const SECURE_CONTEXT_READING = {
  battery: isFlag,
  clientHints: isClientHintsOrNull,
  deviceMemory: isNumberOrNull,
  kind: (value: unknown): value is "secure" => value === "secure",
  webgpu: isFlag,
  webgpuAdapter: isWebGpuAdapterReading,
} satisfies Guards<SecureContextReading>;

const isSecureContextReading = (value: unknown): value is SecureContextReading =>
  isObject(value) && fieldsHold(SECURE_CONTEXT_READING, new Map(Object.entries(value)));

const isInsecureReading = (value: unknown): value is { kind: "insecure" } =>
  isObject(value) && "kind" in value && value.kind === "insecure";

export const readAfterCapture = (text: string): AfterCapture => {
  const reading: unknown = JSON.parse(text);

  if (isSecureContextReading(reading)) {
    return reading;
  }

  if (isInsecureReading(reading)) {
    return { kind: "insecure" };
  }

  throw new Error("The after-capture read returned a malformed reading.");
};

const deviceMemoryOf = ({ afterCapture }: Observation): number | null =>
  afterCapture.kind === "secure" ? afterCapture.deviceMemory : null;

const observedValue = (observation: Observation, field: ObservedField): Observed =>
  field === "deviceMemory" ? deviceMemoryOf(observation) : observation[field];

const languageOf = (locale: string): string => locale.split("-")[0] ?? locale;

const expectedBy = (matcher: Matcher, observation: Observation): Observed => {
  switch (matcher.kind) {
    case "equals": {
      return matcher.value;
    }

    case "same-language": {
      return languageOf(matcher.locale);
    }

    case "named-zone": {
      return observation.requestedZone;
    }

    case "zone-offsets": {
      return observation.requestedOffsets ?? observation.requestedZone;
    }

    case "at-most-field": {
      return observedValue(observation, matcher.field);
    }

    case "no-headless-token": {
      return observation.userAgent.replaceAll(HEADLESS_TOKEN, "Chrome/");
    }

    case "excludes-all": {
      return matcher.values;
    }

    default: {
      throw new Error(`No rule for ${JSON.stringify(matcher satisfies never)}.`);
    }
  }
};

const isTextValue = (value: Observed): value is string => typeof value === "string";

const namesZone = (zone: Observed): boolean => isTextValue(zone) && zone !== UNRESOLVED_ZONE;

const isTextList = (value: Observed): value is readonly string[] => Array.isArray(value);

const isNumberValue = (value: Observed): value is number => typeof value === "number";

const holds = (matcher: Matcher, expected: Observed, observed: Observed): boolean => {
  switch (matcher.kind) {
    case "same-language": {
      return isTextValue(observed) && languageOf(observed) === expected;
    }

    case "at-most-field": {
      return isNumberValue(observed) && isNumberValue(expected) && observed <= expected;
    }

    case "named-zone": {
      return namesZone(observed);
    }

    case "no-headless-token": {
      return isTextValue(observed) && !observed.includes(HEADLESS_TOKEN);
    }

    case "excludes-all": {
      return isTextList(observed) && matcher.values.every((value) => !observed.includes(value));
    }

    case "equals":
    case "zone-offsets": {
      return isDeepStrictEqual(observed, expected);
    }

    default: {
      throw new Error(`No rule for ${JSON.stringify(matcher satisfies never)}.`);
    }
  }
};

const isVerifiable = (matcher: Matcher, observation: Observation): boolean =>
  matcher.kind !== "zone-offsets" || observation.requestedOffsets !== null;

const mismatchOf = (
  { surface, field, matcher }: SurfaceExpectation,
  observation: Observation,
): IdentityMismatch | undefined => {
  if (matcher.kind === "zone-offsets" && !namesZone(observation.zone)) {
    return undefined;
  }

  if (field === "deviceMemory" && deviceMemoryOf(observation) === null) {
    return undefined;
  }

  const expected = expectedBy(matcher, observation);

  const observed = isVerifiable(matcher, observation)
    ? observedValue(observation, field)
    : [observation.zone ?? "", ...observation.zoneOffsets];

  return holds(matcher, expected, observed) ? undefined : { expected, field, observed, surface };
};

export const describeMismatch = (
  { field, surface }: IdentityMismatch,
  { requestedZone }: Observation,
): string => {
  if (field === "zone") {
    return `${surface} ${field} (TZ=${requestedZone}; Chrome named no zone)`;
  }

  return field === "zoneOffsets"
    ? `${surface} ${field} (TZ=${requestedZone})`
    : `${surface} ${field}`;
};

const isMeasured = (product: ChromeProduct): boolean => MEASURED_MAJORS.has(product.major);

const TELLS: Readonly<Record<ObservedTell, (observation: Observation) => boolean>> = {
  "display-implausible": ({ colorDepth, screenWidth }) =>
    screenWidth < PLAUSIBLE_MIN_WIDTH || colorDepth !== PLAUSIBLE_COLOR_DEPTH,
  "headless-token": ({ userAgent }) => userAgent.includes("HeadlessChrome"),
  "no-taskbar": ({ availHeight, availWidth, screenHeight, screenWidth }) =>
    availHeight === screenHeight && availWidth === screenWidth,
  "unmeasured-chrome": ({ product }) => !isMeasured(product),
};

const TELL_ORDER: readonly ObservedTell[] = [
  "no-taskbar",
  "display-implausible",
  "headless-token",
  "unmeasured-chrome",
];

const fontEvidenceOutcome = (
  evidence: FontEvidence | undefined,
  { fontsDigest, fontsSentinel }: Observation,
  { drifted, unresolved }: { readonly drifted: boolean; readonly unresolved: boolean },
): FontEvidenceOutcome => {
  if (evidence !== undefined) {
    return drifted ? { kind: "drifted" } : { kind: "confirmed" };
  }

  if (unresolved) {
    return { kind: "unproven" };
  }

  return fontsDigest === null
    ? { kind: "confirmed" }
    : { digest: fontsDigest, kind: "gathered", sentinel: fontsSentinel };
};

const hardwareDriftOf = (notes: readonly IdentityMismatch[]): readonly "hardware-drift"[] =>
  notes.some(({ surface }) => surface === "hardware") ? ["hardware-drift"] : [];

export const evaluate = (
  {
    chosen,
    expected,
    fontEvidence,
    tells,
  }: Pick<IdentityPlan, "chosen" | "expected" | "fontEvidence" | "tells">,
  observation: Observation,
): Evaluation => {
  const measured = isMeasured(observation.product);

  const record =
    chosen.record ??
    recordOf(
      chosen.seed,
      { screen: presentedScreen(observation), window: HEADED_WINDOW },
      chosen.surfaces,
    );

  const mismatches: IdentityMismatch[] = [];
  const notes: IdentityMismatch[] = [];

  for (const expectation of expected) {
    const mismatch = mismatchOf(expectation, observation);

    const fatal =
      expectation.severity === "fatal" &&
      isVerifiable(expectation.matcher, observation) &&
      (measured || !expectation.compatibility);

    if (mismatch !== undefined) {
      (fatal ? mismatches : notes).push(mismatch);
    }
  }

  const drifted = notes.some(({ surface }) => surface === "fonts");
  const unresolved = notes.some(({ field }) => field === "fontsSentinelResolved");

  return {
    fontEvidence: fontEvidenceOutcome(fontEvidence, observation, { drifted, unresolved }),
    mismatches,
    report: {
      binary: { ...chosen.binary, version: observation.product.version },
      coverage: coverageOf({ fonts: fontEvidence, fontsDrifted: drifted }, observation),
      digests: { device: deviceDigest(record), host: chosen.digests.host },
      exit: chosen.exit,
      mode: chosen.mode,
      notes: structuredClone(notes),
      observed: observedOf(observation, drifted ? undefined : fontEvidence),
      record,
      seed: chosen.seed,
      surfaces: chosen.surfaces,
      tells: [
        ...TELL_ORDER.filter((tell) => TELLS[tell](observation)),
        ...tells,
        ...(drifted ? ["fonts-drift" as const] : []),
        ...hardwareDriftOf(notes),
      ],
    },
  };
};

const READ_SOURCE = `(requested, fonts) => {
  const year = new Date().getFullYear();
  const instants = [Date.UTC(year, 0, 15, 12), Date.UTC(year, 6, 15, 12)];
  const offsetsIn = (timeZone) =>
    instants.map(
      (instant) =>
        new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
          .formatToParts(instant)
          .find((part) => part.type === "timeZoneName").value,
    );
  const requestedOffsets = () => {
    try {
      return offsetsIn(requested);
    } catch {
      return null;
    }
  };
  const media = (feature, values) =>
    values.find((value) => matchMedia("(" + feature + ": " + value + ")").matches) ?? null;
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const generics = ["monospace", "sans-serif", "serif"];
  const measureFont = (() => {
    const context = document.createElement("canvas").getContext("2d");

    return (font) => {
      context.font = "72px " + font;

      return context.measureText("mmmmmmmmmmlli WwEe@#0123456789").width;
    };
  })();
  const fallbackWidths = generics.map((generic) => measureFont(generic));
  const fontRows = (families) =>
    families.map((family) =>
      generics.map((generic) => measureFont(JSON.stringify(family) + ", " + generic)),
    );
  const fontsHash = (rows) => {
    let hash = 0x811c9dc5;

    for (const character of rows.flat().map((width) => width.toFixed(3)).join(",")) {
      hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
    }

    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  const attempt = (read) => {
    try {
      return read();
    } catch {
      return null;
    }
  };
  const webglContext = attempt(() => document.createElement("canvas").getContext("webgl"));
  const webglDebug = webglContext === null ? null : attempt(() => webglContext.getExtension("WEBGL_debug_renderer_info"));
  const webglText = (name) =>
    webglDebug === null
      ? null
      : attempt(() => {
          const value = webglContext.getParameter(webglDebug[name]);

          return typeof value === "string" ? value : null;
        });
  const webglExtensions =
    webglContext === null
      ? null
      : attempt(() => {
          const names = webglContext.getSupportedExtensions();

          return Array.isArray(names) ? names.map(String) : null;
        });
  const sentinelRows = fontRows(${JSON.stringify(FONT_SENTINEL_FAMILIES)});

  return JSON.stringify({
    zone: resolved.timeZone ?? null,
    requestedZone: requested,
    zoneOffsets: offsetsIn(undefined),
    requestedOffsets: requestedOffsets(),
    intlLocale: resolved.locale,
    languages: [...navigator.languages],
    screenWidth: screen.width,
    screenHeight: screen.height,
    availWidth: screen.availWidth,
    availHeight: screen.availHeight,
    availLeft: screen.availLeft,
    availTop: screen.availTop,
    colorDepth: screen.colorDepth,
    outerWidth,
    outerHeight,
    screenX,
    screenY,
    devicePixelRatio,
    fontsSentinel: fontsHash(sentinelRows),
    fontsSentinelResolved: sentinelRows.every((row) => row.some((width, index) => width !== fallbackWidths[index])),
    fontsDigest: fonts === "full" ? fontsHash(fontRows(${JSON.stringify(FONT_PROBE_FAMILIES)})) : null,
    colorScheme: media("prefers-color-scheme", ["dark", "light"]),
    reducedMotion: media("prefers-reduced-motion", ["reduce", "no-preference"]),
    pointer: media("pointer", ["fine", "coarse", "none"]),
    hover: media("hover", ["hover", "none"]),
    anyPointer: media("any-pointer", ["fine", "coarse", "none"]),
    maxTouchPoints: navigator.maxTouchPoints,
    hardwareConcurrency: navigator.hardwareConcurrency,
    webdriver: navigator.webdriver,
    webgl: webglContext !== null,
    webglVendor: webglText("UNMASKED_VENDOR_WEBGL"),
    webglRenderer: webglText("UNMASKED_RENDERER_WEBGL"),
    webglExtensions,
    userAgent: navigator.userAgent,
  });
}`;

const AFTER_CAPTURE_SOURCE = `async (adapterBoundMs) => {
  if (!isSecureContext) {
    return JSON.stringify({ kind: "insecure" });
  }

  const settled = async (read) => {
    try {
      return await read();
    } catch {
      return null;
    }
  };
  const text = (value) => (typeof value === "string" ? value : null);
  const flag = (value) => (typeof value === "boolean" ? value : null);
  const brands = (value) =>
    Array.isArray(value)
      ? value.map(({ brand, version }) => ({ brand: String(brand), version: String(version) }))
      : null;
  const readClientHints = () => settled(async () => {
    const hints = await navigator.userAgentData.getHighEntropyValues([
      "architecture",
      "bitness",
      "fullVersionList",
      "model",
      "platformVersion",
      "wow64",
    ]);

    return {
      architecture: text(hints.architecture),
      bitness: text(hints.bitness),
      brands: brands(hints.brands),
      fullVersionList: brands(hints.fullVersionList),
      mobile: flag(hints.mobile),
      model: text(hints.model),
      platform: text(hints.platform),
      platformVersion: text(hints.platformVersion),
      wow64: flag(hints.wow64),
    };
  });
  const adapterRead = async () => {
    try {
      const adapter = await navigator.gpu.requestAdapter();

      return adapter === null
        ? { kind: "none" }
        : {
            kind: "adapter",
            vendor: String(adapter.info.vendor),
            architecture: String(adapter.info.architecture),
          };
    } catch {
      return { kind: "failed" };
    }
  };
  const readWebgpuAdapter = async () => {
    if (!navigator.gpu) {
      return { kind: "none" };
    }

    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timed-out" }), adapterBoundMs);
    });

    try {
      return await Promise.race([adapterRead(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };
  const [clientHints, webgpuAdapter] = await Promise.all([readClientHints(), readWebgpuAdapter()]);

  return JSON.stringify({
    kind: "secure",
    deviceMemory: typeof navigator.deviceMemory === "number" ? navigator.deviceMemory : null,
    clientHints,
    battery: typeof navigator.getBattery === "function",
    webgpu: "gpu" in navigator,
    webgpuAdapter,
  });
}`;

export const afterCaptureRead = (budgetMs: number): string =>
  `(${AFTER_CAPTURE_SOURCE})(${Math.min(WEBGPU_ADAPTER_CAP_MS, Math.floor(budgetMs / 2))})`;

export const identityRead = (requestedZone: string, fonts: FontRead): string =>
  `(${READ_SOURCE})(${JSON.stringify(requestedZone)}, ${JSON.stringify(fonts)})`;
