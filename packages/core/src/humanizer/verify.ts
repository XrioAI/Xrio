import { isDeepStrictEqual } from "node:util";

import type { ChromeProduct } from "../sources/browser/port.ts";
import type { Observation } from "./contracts.ts";
import type { IdentityPlan } from "./humanizer.ts";
import { coverageOf, observedOf } from "./report.ts";
import type { BrowserIdentityReport } from "./report.ts";
import type { SurfaceName } from "./surfaces.ts";

const MEASURED_MAJORS: ReadonlySet<number> = new Set([154]);

const PLAUSIBLE_MIN_WIDTH = 1280;

const PLAUSIBLE_COLOR_DEPTH = 24;

const UNRESOLVED_ZONE = "Etc/Unknown";

export type ObservedField = Exclude<keyof Observation, "product">;

export type Observed = Observation[ObservedField];

export type Matcher =
  | { readonly kind: "equals"; readonly value: Observed }
  | { readonly kind: "same-language"; readonly locale: string }
  | { readonly kind: "named-zone" }
  | { readonly kind: "zone-offsets" }
  | { readonly kind: "at-most-field"; readonly field: ObservedField };

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

export type IdentityTell =
  | "no-taskbar"
  | "display-implausible"
  | "headless-token"
  | "unmeasured-chrome"
  | "zone-unverified";

export interface Evaluation {
  readonly report: BrowserIdentityReport;
  readonly mismatches: readonly IdentityMismatch[];
}

type Reading = Omit<Observation, "product">;

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
  availWidth: isNumber,
  colorDepth: isNumber,
  colorScheme: isTextOrNull,
  devicePixelRatio: isNumber,
  hover: isTextOrNull,
  intlLocale: isText,
  languages: isTexts,
  maxTouchPoints: isNumber,
  outerHeight: isNumber,
  outerWidth: isNumber,
  pointer: isTextOrNull,
  reducedMotion: isTextOrNull,
  requestedOffsets: isTextsOrNull,
  requestedZone: isTextOrNull,
  screenHeight: isNumber,
  screenWidth: isNumber,
  userAgent: isText,
  webdriver: isFlag,
  zone: isTextOrNull,
  zoneOffsets: isTexts,
} satisfies { readonly [Field in ObservedField]: (value: unknown) => value is Reading[Field] };

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
    return { ...reading, product };
  }

  const malformed = malformedFieldsOf(new Map(isObject(reading) ? Object.entries(reading) : []));

  throw new Error(`The identity read returned a malformed ${malformed.join(", ")}.`);
};

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
      return observation[matcher.field];
    }

    default: {
      throw new Error(`No rule for ${JSON.stringify(matcher satisfies never)}.`);
    }
  }
};

const isTextValue = (value: Observed): value is string => typeof value === "string";

const namesZone = (zone: Observed): boolean => isTextValue(zone) && zone !== UNRESOLVED_ZONE;

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

  const expected = expectedBy(matcher, observation);

  const observed = isVerifiable(matcher, observation)
    ? observation[field]
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

const TELLS: Readonly<Record<IdentityTell, (observation: Observation) => boolean>> = {
  "display-implausible": ({ colorDepth, screenWidth }) =>
    screenWidth < PLAUSIBLE_MIN_WIDTH || colorDepth !== PLAUSIBLE_COLOR_DEPTH,
  "headless-token": ({ userAgent }) => userAgent.includes("HeadlessChrome"),
  "no-taskbar": ({ availHeight, screenHeight }) => availHeight === screenHeight,
  "unmeasured-chrome": ({ product }) => !isMeasured(product),
  "zone-unverified": ({ requestedOffsets, requestedZone, zone }) =>
    requestedZone !== null && requestedOffsets === null && namesZone(zone),
};

const TELL_ORDER: readonly IdentityTell[] = [
  "no-taskbar",
  "display-implausible",
  "headless-token",
  "unmeasured-chrome",
  "zone-unverified",
];

export const evaluate = (
  { chosen, expected }: Pick<IdentityPlan, "chosen" | "expected">,
  observation: Observation,
): Evaluation => {
  const measured = isMeasured(observation.product);
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

  return {
    mismatches,
    report: {
      binary: { version: observation.product.version },
      coverage: coverageOf(observation),
      exit: chosen.exit,
      mode: chosen.mode,
      notes: structuredClone(notes),
      observed: observedOf(observation),
      surfaces: chosen.surfaces,
      tells: TELL_ORDER.filter((tell) => TELLS[tell](observation)),
    },
  };
};

const READ_SOURCE = `(requested) => {
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
      return requested === null ? null : offsetsIn(requested.replace(/^:/, "").replace(/^(?:posix|right)[/]/, ""));
    } catch {
      return null;
    }
  };
  const media = (feature, values) =>
    values.find((value) => matchMedia("(" + feature + ": " + value + ")").matches) ?? null;
  const resolved = Intl.DateTimeFormat().resolvedOptions();

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
    colorDepth: screen.colorDepth,
    outerWidth,
    outerHeight,
    devicePixelRatio,
    colorScheme: media("prefers-color-scheme", ["dark", "light"]),
    reducedMotion: media("prefers-reduced-motion", ["reduce", "no-preference"]),
    pointer: media("pointer", ["fine", "coarse", "none"]),
    hover: media("hover", ["hover", "none"]),
    anyPointer: media("any-pointer", ["fine", "coarse", "none"]),
    maxTouchPoints: navigator.maxTouchPoints,
    webdriver: navigator.webdriver,
    userAgent: navigator.userAgent,
  });
}`;

export const identityRead = (requestedZone: string | undefined): string =>
  `(${READ_SOURCE})(${JSON.stringify(requestedZone === "" ? null : (requestedZone ?? null))})`;
