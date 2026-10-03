import { mergeBrowserInputs } from "./inputs.ts";
import type { BrowserInputs } from "./inputs.ts";
import { resolveSurfaces } from "./surfaces.ts";
import type { IdentityContext } from "./surfaces.ts";

export interface IdentityPlan {
  readonly inputs: BrowserInputs;
}

export const planIdentity = (context: IdentityContext): IdentityPlan => ({
  inputs: mergeBrowserInputs(resolveSurfaces(context)),
});
