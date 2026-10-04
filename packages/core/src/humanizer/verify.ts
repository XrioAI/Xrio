import type { Observation } from "./contracts.ts";
import type { SurfaceName } from "./surfaces.ts";

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
