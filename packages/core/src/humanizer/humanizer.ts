import { isDeepStrictEqual } from "node:util";

import type { BrowserProfile, EmulationOS } from "wreq-js";

import { deviceDigest, hostDigest } from "./contracts.ts";
import type { DeviceRecord, FontEvidence, ForkFacts, HostCapabilities } from "./contracts.ts";
import { mergeBrowserInputs } from "./inputs.ts";
import type { BrowserInputs } from "./inputs.ts";
import type { IdentityIntent } from "./intent.ts";
import { fontsOf, recordOf, voicesOf } from "./record.ts";
import { httpReport } from "./report.ts";
import type { HttpIdentityReport } from "./report.ts";
import { deviceOf, EMISSION_ORDER, presentedLocale, resolveSurfaces } from "./surfaces.ts";
import type {
  Device,
  ExitChoice,
  IdentityContext,
  Resolutions,
  SurfaceChoices,
} from "./surfaces.ts";
import { AFTER_CAPTURE_READ, identityRead } from "./verify.ts";
import type { FactTell, SurfaceExpectation } from "./verify.ts";

interface ChosenIdentity {
  readonly mode: IdentityContext["mode"];
  readonly binary: {
    readonly fork: ForkFacts["dialect"] | null;
    readonly commit: string | null;
    readonly dirty: number | null;
  };
  readonly seed: Device["seed"];
  readonly record: DeviceRecord | null;
  readonly digests: { readonly device: string | null; readonly host: string };
  readonly exit: ExitChoice;
  readonly surfaces: SurfaceChoices;
}

export interface IdentityPlan {
  readonly inputs: BrowserInputs;
  readonly expected: readonly SurfaceExpectation[];
  readonly read: { readonly beforeNavigation: string; readonly afterCapture: string };
  readonly tells: readonly FactTell[];
  readonly chosen: ChosenIdentity;
  readonly fontEvidence: FontEvidence | undefined;
}

const choicesOf = (resolutions: Resolutions): SurfaceChoices => ({
  automation: resolutions.automation.value,
  fonts: resolutions.fonts.value,
  gpu: resolutions.gpu.value,
  leaks: resolutions.leaks.value,
  locale: resolutions.locale.value,
  media: resolutions.media.value,
  screen: resolutions.screen.value,
  seed: resolutions.seed.value,
  speech: resolutions.speech.value,
  timezone: resolutions.timezone.value,
  window: resolutions.window.value,
});

const hostSkewed = (record: DeviceRecord, surfaces: SurfaceChoices): boolean =>
  !isDeepStrictEqual(record.device.gpu, surfaces.gpu) ||
  !isDeepStrictEqual(record.device.fonts, fontsOf(surfaces)) ||
  !isDeepStrictEqual(record.device.voices, voicesOf(surfaces.speech));

const recordFor = (
  { device }: IdentityContext,
  { display, seed }: Device,
  surfaces: SurfaceChoices,
): DeviceRecord | null => {
  if (device.kind === "record") {
    return structuredClone(device.record);
  }

  return display === null ? null : recordOf(seed, display, surfaces);
};

export const planIdentity = (context: IdentityContext): IdentityPlan => {
  const resolutions = resolveSurfaces(context);
  const device = deviceOf(context);
  const surfaces = choicesOf(resolutions);
  const record = recordFor(context, device, surfaces);
  const skewed = context.device.kind === "record" && hostSkewed(context.device.record, surfaces);

  return {
    chosen: {
      binary: {
        commit: context.capabilities.fork?.commit ?? null,
        dirty: context.capabilities.fork?.dirty ?? null,
        fork: context.capabilities.fork?.dialect ?? null,
      },
      digests: {
        device: record === null ? null : deviceDigest(record),
        host: hostDigest(context.capabilities),
      },
      exit: context.exit,
      mode: context.mode,
      record,
      seed: device.seed,
      surfaces,
    },
    expected: EMISSION_ORDER.flatMap((surface) =>
      resolutions[surface].expected.map((expectation) => ({ ...expectation, surface })),
    ),
    fontEvidence: context.capabilities.fontEvidence,
    inputs: mergeBrowserInputs(resolutions),
    read: {
      afterCapture: AFTER_CAPTURE_READ,
      beforeNavigation: identityRead(
        resolutions.timezone.value.zone,
        context.capabilities.fontEvidence === undefined ? "full" : "sentinel",
      ),
    },
    tells: [
      ...EMISSION_ORDER.flatMap((surface) => resolutions[surface].tells ?? []),
      ...(context.capabilities.fork?.buildUnreadable === true
        ? ["fork-commit-unreadable" as const]
        : []),
      ...(skewed ? ["replay-host-skew" as const] : []),
    ],
  };
};

const HTTP_PROFILE = { chromeMajor: 149, platform: "linux" } as const;

const HTTP_HEADER_ORDER = [
  "Host",
  "Connection",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "Upgrade-Insecure-Requests",
  "User-Agent",
  "Accept",
  "Sec-Fetch-Site",
  "Sec-Fetch-Mode",
  "Sec-Fetch-User",
  "Sec-Fetch-Dest",
  "Accept-Encoding",
  "Accept-Language",
  "Priority",
  "Cookie",
] as const;

export interface HttpInputs {
  readonly browser: BrowserProfile;
  readonly os: EmulationOS;
  readonly headers: Readonly<Record<string, string>>;
  readonly headerOrder: readonly string[];
}

export interface HttpPlan {
  readonly inputs: HttpInputs;
  readonly report: (client: HostCapabilities | null) => HttpIdentityReport;
}

export const httpIdentity = (pins: IdentityIntent): HttpPlan => {
  const { header, tag } = presentedLocale(pins);

  return {
    inputs: {
      browser: `chrome_${HTTP_PROFILE.chromeMajor}`,
      headerOrder: HTTP_HEADER_ORDER,
      headers: { "accept-language": header },
      os: HTTP_PROFILE.platform,
    },
    report: (client) => httpReport(tag, HTTP_PROFILE, client),
  };
};
