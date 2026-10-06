/* oxlint-disable eslint/require-await -- Fake requests return API responses without network I/O. */
import { inspect } from "node:util";

import { describe, expect, it } from "vite-plus/test";

import { lookupProxyInfo } from "./info.ts";

const connection = "http://user-session-12345678:secret@proxy.test:8000";

const primaryBody = {
  country_code: "US",
  ip: "203.0.113.1",
  success: true,
  timezone: { id: "America/New_York" },
};

describe("proxy information lookup", () => {
  it("looks up the exact connection and infers locale", async () => {
    const requests: string[] = [];

    const info = await lookupProxyInfo(connection, undefined, async (url, proxy, deadline) => {
      requests.push(proxy);
      expect(url).toBe("https://ipwho.is/");
      expect(deadline.signal.aborted).toBeFalsy();

      return { body: primaryBody, status: 200 };
    });

    expect(info).toStrictEqual({
      country: "US",
      exit_ip: "203.0.113.1",
      locale: "en-US",
      timezone: "America/New_York",
    });
    expect(requests).toStrictEqual([connection]);
  });

  it.each([
    { body: { success: false }, status: 200 },
    { body: primaryBody, status: 429 },
    { body: { ...primaryBody, country_code: "ZZ" }, status: 200 },
    { body: { ...primaryBody, ip: "not-an-ip" }, status: 200 },
    { body: { ...primaryBody, timezone: { id: "+01:00" } }, status: 200 },
    { body: { ...primaryBody, timezone: { id: "Nowhere/Invalid" } }, status: 200 },
    { body: { ...primaryBody, timezone: null }, status: 200 },
  ])("uses ipapi for an unusable primary response: %j", async (primary) => {
    const urls: string[] = [];
    const connections: string[] = [];

    const info = await lookupProxyInfo(connection, undefined, async (url, proxy) => {
      urls.push(url);
      connections.push(proxy);

      return urls.length === 1
        ? primary
        : {
            body: {
              country: "France",
              ip: "203.0.113.2",
              is_bogon: false,
              timezone: "Europe/Paris",
            },
            status: 200,
          };
    });

    expect(info).toStrictEqual({
      country: "FR",
      exit_ip: "203.0.113.2",
      locale: "fr-FR",
      timezone: "Europe/Paris",
    });
    expect(urls).toStrictEqual(["https://ipwho.is/", "https://api.ipapi.is/"]);
    expect(connections).toStrictEqual([connection, connection]);
  });

  it("reports lookup failures without exposing request errors", async () => {
    let failure: unknown;

    try {
      await lookupProxyInfo(connection, undefined, async (_url, proxy) => {
        throw new Error(proxy);
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "PROXY_INFO_UNAVAILABLE" });
    expect(inspect(failure, { depth: Infinity })).not.toContain("secret");
  });

  it("does not invent country or local fingerprint data when the fallback is incomplete", async () => {
    await expect(
      lookupProxyInfo(connection, undefined, async () => ({
        body: {
          country: "Unknown country",
          ip: "203.0.113.2",
          is_bogon: false,
          timezone: "Europe/Paris",
        },
        status: 200,
      })),
    ).rejects.toMatchObject({ code: "PROXY_INFO_UNAVAILABLE" });
  });

  it("honors cancellation even if a request does not finish, without calling the fallback", async () => {
    const started = Promise.withResolvers<boolean>();
    const pending = Promise.withResolvers<{ status: number; body: unknown }>();
    const urls: string[] = [];
    const controller = new AbortController();

    const requestJson = async (url: string) => {
      urls.push(url);
      started.resolve(true);

      return await pending.promise;
    };

    const info = lookupProxyInfo(connection, controller.signal, requestJson);

    await started.promise;
    controller.abort(new Error("Caller cancelled"));

    await expect(info).rejects.toThrow("Caller cancelled");
    expect(urls).toStrictEqual(["https://ipwho.is/"]);
    await expect(lookupProxyInfo(connection, controller.signal, requestJson)).rejects.toThrow(
      "Caller cancelled",
    );
    expect(urls).toHaveLength(1);
    pending.resolve({ body: primaryBody, status: 200 });
  });
});
