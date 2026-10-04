import type { BrowserProfile, EmulationOS } from "wreq-js";

import type { ForkFacts } from "./contracts.ts";
import { mergeBrowserInputs } from "./inputs.ts";
import type { BrowserInputs } from "./inputs.ts";
import type { IdentityIntent } from "./intent.ts";
import { httpReport } from "./report.ts";
import type { HttpIdentityReport } from "./report.ts";
import { EMISSION_ORDER, presentedLocale, resolveSurfaces } from "./surfaces.ts";
import type { ExitChoice, IdentityContext, Resolutions, SurfaceChoices } from "./surfaces.ts";
import { AFTER_CAPTURE_READ, identityRead } from "./verify.ts";
import type { FactTell, SurfaceExpectation } from "./verify.ts";

interface ChosenIdentity {
  readonly mode: IdentityContext["mode"];
  readonly fork: ForkFacts["dialect"] | null;
  readonly exit: ExitChoice;
  readonly surfaces: SurfaceChoices;
}

export interface IdentityPlan {
  readonly inputs: BrowserInputs;
  readonly expected: readonly SurfaceExpectation[];
  readonly read: { readonly beforeNavigation: string; readonly afterCapture: string };
  readonly tells: readonly FactTell[];
  readonly chosen: ChosenIdentity;
}

const choicesOf = (resolutions: Resolutions): SurfaceChoices => ({
  automation: resolutions.automation.value,
  gpu: resolutions.gpu.value,
  leaks: resolutions.leaks.value,
  locale: resolutions.locale.value,
  media: resolutions.media.value,
  screen: resolutions.screen.value,
  speech: resolutions.speech.value,
  timezone: resolutions.timezone.value,
  window: resolutions.window.value,
});

export const planIdentity = (context: IdentityContext): IdentityPlan => {
  const resolutions = resolveSurfaces(context);

  return {
    chosen: {
      exit: context.exit,
      fork: context.capabilities.fork?.dialect ?? null,
      mode: context.mode,
      surfaces: choicesOf(resolutions),
    },
    expected: EMISSION_ORDER.flatMap((surface) =>
      resolutions[surface].expected.map((expectation) => ({ ...expectation, surface })),
    ),
    inputs: mergeBrowserInputs(resolutions),
    read: {
      afterCapture: AFTER_CAPTURE_READ,
      beforeNavigation: identityRead(resolutions.timezone.value.zone),
    },
    tells: EMISSION_ORDER.flatMap((surface) => resolutions[surface].tells ?? []),
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
  readonly report: HttpIdentityReport;
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
    report: httpReport(tag, HTTP_PROFILE),
  };
};
