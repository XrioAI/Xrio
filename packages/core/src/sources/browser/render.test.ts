import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../../deadline.ts";
import { XrioError } from "../../errors.ts";
import { DriverError } from "./port.ts";
import type { DriverBrowser, DriverListener, ResultGuard } from "./port.ts";
import { renderDocument } from "./render.ts";

type Navigation =
  | { readonly netError: string; readonly hops?: readonly string[] }
  | { readonly documentUrl: string };

const BAD_GATEWAY_PAGE = "<html><head></head><body>Bad Gateway</body></html>";

const scriptedBrowser = (navigation: Navigation): DriverBrowser => {
  const listeners = new Set<DriverListener>();

  return {
    close: async () => {
      await Promise.resolve();
    },
    evaluateIsolated: async <Result>(
      _expression: string,
      isResult: ResultGuard<Result>,
    ): Promise<Result> => {
      const reply: unknown = await Promise.resolve(BAD_GATEWAY_PAGE);

      if (!isResult(reply)) {
        throw new Error("The scripted browser answers only the capture.");
      }

      return reply;
    },
    navigate: async () => {
      await Promise.resolve();

      if ("netError" in navigation) {
        for (const url of navigation.hops ?? []) {
          for (const listener of listeners) {
            listener({ type: "request", url });
          }
        }

        throw new DriverError({ kind: "navigation-failed", netError: navigation.netError });
      }

      const hop = {
        headers: [],
        isRedirect: false,
        loaderId: "L1",
        requestId: "R1",
        status: 502,
        url: navigation.documentUrl,
      };

      for (const listener of listeners) {
        listener({ hop, type: "document-response" });
        listener({ frameId: "F1", loaderId: "L1", type: "commit" });
        listener({ frameId: "F1", loaderId: "L1", type: "dom-content-loaded" });
      }
    },
    onEvent: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    product: { headless: true, major: 150, version: "150.0.0.0" },
  };
};

const proxyAuthFailed = new XrioError(
  "PROXY_AUTH_FAILED",
  "The proxy http://proxy.test:8000/ rejected its credentials.",
  { details: undefined },
);

const relayFailing = (failingHost: string) => ({
  failureFor: (hostname: string) => (hostname === failingHost ? proxyAuthFailed : undefined),
});

const render = async (navigation: Navigation, relay?: ReturnType<typeof relayFailing>) =>
  await renderDocument(
    scriptedBrowser(navigation),
    new URL("https://origin.test/page"),
    relay,
    startDeadline(10_000),
    async () => await Promise.resolve(null),
  );

describe("proxy failures behind a browser navigation", () => {
  it("reports the relay's failure for the host when Chrome's tunnel fails", async () => {
    await expect(
      render({ netError: "net::ERR_TUNNEL_CONNECTION_FAILED" }, relayFailing("origin.test")),
    ).rejects.toBe(proxyAuthFailed);
  });

  it("reports the relay's failure for the redirect hop whose tunnel failed", async () => {
    await expect(
      render(
        {
          hops: ["https://origin.test/page", "https://other.test/page"],
          netError: "net::ERR_TUNNEL_CONNECTION_FAILED",
        },
        relayFailing("other.test"),
      ),
    ).rejects.toBe(proxyAuthFailed);
  });

  it("keeps a proxy net error the relay cannot attribute as NETWORK_ERROR with the net error", async () => {
    await expect(
      render({ netError: "net::ERR_PROXY_CONNECTION_FAILED" }, relayFailing("other.test")),
    ).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      details: { netError: "net::ERR_PROXY_CONNECTION_FAILED" },
    });
  });

  it("leaves a net error unrelated to the proxy as NETWORK_ERROR even when the relay holds a failure", async () => {
    await expect(
      render({ netError: "net::ERR_CONNECTION_RESET" }, relayFailing("origin.test")),
    ).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      details: { netError: "net::ERR_CONNECTION_RESET" },
    });
  });

  it("reports the relay's failure instead of the page Chrome captured for a plain http document", async () => {
    await expect(
      render({ documentUrl: "http://origin.test/page" }, relayFailing("origin.test")),
    ).rejects.toBe(proxyAuthFailed);
  });

  it("returns the captured page for an https document, or for an http one without a relay", async () => {
    const https = await render(
      { documentUrl: "https://origin.test/page" },
      relayFailing("origin.test"),
    );

    const direct = await render({ documentUrl: "http://origin.test/page" });

    expect([https.source.status, https.source.html]).toStrictEqual([502, BAD_GATEWAY_PAGE]);
    expect([direct.source.status, direct.source.url]).toStrictEqual([
      502,
      "http://origin.test/page",
    ]);
  });
});
