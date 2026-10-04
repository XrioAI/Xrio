import type { ExitFacts, Route } from "../proxy/route.ts";
import type { ResolvedMode } from "../types.ts";
import type { GpuChoice, HostCapabilities, Insets, MediaDeviceCounts } from "./contracts.ts";
import type { IdentityIntent } from "./intent.ts";
import { chromeAcceptLanguages } from "./owned-inputs.ts";
import type { LaunchInput } from "./owned-inputs.ts";
import type { Expectation, Matcher, Observed, ObservedField } from "./verify.ts";

export const DEFAULT_LOCALE = "en-US";

const SCREEN = { height: 1080, width: 1920, workAreaInset: 40 } as const;

const WINDOW = { height: 900, width: 1600 } as const;

const NETWORK_PREDICTION_NEVER = 2;

export interface ExitChoice {
  readonly route: Route["kind"];
  readonly facts: ExitFacts;
}

export interface IdentityContext {
  readonly mode: Exclude<ResolvedMode["mode"], "http">;
  readonly capabilities: HostCapabilities;
  readonly pins: IdentityIntent;
  readonly hostZone: string | undefined;
  readonly exit: ExitChoice;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

export interface SurfaceChoices {
  readonly locale: { readonly tag: string; readonly languages: readonly string[] };
  readonly timezone: { readonly source: "host"; readonly zone: string | null };
  readonly gpu: GpuChoice;
  readonly window: { readonly source: "fixed"; readonly size: Size };
  readonly screen:
    | { readonly source: "fixed"; readonly size: Size; readonly workArea: Insets }
    | { readonly source: "host" };
  readonly leaks: { readonly networkPrediction: "off"; readonly dnsOverHttps: "off" };
  readonly media:
    | { readonly source: "fake"; readonly devices: MediaDeviceCounts }
    | { readonly source: "host" };
  readonly automation: null;
}

interface Resolution<Value> {
  readonly inputs: readonly LaunchInput[];
  readonly expected: readonly Expectation[];
  readonly value: Value;
}

export const EMISSION_ORDER = [
  "locale",
  "timezone",
  "gpu",
  "window",
  "screen",
  "leaks",
  "media",
  "automation",
] as const;

export type SurfaceName = (typeof EMISSION_ORDER)[number];

export type Resolutions = {
  readonly [Surface in SurfaceName]: Resolution<SurfaceChoices[Surface]>;
};

const screenInfo = (): string =>
  `{0,0 ${SCREEN.width}x${SCREEN.height} colorDepth=24 devicePixelRatio=1 isInternal=0 rotation=0 ` +
  `workAreaLeft=0 workAreaRight=0 workAreaTop=0 workAreaBottom=${SCREEN.workAreaInset}}`;

const equals = (value: Observed): Matcher => ({ kind: "equals", value });

const atMost = (field: ObservedField): Matcher => ({ field, kind: "at-most-field" });

const compatible = (
  field: ObservedField,
  matcher: Matcher,
  severity: Expectation["severity"],
): Expectation => ({ compatibility: true, field, matcher, severity });

const resolveLocale = ({
  capabilities,
  pins,
}: Pick<IdentityContext, "capabilities" | "pins">): Resolutions["locale"] => {
  const tag = pins.locale ?? DEFAULT_LOCALE;
  const languages = chromeAcceptLanguages(tag);

  if (languages === undefined) {
    throw new Error(`Xrio has not measured Chrome's language list for ${tag}.`);
  }

  const list = languages.join(",");

  return {
    expected: [
      compatible("languages", equals([...languages]), "fatal"),
      compatible(
        "intlLocale",
        { kind: "same-language", locale: tag },
        capabilities.platform === "linux" ? "fatal" : "note",
      ),
    ],
    inputs: [
      { name: "--accept-lang", sink: "switch", value: list },
      { name: "LANG", sink: "environment", value: "C.UTF-8" },
      { name: "LANGUAGE", sink: "environment", value: tag.replace("-", "_") },
      { name: "intl.accept_languages", sink: "preference", value: list },
    ],
    value: { languages: [...languages], tag },
  };
};

const resolveTimezone = ({
  hostZone,
}: Pick<IdentityContext, "hostZone">): Resolutions["timezone"] => ({
  expected:
    hostZone === undefined || hostZone === ""
      ? []
      : [
          {
            compatibility: false,
            field: "zone",
            matcher: { kind: "named-zone" },
            severity: "fatal",
          },
          {
            compatibility: false,
            field: "zoneOffsets",
            matcher: { kind: "zone-offsets" },
            severity: "fatal",
          },
        ],
  inputs:
    hostZone === undefined ? [] : [{ name: "TZ", sink: "forwarded-environment", value: hostZone }],
  value: { source: "host", zone: hostZone ?? null },
});

const resolveGpu = ({ capabilities }: Pick<IdentityContext, "capabilities">): Resolutions["gpu"] =>
  capabilities.platform === "linux"
    ? {
        expected: [],
        inputs: [
          { name: "--use-gl", sink: "switch", value: "angle" },
          { name: "--use-angle", sink: "switch", value: "swiftshader" },
        ],
        value: { backend: "swiftshader", persona: null },
      }
    : { expected: [], inputs: [], value: { backend: "native" } };

const resolveWindow = ({ mode }: Pick<IdentityContext, "mode">): Resolutions["window"] => ({
  expected:
    mode === "headless"
      ? [
          compatible("outerWidth", equals(WINDOW.width), "fatal"),
          compatible("outerHeight", equals(WINDOW.height), "fatal"),
        ]
      : [
          compatible("outerWidth", atMost("availWidth"), "note"),
          compatible("outerHeight", atMost("availHeight"), "note"),
        ],
  inputs: [{ name: "--window-size", sink: "switch", value: `${WINDOW.width},${WINDOW.height}` }],
  value: { size: { height: WINDOW.height, width: WINDOW.width }, source: "fixed" },
});

const resolveScreen = ({ mode }: Pick<IdentityContext, "mode">): Resolutions["screen"] =>
  mode === "headless"
    ? {
        expected: [
          compatible("screenWidth", equals(SCREEN.width), "fatal"),
          compatible("screenHeight", equals(SCREEN.height), "fatal"),
          compatible("availWidth", equals(SCREEN.width), "fatal"),
          compatible("availHeight", equals(SCREEN.height - SCREEN.workAreaInset), "fatal"),
        ],
        inputs: [{ name: "--screen-info", sink: "switch", value: screenInfo() }],
        value: {
          size: { height: SCREEN.height, width: SCREEN.width },
          source: "fixed",
          workArea: { bottom: SCREEN.workAreaInset, left: 0, right: 0, top: 0 },
        },
      }
    : { expected: [], inputs: [], value: { source: "host" } };

const resolveLeaks = (): Resolutions["leaks"] => ({
  expected: [],
  inputs: [
    {
      name: "net.network_prediction_options",
      sink: "preference",
      value: NETWORK_PREDICTION_NEVER,
    },
    { name: "dns_over_https.mode", sink: "local-state", value: "off" },
  ],
  value: { dnsOverHttps: "off", networkPrediction: "off" },
});

const resolveMedia = ({
  capabilities,
}: Pick<IdentityContext, "capabilities">): Resolutions["media"] =>
  capabilities.platform === "linux"
    ? {
        expected: [],
        inputs: [
          { name: "--use-fake-device-for-media-stream", sink: "switch", value: "device-count=0" },
        ],
        value: { devices: { audioinput: 1, audiooutput: 1, videoinput: 0 }, source: "fake" },
      }
    : { expected: [], inputs: [], value: { source: "host" } };

const resolveAutomation = ({
  capabilities,
}: Pick<IdentityContext, "capabilities">): Resolutions["automation"] => ({
  expected: [
    compatible("webdriver", equals(false), "fatal"),
    ...(capabilities.platform === "linux"
      ? [compatible("colorScheme", equals("light"), "note")]
      : []),
  ],
  inputs: [],
  value: null,
});

export const resolveSurfaces = (context: IdentityContext): Resolutions => ({
  automation: resolveAutomation(context),
  gpu: resolveGpu(context),
  leaks: resolveLeaks(),
  locale: resolveLocale(context),
  media: resolveMedia(context),
  screen: resolveScreen(context),
  timezone: resolveTimezone(context),
  window: resolveWindow(context),
});
