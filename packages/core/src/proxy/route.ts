import { createHash } from "node:crypto";

import type { ExitFacts } from "../humanizer/contracts.ts";
import type { ProxyEndpoint } from "../types.ts";
import type { ProxyObservation } from "./info.ts";

type RouteKey = string;

export type Route =
  | { readonly kind: "direct" }
  | {
      readonly kind: "proxy";
      readonly endpoint: ProxyEndpoint;
      readonly key: RouteKey;
      readonly generation: number;
      readonly expectation: {
        readonly stability: "static" | "sticky" | "rotating" | "unknown";
        readonly expiresAt?: number;
        readonly destinations: "all" | readonly string[];
      };
    };

const routeKeyOf = ({ credentials, hostname, port, protocol }: ProxyEndpoint): RouteKey =>
  createHash("sha256")
    .update(JSON.stringify([protocol, hostname, port, credentials?.username ?? null]))
    .digest("hex");

export const routeFor = (proxy?: ProxyEndpoint): Route =>
  proxy === undefined
    ? { kind: "direct" }
    : {
        endpoint: proxy,
        expectation: { destinations: "all", stability: "unknown" },
        generation: 0,
        key: routeKeyOf(proxy),
        kind: "proxy",
      };

export const exitFactsFor = (route: Route, observation?: ProxyObservation): ExitFacts =>
  route.kind === "direct" || observation === undefined
    ? { kind: "unknown" }
    : {
        address: observation.exitIp,
        country: observation.country,
        destination: observation.destination,
        generation: route.generation,
        kind: "observed",
        observedAt: observation.observedAt,
        provider: observation.provider,
        route: route.key,
        zone: observation.timezone,
      };
