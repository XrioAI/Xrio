import { describe, expect, it } from "vite-plus/test";

import { parseProxy } from "../options.ts";
import { proxyExits } from "./exit.ts";
import { ProxyManager } from "./manager.ts";

const managed = () => new ProxyManager({ url: "http://user-{session}:secret@proxy.test" });

const SESSION_USER = /^user-\d{8}$/u;

describe(proxyExits, () => {
  it("keeps one endpoint per session until a block moves the shared exit", () => {
    const exits = proxyExits(managed());
    const first = exits.current();
    const second = exits.freshExitAfter(first);

    expect(exits.current()).toBe(second);
    expect(first?.credentials?.username).toMatch(SESSION_USER);
    expect(second?.credentials?.username).toMatch(SESSION_USER);
    expect(second?.credentials?.username).not.toBe(first?.credentials?.username);
    expect(second).toMatchObject({ hostname: "proxy.test", port: 80, protocol: "http" });
  });

  it("follows an exit another scrape already moved instead of issuing a second one", () => {
    const exits = proxyExits(managed());
    const first = exits.current();
    const moved = exits.freshExitAfter(first);

    expect(exits.freshExitAfter(first)).toBe(moved);
    expect(exits.current()).toBe(moved);

    const third = exits.freshExitAfter(moved);

    expect(new Set([first, moved, third]).size).toBe(3);
    expect(exits.current()).toBe(third);
  });

  it.each([
    {
      label: "a configured URL without {session}",
      manager: new ProxyManager({ url: "http://user:secret@proxy.test" }),
    },
    { label: "no configured proxy", manager: undefined },
  ])("never moves $label", ({ manager }) => {
    const exits = proxyExits(manager);
    const current = exits.current();

    expect(exits.freshExitAfter(current)).toBeUndefined();
    expect(exits.current()).toBe(current);
  });

  it("never moves an exit it did not issue, even one spelled like a session", () => {
    const exits = proxyExits(managed());
    const current = exits.current();
    const explicit = parseProxy("http://user-12345678:secret@proxy.test");

    expect(exits.freshExitAfter(explicit)).toBeUndefined();
    expect(exits.current()).toBe(current);
  });
});
