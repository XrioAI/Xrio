import { createHash } from "node:crypto";

import type { ProxyEndpoint } from "../types.ts";

export type RouteKey = string;

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

export type ExitFacts =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "observed";
      readonly address: string;
      readonly zone: string;
      readonly country: string;
      readonly provider: string;
      readonly observedAt: number;
      readonly destination: string;
      readonly route: RouteKey;
      readonly generation: number;
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

export const exitFactsFor = (_route: Route): ExitFacts => ({ kind: "unknown" });
