import { mergeBrowserInputs } from "./inputs.ts";
import type { BrowserInputs } from "./inputs.ts";
import { EMISSION_ORDER, resolveSurfaces } from "./surfaces.ts";
import type { IdentityContext } from "./surfaces.ts";
import { identityRead } from "./verify.ts";
import type { SurfaceExpectation } from "./verify.ts";

export interface IdentityPlan {
  readonly inputs: BrowserInputs;
  readonly expected: readonly SurfaceExpectation[];
  readonly read: string;
}

export const planIdentity = (context: IdentityContext): IdentityPlan => {
  const resolutions = resolveSurfaces(context);

  return {
    expected: EMISSION_ORDER.flatMap((surface) =>
      resolutions[surface].expected.map((expectation) => ({ ...expectation, surface })),
    ),
    inputs: mergeBrowserInputs(resolutions),
    read: identityRead(context.hostZone),
  };
};
