import type { ResolvedMode } from "../types.ts";
import type { HostCapabilities } from "./contracts.ts";
import type { LaunchInput } from "./owned-inputs.ts";
import type { Expectation, Matcher, Observed, ObservedField } from "./verify.ts";

const LOCALE = "en-US";

const ACCEPT_LANGUAGES = "en-US,en";

const SCREEN = { height: 1080, width: 1920, workAreaInset: 40 } as const;

const WINDOW = { height: 900, width: 1600 } as const;

const NETWORK_PREDICTION_NEVER = 2;

export interface IdentityContext {
  readonly mode: Exclude<ResolvedMode["mode"], "http">;
  readonly capabilities: HostCapabilities;
  readonly hostZone: string | undefined;
}

export interface Resolution {
  readonly inputs: readonly LaunchInput[];
  readonly expected: readonly Expectation[];
}

export const EMISSION_ORDER = [
  "locale",
  "timezone",
  "gpu",
  "window",
  "screen",
  "leaks",
  "automation",
] as const;

export type SurfaceName = (typeof EMISSION_ORDER)[number];

export type Resolutions = Readonly<Record<SurfaceName, Resolution>>;

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

const resolveLocale = ({ capabilities }: Pick<IdentityContext, "capabilities">): Resolution => ({
  expected: [
    compatible("languages", equals(ACCEPT_LANGUAGES.split(",")), "fatal"),
    compatible(
      "intlLocale",
      { kind: "same-language", locale: LOCALE },
      capabilities.platform === "linux" ? "fatal" : "note",
    ),
  ],
  inputs: [
    { name: "--lang", sink: "switch", value: LOCALE },
    { name: "--accept-lang", sink: "switch", value: ACCEPT_LANGUAGES },
    { name: "LANG", sink: "environment", value: "C.UTF-8" },
    { name: "LANGUAGE", sink: "environment", value: LOCALE.replace("-", "_") },
    { name: "intl.accept_languages", sink: "preference", value: ACCEPT_LANGUAGES },
  ],
});

const resolveTimezone = ({ hostZone }: Pick<IdentityContext, "hostZone">): Resolution => ({
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
});

const resolveGpu = ({ capabilities }: Pick<IdentityContext, "capabilities">): Resolution => ({
  expected: [],
  inputs:
    capabilities.platform === "linux"
      ? [
          { name: "--use-gl", sink: "switch", value: "angle" },
          { name: "--use-angle", sink: "switch", value: "swiftshader" },
        ]
      : [],
});

const resolveWindow = ({ mode }: Pick<IdentityContext, "mode">): Resolution => ({
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
});

const resolveScreen = ({ mode }: Pick<IdentityContext, "mode">): Resolution => ({
  expected:
    mode === "headless"
      ? [
          compatible("screenWidth", equals(SCREEN.width), "fatal"),
          compatible("screenHeight", equals(SCREEN.height), "fatal"),
          compatible("availWidth", equals(SCREEN.width), "fatal"),
          compatible("availHeight", equals(SCREEN.height - SCREEN.workAreaInset), "fatal"),
        ]
      : [],
  inputs:
    mode === "headless" ? [{ name: "--screen-info", sink: "switch", value: screenInfo() }] : [],
});

const resolveLeaks = (): Resolution => ({
  expected: [],
  inputs: [
    {
      name: "net.network_prediction_options",
      sink: "preference",
      value: NETWORK_PREDICTION_NEVER,
    },
    { name: "dns_over_https.mode", sink: "local-state", value: "off" },
  ],
});

const resolveAutomation = ({
  capabilities,
}: Pick<IdentityContext, "capabilities">): Resolution => ({
  expected: [
    compatible("webdriver", equals(false), "fatal"),
    ...(capabilities.platform === "linux"
      ? [compatible("colorScheme", equals("light"), "note")]
      : []),
  ],
  inputs: [],
});

export const resolveSurfaces = (context: IdentityContext): Resolutions => ({
  automation: resolveAutomation(context),
  gpu: resolveGpu(context),
  leaks: resolveLeaks(),
  locale: resolveLocale(context),
  screen: resolveScreen(context),
  timezone: resolveTimezone(context),
  window: resolveWindow(context),
});
