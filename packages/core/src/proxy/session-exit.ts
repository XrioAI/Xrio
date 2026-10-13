import type { Deadline } from "../deadline.ts";
import { canonicalZone } from "../humanizer/zone-name.ts";
import { parseProxy } from "../options.ts";
import type { SessionBinding } from "../sources/visit.ts";
import type { ProxyEndpoint } from "../types.ts";
import type { ProxyObservation } from "./info.ts";
import type { ProxyManager } from "./manager.ts";

const STICKY_ID_REDRAWS = 3;

type SessionExit =
  | {
      readonly kind: "bound";
      readonly proxy: ProxyEndpoint | undefined;
      readonly binding: SessionBinding | undefined;
      readonly observation: ProxyObservation | undefined;
    }
  | { readonly kind: "changed" };

interface ExitRoute {
  readonly binding: SessionBinding | undefined;
  readonly proxy: ProxyEndpoint | undefined;
  readonly manager: ProxyManager | undefined;
  readonly drawStickyId: () => string;
  readonly observe: (proxy: ProxyEndpoint, deadline: Deadline) => Promise<ProxyObservation>;
}

type ExitRegion = Extract<SessionBinding, { kind: "proxy" }>["region"];

const CHANGED = { kind: "changed" } as const;

const regionOf = (observation: ProxyObservation): ExitRegion => ({
  country: observation.country,
  zone: canonicalZone(observation.timezone) ?? observation.timezone,
});

const keepsRegion = (binding: SessionBinding | undefined, region: ExitRegion): boolean =>
  binding?.kind !== "proxy" ||
  (region.country === binding.region.country && region.zone === binding.region.zone);

const switchesRouteKind = (
  binding: SessionBinding | undefined,
  proxy: ProxyEndpoint | undefined,
): boolean =>
  (binding?.kind === "direct" && proxy !== undefined) ||
  (binding?.kind === "proxy" && proxy === undefined);

const proxiedBinding = (
  binding: SessionBinding | undefined,
  stickyId: string | undefined,
  region: ExitRegion,
): SessionBinding | undefined =>
  binding === undefined
    ? undefined
    : {
        kind: "proxy",
        region: binding.kind === "proxy" ? binding.region : region,
        stickyId: stickyId ?? binding.stickyId,
      };

const stickyProxy = (
  routed: ProxyEndpoint,
  manager: ProxyManager | undefined,
  stickyId: string | undefined,
): ProxyEndpoint =>
  manager === undefined || stickyId === undefined
    ? routed
    : parseProxy(manager.connectionFor(stickyId));

export const firstExitProxy = ({
  binding,
  manager,
  proxy,
}: Pick<ExitRoute, "binding" | "manager" | "proxy">): ProxyEndpoint | undefined =>
  proxy === undefined || switchesRouteKind(binding, proxy)
    ? undefined
    : stickyProxy(proxy, manager, binding?.stickyId);

const directExit = (binding: SessionBinding | undefined): SessionExit => ({
  binding: binding === undefined ? undefined : { kind: "direct", stickyId: binding.stickyId },
  kind: "bound",
  observation: undefined,
  proxy: undefined,
});

export const bindSessionExit = async (
  route: ExitRoute,
  deadline: Deadline,
): Promise<SessionExit> => {
  const { binding, drawStickyId, manager, observe, proxy: routed } = route;

  if (switchesRouteKind(binding, routed)) {
    return CHANGED;
  }

  if (routed === undefined) {
    return directExit(binding);
  }

  let stickyId = binding?.stickyId;

  // oxlint-disable no-await-in-loop -- Each sticky id is observed before the next one is drawn.
  for (let redraws = 0; ; redraws += 1) {
    deadline.throwIfExpired();

    const proxy = stickyProxy(routed, manager, stickyId);
    const observation = await observe(proxy, deadline);
    const region = regionOf(observation);

    if (keepsRegion(binding, region)) {
      return {
        binding: proxiedBinding(binding, stickyId, region),
        kind: "bound",
        observation,
        proxy,
      };
    }

    if (manager?.managesSessions !== true || redraws === STICKY_ID_REDRAWS) {
      return CHANGED;
    }

    stickyId = drawStickyId();
  }
  // oxlint-enable no-await-in-loop
};
