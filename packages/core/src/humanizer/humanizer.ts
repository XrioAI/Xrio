import { mergeBrowserInputs } from "./inputs.ts";
import type { BrowserInputs } from "./inputs.ts";
import { EMISSION_ORDER, resolveSurfaces } from "./surfaces.ts";
import type { ExitChoice, IdentityContext, Resolutions, SurfaceChoices } from "./surfaces.ts";
import { AFTER_CAPTURE_READ, identityRead } from "./verify.ts";
import type { SurfaceExpectation } from "./verify.ts";

interface ChosenIdentity {
  readonly mode: IdentityContext["mode"];
  readonly exit: ExitChoice;
  readonly surfaces: SurfaceChoices;
}

export interface IdentityPlan {
  readonly inputs: BrowserInputs;
  readonly expected: readonly SurfaceExpectation[];
  readonly read: { readonly beforeNavigation: string; readonly afterCapture: string };
  readonly chosen: ChosenIdentity;
}

const choicesOf = (resolutions: Resolutions): SurfaceChoices => ({
  automation: resolutions.automation.value,
  gpu: resolutions.gpu.value,
  leaks: resolutions.leaks.value,
  locale: resolutions.locale.value,
  screen: resolutions.screen.value,
  timezone: resolutions.timezone.value,
  window: resolutions.window.value,
});

export const planIdentity = (context: IdentityContext): IdentityPlan => {
  const resolutions = resolveSurfaces(context);

  return {
    chosen: { exit: context.exit, mode: context.mode, surfaces: choicesOf(resolutions) },
    expected: EMISSION_ORDER.flatMap((surface) =>
      resolutions[surface].expected.map((expectation) => ({ ...expectation, surface })),
    ),
    inputs: mergeBrowserInputs(resolutions),
    read: { afterCapture: AFTER_CAPTURE_READ, beforeNavigation: identityRead(context.hostZone) },
  };
};
