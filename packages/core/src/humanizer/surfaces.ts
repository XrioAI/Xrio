import type { ExitFacts, Route } from "../proxy/route.ts";
import type { ResolvedMode } from "../types.ts";
import { knobOf, headlessWindowOf, refuseUnreplayable } from "./contracts.ts";
import type {
  DeviceRecord,
  GpuChoice,
  HostCapabilities,
  Insets,
  MediaDeviceCounts,
  Seed,
} from "./contracts.ts";
import { drawDisplay, windowBounds, workAreaOf } from "./draws.ts";
import type { Bounds, DrawnDisplay } from "./draws.ts";
import { FONT_CONFIG_NAME, fontConfigDigestOf, fontConfigOf, fontConfigPathOf } from "./fonts.ts";
import type { IdentityIntent } from "./intent.ts";
import { chromeAcceptLanguages } from "./owned-inputs.ts";
import type { LaunchInput } from "./owned-inputs.ts";
import type { Expectation, FactTell, Matcher, Observed, ObservedField } from "./verify.ts";
import { canonicalZone } from "./zone-name.ts";

const DEFAULT_LOCALE = "en-US";

const Q_STEP = 0.1;

const HEADED_WINDOW = { height: 900, width: 1600 } as const;

const NETWORK_PREDICTION_NEVER = 2;

const NO_FONT_STACK = "no fontstack/ beside the binary";

export interface ExitChoice {
  readonly route: Route["kind"];
  readonly facts: ExitFacts;
}

type DeviceChoice =
  | { readonly kind: "fresh"; readonly seed: Seed }
  | { readonly kind: "record"; readonly record: DeviceRecord };

export interface IdentityContext {
  readonly mode: Exclude<ResolvedMode["mode"], "http">;
  readonly device: DeviceChoice;
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

type DeviceSource = "drawn" | "record";

export interface SurfaceChoices {
  readonly seed: { readonly source: DeviceChoice["kind"] };
  readonly locale: { readonly tag: string; readonly languages: readonly string[] };
  readonly timezone: { readonly source: "pin" | "exit" | "host"; readonly zone: string };
  readonly gpu: GpuChoice;
  readonly window:
    | ({ readonly source: DeviceSource; readonly kind: "maximized" | "floating" } & Bounds)
    | { readonly source: "fixed"; readonly size: Size };
  readonly screen:
    | {
        readonly source: DeviceSource;
        readonly size: Size;
        readonly workArea: Insets;
        readonly layout: string | null;
      }
    | { readonly source: "host" };
  readonly fonts:
    | { readonly source: "package"; readonly payload: string; readonly config: string }
    | { readonly source: "host"; readonly reason: string | null };
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
  "seed",
  "locale",
  "timezone",
  "gpu",
  "window",
  "screen",
  "fonts",
  "speech",
  "leaks",
  "media",
  "automation",
] as const;

export type SurfaceName = (typeof EMISSION_ORDER)[number];

export type Resolutions = {
  readonly [Surface in SurfaceName]: Resolution<SurfaceChoices[Surface]>;
};

export interface Device {
  readonly seed: Seed;
  readonly source: SurfaceChoices["seed"]["source"];
  readonly display: DrawnDisplay | null;
}

const recordedDisplay = (record: DeviceRecord): DrawnDisplay => ({
  layout: null,
  screen: record.device.screen,
  window: headlessWindowOf(record),
});

export const deviceOf = ({ device, mode }: Pick<IdentityContext, "device" | "mode">): Device => {
  if (device.kind === "fresh") {
    const display = mode === "headed" ? null : drawDisplay(device.seed);

    return { display, seed: device.seed, source: "fresh" };
  }

  const record = refuseUnreplayable(device.record);
  const display = mode === "headed" ? null : recordedDisplay(record);

  return { display, seed: record.seed, source: "record" };
};

const replayPolicy = (context: IdentityContext): IdentityContext => {
  if (context.device.kind === "fresh") {
    return context;
  }

  const { locale, timezone } = context.device.record.policy;

  return {
    ...context,
    followExit: timezone.kind === "exit",
    hostZone: timezone.kind === "host" ? timezone.zone : context.hostZone,
    pins: { locale, timezone: timezone.kind === "pinned" ? timezone.zone : undefined },
  };
};

const sourceOf = ({ source }: Device): DeviceSource => (source === "record" ? "record" : "drawn");

const screenInfo = ({ height, width, workArea }: DrawnDisplay["screen"]): string =>
  `{0,0 ${width}x${height} colorDepth=24 devicePixelRatio=1 isInternal=0 rotation=0 ` +
  `workAreaLeft=${workArea.left} workAreaRight=${workArea.right} ` +
  `workAreaTop=${workArea.top} workAreaBottom=${workArea.bottom}}`;

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

const WEBGL_CONTEXT: Expectation = compatible("webgl", equals(true), "fatal");

const chooseGpu = ({
  platform,
  readableRenderNode,
}: HostCapabilities): Pick<Resolutions["gpu"], "inputs" | "value"> => {
  if (platform !== "linux") {
    return { inputs: [], value: { backend: "native" } };
  }

  return readableRenderNode === true
    ? {
        inputs: [
          { name: "--use-gl", sink: "switch", value: "angle" },
          { name: "--use-angle", sink: "switch", value: "vulkan" },
        ],
        value: { backend: "native" },
      }
    : {
        inputs: [{ name: "--enable-unsafe-swiftshader", sink: "switch" }],
        value: { backend: "swiftshader", persona: null },
      };
};

const resolveGpu = ({
  capabilities,
}: Pick<IdentityContext, "capabilities">): Resolutions["gpu"] => ({
  expected: [WEBGL_CONTEXT],
  ...chooseGpu(capabilities),
});

const resolveHeadedWindow = (): Resolutions["window"] => ({
  expected: [
    compatible("outerWidth", atMost("availWidth"), "note"),
    compatible("outerHeight", atMost("availHeight"), "note"),
  ],
  inputs: [
    {
      name: "--window-size",
      sink: "switch",
      value: `${HEADED_WINDOW.width},${HEADED_WINDOW.height}`,
    },
  ],
  value: { size: { ...HEADED_WINDOW }, source: "fixed" },
});

const resolveWindow = (device: Device): Resolutions["window"] => {
  const { display } = device;

  if (display === null) {
    return resolveHeadedWindow();
  }

  const bounds = windowBounds(display.screen, display.window);

  return {
    expected: [
      compatible("outerWidth", equals(bounds.width), "fatal"),
      compatible("outerHeight", equals(bounds.height), "fatal"),
      compatible("screenX", equals(bounds.x), "fatal"),
      compatible("screenY", equals(bounds.y), "fatal"),
    ],
    inputs: [
      { name: "--window-size", sink: "switch", value: `${bounds.width},${bounds.height}` },
      { name: "--window-position", sink: "switch", value: `${bounds.x},${bounds.y}` },
    ],
    value: {
      height: bounds.height,
      kind: display.window.kind,
      source: sourceOf(device),
      width: bounds.width,
      x: bounds.x,
      y: bounds.y,
    },
  };
};

const screenExpectations = (
  screen: DrawnDisplay["screen"],
  severity: Expectation["severity"],
): Expectation[] => {
  const area = workAreaOf(screen);

  return [
    compatible("screenWidth", equals(screen.width), severity),
    compatible("screenHeight", equals(screen.height), severity),
    compatible("availWidth", equals(area.width), severity),
    compatible("availHeight", equals(area.height), severity),
    compatible("availLeft", equals(area.x), severity),
    compatible("availTop", equals(area.y), severity),
  ];
};

const resolveHostScreen = ({ device }: Pick<IdentityContext, "device">): Resolutions["screen"] => ({
  expected: device.kind === "record" ? screenExpectations(device.record.device.screen, "note") : [],
  inputs: [],
  value: { source: "host" },
});

const resolveScreen = (
  context: Pick<IdentityContext, "device">,
  device: Device,
): Resolutions["screen"] => {
  if (device.display === null) {
    return resolveHostScreen(context);
  }

  const { layout, screen } = device.display;

  return {
    expected: screenExpectations(screen, "fatal"),
    inputs: [{ name: "--screen-info", sink: "switch", value: screenInfo(screen) }],
    value: {
      layout,
      size: { height: screen.height, width: screen.width },
      source: sourceOf(device),
      workArea: { ...screen.workArea },
    },
  };
};

const fontNote = (field: ObservedField, value: Observed): Expectation => ({
  compatibility: false,
  field,
  matcher: equals(value),
  severity: "note",
});

const sentinelOf = (
  evidence: HostCapabilities["fontEvidence"],
  pinned: boolean,
): readonly Expectation[] => [
  ...(evidence === undefined ? [] : [fontNote("fontsSentinel", evidence.sentinel)]),
  ...(pinned ? [fontNote("fontsSentinelResolved", true)] : []),
];

const resolveFonts = ({
  capabilities,
}: Pick<IdentityContext, "capabilities">): Resolutions["fonts"] => {
  const { fontEvidence, fontStack } = capabilities;

  if (capabilities.platform !== "linux") {
    return {
      expected: sentinelOf(fontEvidence, false),
      inputs: [],
      value: { reason: null, source: "host" },
    };
  }

  if (fontStack?.kind !== "checked") {
    return {
      expected: sentinelOf(fontEvidence, false),
      inputs: [],
      tells: ["host-fonts"],
      value: { reason: fontStack?.reason ?? NO_FONT_STACK, source: "host" },
    };
  }

  const config = fontConfigOf(fontStack);

  return {
    expected: sentinelOf(fontEvidence, true),
    inputs: [
      {
        contents: config,
        file: FONT_CONFIG_NAME,
        name: "FONTCONFIG_FILE",
        sink: "file-environment",
      },
      { name: "FONTCONFIG_PATH", sink: "environment", value: fontConfigPathOf(fontStack) },
    ],
    value: { config: fontConfigDigestOf(fontStack), payload: fontStack.payload, source: "package" },
  };
};

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

export const resolveSurfaces = (context: IdentityContext): Resolutions => {
  const replayed = replayPolicy(context);
  const device = deviceOf(context);

  return {
    automation: resolveAutomation(replayed),
    fonts: resolveFonts(replayed),
    gpu: resolveGpu(replayed),
    leaks: resolveLeaks(),
    locale: resolveLocale(replayed),
    media: resolveMedia(replayed),
    screen: resolveScreen(replayed, device),
    seed: { expected: [], inputs: [], value: { source: device.source } },
    speech: resolveSpeech(replayed),
    timezone: resolveTimezone(replayed),
    window: resolveWindow(device),
  };
};
