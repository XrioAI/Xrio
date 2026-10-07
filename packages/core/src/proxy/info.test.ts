/* oxlint-disable eslint/require-await -- Fake requests return API responses without network I/O. */
import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { startDeadline } from "../deadline.ts";
import { XrioError } from "../errors.ts";
import { lookupProxyInfo } from "./info.ts";

const connection = "http://user-session-12345678:secret@proxy.test:8000";

const primaryBody = {
  country_code: "US",
  ip: "203.0.113.1",
  success: true,
  timezone: { id: "America/New_York" },
};

describe("proxy information lookup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("looks up the exact connection and infers locale", async () => {
    using deadline = startDeadline(10_000);
    const requests: string[] = [];

    const info = await lookupProxyInfo(connection, deadline, async (url, proxy, attempt) => {
      requests.push(proxy);
      expect(url).toBe("https://ipwho.is/");
      expect(attempt.signal.aborted).toBeFalsy();

      return { body: primaryBody, status: 200 };
    });

    expect(info).toStrictEqual({
      country: "US",
      exitIp: "203.0.113.1",
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
    using deadline = startDeadline(10_000);
    const urls: string[] = [];
    const connections: string[] = [];

    const info = await lookupProxyInfo(connection, deadline, async (url, proxy) => {
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
      exitIp: "203.0.113.2",
      locale: "fr-FR",
      timezone: "Europe/Paris",
    });
    expect(urls).toStrictEqual(["https://ipwho.is/", "https://api.ipapi.is/"]);
    expect(connections).toStrictEqual([connection, connection]);
  });

  it("reports lookup failures without exposing request errors", async () => {
    using deadline = startDeadline(10_000);
    let failure: unknown;

    try {
      await lookupProxyInfo(connection, deadline, async (_url, proxy) => {
        throw new Error(proxy);
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "PROXY_INFO_UNAVAILABLE" });
    expect(inspect(failure, { depth: Infinity })).not.toContain("secret");
  });

  it("does not invent country or local fingerprint data when the fallback is incomplete", async () => {
    using deadline = startDeadline(10_000);
    await expect(
      lookupProxyInfo(connection, deadline, async () => ({
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
    using deadline = startDeadline(10_000, controller.signal);

    const requestJson = async (url: string) => {
      urls.push(url);
      started.resolve(true);

      return await pending.promise;
    };

    const info = lookupProxyInfo(connection, deadline, requestJson);

    await started.promise;
    controller.abort(new Error("Caller cancelled"));

    await expect(info).rejects.toThrow("Caller cancelled");
    expect(urls).toStrictEqual(["https://ipwho.is/"]);
    await expect(lookupProxyInfo(connection, deadline, requestJson)).rejects.toThrow(
      "Caller cancelled",
    );
    expect(urls).toHaveLength(1);
    pending.resolve({ body: primaryBody, status: 200 });
  });

  it.each(["PROXY_AUTH_FAILED", "PROXY_UNREACHABLE"] as const)(
    "preserves %s and does not call the fallback",
    async (code) => {
      using deadline = startDeadline(10_000);
      const failure = new XrioError(code, "The proxy failed.", { details: undefined });
      const urls: string[] = [];

      await expect(
        lookupProxyInfo(connection, deadline, async (url) => {
          urls.push(url);
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(urls).toStrictEqual(["https://ipwho.is/"]);
    },
  );

  it("leaves time for the fallback after a stalled primary", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    using deadline = startDeadline(60_000);
    const stalled = Promise.withResolvers<{ status: number; body: unknown }>();
    const urls: string[] = [];

    const info = lookupProxyInfo(connection, deadline, async (url) => {
      urls.push(url);

      if (urls.length === 1) {
        return await stalled.promise;
      }

      return {
        body: { country: "France", ip: "203.0.113.2", is_bogon: false, timezone: "Europe/Paris" },
        status: 200,
      };
    });

    await vi.advanceTimersByTimeAsync(2500);
    await expect(info).resolves.toHaveProperty("country", "FR");
    expect(urls).toStrictEqual(["https://ipwho.is/", "https://api.ipapi.is/"]);
    expect(deadline.remainingMs()).toBe(57_500);
    stalled.resolve({ body: primaryBody, status: 200 });
  });

  it("limits both providers together to five seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    using deadline = startDeadline(60_000);
    const stalled = Promise.withResolvers<{ status: number; body: unknown }>();
    const starts: number[] = [];

    const info = lookupProxyInfo(connection, deadline, async () => {
      starts.push(performance.now());

      return await stalled.promise;
    });

    await Promise.all([
      expect(info).rejects.toMatchObject({ code: "PROXY_INFO_UNAVAILABLE" }),
      vi.advanceTimersByTimeAsync(5000),
    ]);
    expect(starts).toStrictEqual([0, 2500]);
    expect(deadline.remainingMs()).toBe(55_000);
    stalled.resolve({ body: primaryBody, status: 200 });
  });

  it("preserves a shorter caller deadline and never starts the fallback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    using deadline = startDeadline(1000);
    const stalled = Promise.withResolvers<{ status: number; body: unknown }>();
    const urls: string[] = [];

    const info = lookupProxyInfo(connection, deadline, async (url) => {
      urls.push(url);

      return await stalled.promise;
    });

    await Promise.all([
      expect(info).rejects.toMatchObject({ code: "TIMEOUT" }),
      vi.advanceTimersByTimeAsync(1000),
    ]);
    expect(urls).toStrictEqual(["https://ipwho.is/"]);
    stalled.resolve({ body: primaryBody, status: 200 });
  });
});
