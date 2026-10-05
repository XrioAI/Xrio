import { describe, expect, it } from "vite-plus/test";

import { resolveClientOptions } from "../options.ts";
import { exitFactsFor, routeFor } from "./route.ts";

const endpointOf = (proxy?: string) => resolveClientOptions({ mode: "http", proxy }).route;

const keyOf = (proxy: string) => {
  const route = routeFor(endpointOf(proxy));

  return route.kind === "proxy" ? route.key : undefined;
};

describe(routeFor, () => {
  it("routes directly without a proxy", () => {
    expect(routeFor()).toStrictEqual({ kind: "direct" });
  });

  it.each([
    {
      key: "63a8d1f57fc19b6c79d86547c698680322c691ea60205f37b17dddaaa5f36ec3",
      proxy: "http://u:secret@proxy.test:8080",
    },
    {
      key: "768962f310ca5074a2489a9a0325e4052552389ec1033753faa7dd32ad4cd6c1",
      proxy: "socks5://proxy.test",
    },
  ])("routes $proxy at generation 0 with unknown stability", ({ key, proxy }) => {
    expect(routeFor(endpointOf(proxy))).toStrictEqual({
      endpoint: endpointOf(proxy),
      expectation: { destinations: "all", stability: "unknown" },
      generation: 0,
      key,
      kind: "proxy",
    });
  });

  it("keys a route by its user and never its password", () => {
    const key = keyOf("http://u:secret@proxy.test:8080");

    expect(keyOf("http://u:other@proxy.test:8080")).toBe(key);
    expect(keyOf("http://v:secret@proxy.test:8080")).not.toBe(key);
  });
});

describe(exitFactsFor, () => {
  it.each([undefined, "http://u:secret@proxy.test:8080"])(
    "knows nothing about the exit of %s",
    (proxy) => {
      expect(exitFactsFor(routeFor(endpointOf(proxy)))).toStrictEqual({ kind: "unknown" });
    },
  );
});
