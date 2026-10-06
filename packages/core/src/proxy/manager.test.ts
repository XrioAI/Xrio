import { inspect } from "node:util";

import { describe, expect, it, vi } from "vite-plus/test";

import { startFakeHttpProxy } from "../testing/fake-proxies.ts";
import type { ProxyConfig } from "./config.ts";
import { ProxyManager } from "./manager.ts";

const config = {
  url: "http://user-session-{session}:secret@proxy.test:8000" as const,
} satisfies ProxyConfig;

describe("proxy sessions", () => {
  it("recommends rotation without changing the session until the caller requests it", () => {
    const manager = new ProxyManager(config);
    const first = manager.get_proxy_connection_string();

    expect(first).toMatch(/^http:\/\/user-session-\d{8}:secret@proxy\.test:8000$/u);
    expect([
      manager.should_rotate_session(first, "success"),
      manager.should_rotate_session(first, "other_failure"),
      manager.should_rotate_session(first, "blocked"),
      manager.should_rotate_session(first, "transient_connection_failure"),
      manager.should_rotate_session(first, "blocked"),
      manager.get_proxy_connection_string(),
    ]).toStrictEqual([false, false, true, true, true, first]);

    const second = manager.change_session();

    expect([
      manager.should_rotate_session(first, "blocked"),
      manager.should_rotate_session("http://another-proxy.test", "blocked"),
      manager.should_rotate_session(second, "transient_connection_failure"),
      manager.get_proxy_connection_string(),
    ]).toStrictEqual([false, false, true, second]);

    expect(second).not.toBe(first);
    expect({ config: config.url, current: manager.get_proxy_connection_string() }).toStrictEqual({
      config: "http://user-session-{session}:secret@proxy.test:8000",
      current: second,
    });
  });

  it("replaces a password slot, preserves credentials, and snapshots configuration", () => {
    const options = {
      session: { format: "alphanumeric", length: 12 },
      url: "socks5h://us%3Aer:pa%40ss_session-{session}_country-de@proxy.test:1080",
    } satisfies ProxyConfig;

    const manager = new ProxyManager(options);

    options.session.length = 1;

    expect(manager.change_session()).toMatch(
      /^socks5h:\/\/us%3Aer:pa%40ss_session-[a-zA-Z0-9]{12}_country-de@proxy\.test:1080$/u,
    );
  });

  it("leaves plain proxy credentials untouched and refuses manual rotation", () => {
    const url = "http://user-session-123:secret@proxy.test:8000";
    const manager = new ProxyManager({ url });

    expect(manager.get_proxy_connection_string()).toBe(url);
    expect(manager.should_rotate_session(url, "blocked")).toBeFalsy();
    expect(() => manager.change_session()).toThrow("Session rotation is not configured");
  });

  it("never reuses issued strings, even when a tiny session space is exhausted", () => {
    const manager = new ProxyManager({ ...config, session: { length: 1 } });
    const issued = new Set([manager.get_proxy_connection_string()]);

    // There are only ten one-digit sessions; generation must eventually stop.
    expect(() => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const connection = manager.change_session();

        expect(issued.has(connection)).toBeFalsy();
        issued.add(connection);
      }
    }).toThrow("Could not generate an unused proxy session");
    expect(issued.has(manager.get_proxy_connection_string())).toBeTruthy();
  });

  it.each([
    [],
    { session: {}, url: "http://proxy.test" },
    { url: "http://user-{session}-{session}:secret@proxy.test" },
    { url: "http://proxy.test/path-{session}" },
    { session: { format: "uuid" }, url: "http://user-{session}:secret@proxy.test" },
    { session: { length: 0 }, url: "http://user-{session}:secret@proxy.test" },
    { session: { length: 1.5 }, url: "http://user-{session}:secret@proxy.test" },
    { session: { length: 257 }, url: "http://user-{session}:secret@proxy.test" },
    { session: { id: "12345678" }, url: "http://user-{session}:secret@proxy.test" },
    { proxies: [], url: "http://proxy.test" },
  ])("rejects invalid proxy configuration without leaking credentials: %j", (invalid) => {
    let failure: unknown;

    try {
      // @ts-expect-error JavaScript and loaded config can bypass the input types.
      void new ProxyManager(invalid);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "INVALID_OPTIONS" });
    expect(inspect(failure, { depth: Infinity })).not.toContain("secret");
  });
});

describe("proxy information", () => {
  it("rejects connection strings that it did not issue", async () => {
    const manager = new ProxyManager(config);

    await expect(manager.get_proxy_info("http://another-proxy.test")).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
  });

  it("uses its own HTTP lookup and reports proxy failures without direct fallback", async () => {
    await using proxy = await startFakeHttpProxy({ connectStatus: 407, tunnelTo: 0 });

    const manager = new ProxyManager({
      url: proxy.url.replace("://", "://user-session-{session}:secret@"),
    });

    const connection = manager.get_proxy_connection_string();
    const { username, password } = new URL(connection);
    const authorization = `Basic ${btoa(`${username}:${password}`)}`;
    let failure: unknown;

    try {
      await manager.get_proxy_info(connection);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "PROXY_INFO_UNAVAILABLE" });
    expect(inspect(failure, { depth: Infinity })).not.toContain("secret");
    expect(proxy.requests).toStrictEqual([
      { authority: "ipwho.is:443", authorization },
      { authority: "api.ipapi.is:443", authorization },
    ]);
    expect(manager.get_proxy_connection_string()).toBe(connection);
  });

  it("keeps an in-flight lookup tied to its original session and honors cancellation", async () => {
    await using proxy = await startFakeHttpProxy({ silent: true, tunnelTo: 0 });

    const manager = new ProxyManager({
      url: proxy.url.replace("://", "://user-session-{session}:secret@"),
    });

    const first = manager.get_proxy_connection_string();
    const { username, password } = new URL(first);
    const controller = new AbortController();
    const lookup = manager.get_proxy_info(first, controller.signal);
    const second = manager.change_session();

    await vi.waitFor(() => {
      expect(proxy.requests).toHaveLength(1);
    });
    controller.abort(new Error("Caller cancelled"));

    await expect(lookup).rejects.toThrow("Caller cancelled");
    expect(proxy.requests).toStrictEqual([
      { authority: "ipwho.is:443", authorization: `Basic ${btoa(`${username}:${password}`)}` },
    ]);
    expect(manager.get_proxy_connection_string()).toBe(second);
  });
});
