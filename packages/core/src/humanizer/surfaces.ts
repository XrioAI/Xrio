import type { ExitFacts, Route } from "../proxy/route.ts";
import type { ResolvedMode } from "../types.ts";
import { knobOf } from "./contracts.ts";
import type { GpuChoice, HostCapabilities, Insets, MediaDeviceCounts } from "./contracts.ts";
import type { IdentityIntent } from "./intent.ts";
import { chromeAcceptLanguages } from "./owned-inputs.ts";
import type { LaunchInput } from "./owned-inputs.ts";
import type { Expectation, FactTell, Matcher, Observed, ObservedField } from "./verify.ts";
import { canonicalZone } from "./zone-name.ts";

const DEFAULT_LOCALE = "en-US";

const Q_STEP = 0.1;

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
  readonly hostZone: string;
  readonly exit: ExitChoice;
  readonly followExit?: boolean;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

export interface SurfaceChoices {
  readonly locale: { readonly tag: string; readonly languages: readonly string[] };
  readonly timezone: { readonly source: "pin" | "exit" | "host"; readonly zone: string };
  readonly gpu: GpuChoice;
  readonly window: { readonly source: "fixed"; readonly size: Size };
  readonly screen:
    | { readonly source: "fixed"; readonly size: Size; readonly workArea: Insets }
    | { readonly source: "host" };
  readonly speech: { readonly persona: string | null };
  readonly leaks: { readonly networkPrediction: "off"; readonly dnsOverHttps: "off" };
  readonly media:
    | { readonly source: "fake"; readonly devices: MediaDeviceCounts }
    | { readonly source: "host" };
  readonly automation: null;
}

interface Resolution<Value> {
  readonly inputs: readonly LaunchInput[];
  readonly expected: readonly Expectation[];
  readonly tells?: readonly FactTell[];
  readonly value: Value;
}

export const EMISSION_ORDER = [
  "locale",
  "timezone",
  "gpu",
  "window",
  "screen",
  "speech",
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

const acceptLanguageHeader = (languages: readonly string[]): string =>
  languages
    .map((language, index) =>
      index === 0 ? language : `${language};q=${(1 - index * Q_STEP).toFixed(1)}`,
    )
    .join(",");

export const presentedLocale = ({ locale }: IdentityIntent) => {
  const tag = locale ?? DEFAULT_LOCALE;
  const languages = chromeAcceptLanguages(tag);

  if (languages === undefined) {
    throw new Error(`Xrio has not measured Chrome's language list for ${tag}.`);
  }

  return { header: acceptLanguageHeader(languages), languages, tag };
};

const resolveLocale = ({
  capabilities,
  pins,
}: Pick<IdentityContext, "capabilities" | "pins">): Resolutions["locale"] => {
  const { languages, tag } = presentedLocale(pins);
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

const exitZone = ({ facts }: ExitChoice): string | undefined =>
  facts.kind === "observed" ? canonicalZone(facts.zone) : undefined;

const chooseZone = ({
  exit,
  followExit = false,
  hostZone,
  pins,
}: Pick<
  IdentityContext,
  "exit" | "followExit" | "hostZone" | "pins"
>): SurfaceChoices["timezone"] => {
  const pin = canonicalZone(pins.timezone);

  if (pin !== undefined) {
    return { source: "pin", zone: pin };
  }

  const zone = followExit ? exitZone(exit) : undefined;

  return zone === undefined ? { source: "host", zone: hostZone } : { source: "exit", zone };
};

const hostZoneTell = ({
  exit,
  hostZone,
}: Pick<IdentityContext, "exit" | "hostZone">): FactTell | undefined => {
  if (exit.route === "direct") {
    return hostZone === "UTC" ? "host-zone-utc" : undefined;
  }

  return exit.facts.kind === "unknown" ? "exit-unknown" : undefined;
};

const resolveTimezone = (
  context: Pick<IdentityContext, "exit" | "followExit" | "hostZone" | "pins">,
): Resolutions["timezone"] => {
  const choice = chooseZone(context);
  const tell = choice.source === "host" ? hostZoneTell(context) : undefined;

  return {
    expected: [
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
    inputs: [{ name: "TZ", sink: "environment", value: choice.zone }],
    tells: tell === undefined ? [] : [tell],
    value: choice,
  };
};

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

const resolveSpeech = ({
  capabilities,
}: Pick<IdentityContext, "capabilities">): Resolutions["speech"] => {
  const persona = knobOf(capabilities, "speech-persona");
  const artifact = capabilities.fork?.personas.speech.find(({ name }) => name === persona);
  const skewed = persona !== null && artifact?.chromeVersion !== capabilities.fork?.version;

  return {
    expected: [],
    inputs: [],
    tells: skewed ? ["speech-persona-skew"] : [],
    value: { persona },
  };
};

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

const NO_HEADLESS_TOKEN: Expectation = {
  compatibility: false,
  field: "userAgent",
  matcher: { kind: "no-headless-token" },
  severity: "fatal",
};

const resolveAutomation = ({
  capabilities,
}: Pick<IdentityContext, "capabilities">): Resolutions["automation"] => ({
  expected: [
    compatible("webdriver", equals(false), "fatal"),
    ...(knobOf(capabilities, "suppress-headless-token") === "true" ? [NO_HEADLESS_TOKEN] : []),
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
  speech: resolveSpeech(context),
  timezone: resolveTimezone(context),
  window: resolveWindow(context),
});
