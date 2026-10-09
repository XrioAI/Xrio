import { parseProxy } from "../options.ts";
import type { ProxyEndpoint } from "../types.ts";
import type { ProxyManager } from "./manager.ts";

export interface ProxyExits {
  readonly current: () => ProxyEndpoint | undefined;
  readonly freshExitAfter: (blocked: ProxyEndpoint | undefined) => ProxyEndpoint | undefined;
  readonly pinsExit: (proxy: ProxyEndpoint | undefined) => boolean;
}

const NO_CONFIGURED_PROXY: ProxyExits = {
  current: (): undefined => undefined,
  freshExitAfter: (): undefined => undefined,
  pinsExit: (proxy) => proxy === undefined,
};

export const proxyExits = (manager: ProxyManager | undefined): ProxyExits => {
  if (manager === undefined) {
    return NO_CONFIGURED_PROXY;
  }

  const endpoints = new Map<string, ProxyEndpoint>();
  const connections = new WeakMap<ProxyEndpoint, string>();

  const endpointOf = (connection: string): ProxyEndpoint => {
    const known = endpoints.get(connection);

    if (known !== undefined) {
      return known;
    }

    const endpoint = parseProxy(connection);

    endpoints.set(connection, endpoint);
    connections.set(endpoint, connection);

    return endpoint;
  };

  return {
    current: () => endpointOf(manager.getProxyConnectionString()),
    freshExitAfter: (blocked): ProxyEndpoint | undefined => {
      const connection = blocked === undefined ? undefined : connections.get(blocked);

      if (connection === undefined) {
        return undefined;
      }

      const next = manager.shouldRotateSession(connection, "blocked")
        ? manager.changeSession()
        : manager.getProxyConnectionString();

      return next === connection ? undefined : endpointOf(next);
    },
    pinsExit: (proxy) => proxy === undefined || (manager.managesSessions && connections.has(proxy)),
  };
};
