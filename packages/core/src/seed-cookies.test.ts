import { describe, expect, it } from "vite-plus/test";
import { createSession } from "wreq-js";

import { parseSeedCookies } from "./seed-cookies.ts";

describe("request controls", () => {
  it("parses host-only scope, default path, and every supported cookie attribute", () => {
    expect(
      parseSeedCookies(
        ["name=value=tail; Secure; HttpOnly; SameSite=Strict"],
        new URL("https://sub.example.com/dir/page"),
      ),
    ).toStrictEqual({
      seeds: [
        {
          domain: undefined,
          expires: undefined,
          httpOnly: true,
          maxAge: undefined,
          name: "name",
          path: "/dir",
          sameSite: "Strict",
          secure: true,
          setCookieHeader: "name=value=tail; Secure; HttpOnly; SameSite=Strict",
          url: "https://sub.example.com/dir/page",
          value: "value=tail",
        },
      ],
      skipped: [],
    });
  });

  it("preserves cookie attributes in the native jar and scopes domain cookies to subdomains", async () => {
    const url = new URL("https://example.com/dir/page");

    const { seeds } = parseSeedCookies(
      [
        "domain=one; Domain=example.com; Path=/dir; Secure; HttpOnly; SameSite=Strict",
        "host=two; Path=/",
        "expired=three; Max-Age=0",
      ],
      url,
    );

    await using session = await createSession();

    for (const { setCookieHeader, name } of seeds) {
      session.setCookie(name, setCookieHeader.slice(setCookieHeader.indexOf("=") + 1), url);
    }

    expect(session.getCookies("https://sub.example.com/dir/page")).toStrictEqual({ domain: "one" });
    expect(session.getCookies("https://sub.example.com/other")).toStrictEqual({});
    expect(session.getCookies("http://sub.example.com/dir/page")).toStrictEqual({});
    expect(session.getCookies(url)).toStrictEqual({ domain: "one", host: "two" });
    expect(session.getAllCookies()).toContainEqual(
      expect.objectContaining({
        domain: "example.com",
        httpOnly: true,
        name: "domain",
        path: "/dir",
        sameSite: "strict",
        secure: true,
      }),
    );
  });

  it("applies the target directory as default path and lets Max-Age override Expires", async () => {
    const url = new URL("https://example.com/dir/page");

    const { seeds } = parseSeedCookies(
      [
        "default=one",
        "gone=two; Max-Age=0; Expires=Wed, 21 Oct 2099 07:28:00 GMT",
        "live=three; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      ],
      url,
    );

    await using session = await createSession();

    for (const { setCookieHeader, name } of seeds) {
      session.setCookie(name, setCookieHeader.slice(setCookieHeader.indexOf("=") + 1), url);
    }

    expect(session.getCookies("https://example.com/dir/other")).toStrictEqual({
      default: "one",
      live: "three",
    });
    expect(session.getCookies("https://example.com/outside")).toStrictEqual({});
    expect(seeds.map(({ maxAge }) => maxAge === 0)).toStrictEqual([false, true, false]);
  });

  it.each([
    ["https://example.com/", "com"],
    ["https://example.co.uk/", "co.uk"],
    ["https://first.github.io/", "github.io"],
    ["https://first.foo.ck/", "foo.ck"],
  ])("skips the public suffix %s with Domain=%s before seeding", (target, domain) => {
    expect(parseSeedCookies([`name=secret; Domain=${domain}`], new URL(target))).toStrictEqual({
      seeds: [],
      skipped: [{ name: "name", reason: "public-suffix-domain" }],
    });
  });

  it.each([
    ["https://sub.example.co.uk/", "example.co.uk"],
    ["https://www.ck/", "www.ck"],
    ["https://127.0.0.1/", "127.0.0.1"],
  ])("preserves matching registrable and exact IP domains for %s", (target, domain) => {
    expect(
      parseSeedCookies([`name=value; Domain=${domain}`], new URL(target)).seeds,
    ).toContainEqual(
      expect.objectContaining({ domain: `.${domain}`, name: "name", value: "value" }),
    );
  });

  it("seeds a public-suffix Domain identical to the target host as a host-only cookie", () => {
    expect(
      parseSeedCookies(
        ["suffix=one; Domain=localhost; Path=/"],
        new URL("http://localhost:3000/page"),
      ),
    ).toStrictEqual({
      seeds: [
        {
          domain: undefined,
          expires: undefined,
          httpOnly: false,
          maxAge: undefined,
          name: "suffix",
          path: "/",
          sameSite: undefined,
          secure: false,
          setCookieHeader: "suffix=one; Path=/",
          url: "http://localhost:3000/page",
          value: "one",
        },
      ],
      skipped: [],
    });
  });

  it.each([
    {
      cookie: "name=secret; Domain=other.com",
      label: "a foreign Domain",
      name: "name",
      reason: "domain-mismatch",
      target: "https://example.com/",
    },
    {
      cookie: "a=secret; Domain=localhost; Path=/",
      label: "a public-suffix Domain on another host",
      name: "a",
      reason: "domain-mismatch",
      target: "http://127.0.0.1/",
    },
    {
      cookie: "__Secure-a=secret; Path=/",
      label: "__Secure- without Secure",
      name: "__Secure-a",
      reason: "prefix-rules",
      target: "https://example.com/",
    },
    {
      cookie: "__secure-a=secret; Path=/",
      label: "lowercase __secure- without Secure",
      name: "__secure-a",
      reason: "prefix-rules",
      target: "https://example.com/",
    },
    {
      cookie: "__SECURE-a=secret; Path=/",
      label: "uppercase __SECURE- without Secure",
      name: "__SECURE-a",
      reason: "prefix-rules",
      target: "https://example.com/",
    },
    {
      cookie: "__Host-a=secret; Path=/",
      label: "__Host- without Secure",
      name: "__Host-a",
      reason: "prefix-rules",
      target: "https://example.com/",
    },
    {
      cookie: "__Host-a=secret; Secure; Path=/sub",
      label: "__Host- with Path=/sub",
      name: "__Host-a",
      reason: "prefix-rules",
      target: "https://example.com/",
    },
    {
      cookie: "__Host-a=secret; Secure",
      label: "__Host- with the default path /deep",
      name: "__Host-a",
      reason: "prefix-rules",
      target: "https://example.com/deep/page",
    },
    {
      cookie: "__Host-a=secret; Secure; Path=/; Domain=example.com",
      label: "__Host- with Domain",
      name: "__Host-a",
      reason: "prefix-rules",
      target: "https://example.com/",
    },
    {
      cookie: "__host-a=secret; Secure; Path=/sub",
      label: "lowercase __host- with Path=/sub",
      name: "__host-a",
      reason: "prefix-rules",
      target: "https://example.com/",
    },
    {
      cookie: "__Http-a=secret; Secure; Path=/",
      label: "__Http- without HttpOnly",
      name: "__Http-a",
      reason: "prefix-rules",
      target: "https://example.com/",
    },
    {
      cookie: "__Http-a=secret; HttpOnly; Path=/",
      label: "__Http- without Secure",
      name: "__Http-a",
      reason: "prefix-rules",
      target: "https://example.com/",
    },
    {
      cookie: "__http-a=secret; Secure; Path=/",
      label: "lowercase __http- without HttpOnly",
      name: "__http-a",
      reason: "prefix-rules",
      target: "https://example.com/",
    },
    {
      cookie: "__Host-Http-a=secret; Secure; Path=/",
      label: "__Host-Http- without HttpOnly",
      name: "__Host-Http-a",
      reason: "prefix-rules",
      target: "https://example.com/",
    },
    {
      cookie: "__Host-Http-a=secret; HttpOnly; Path=/",
      label: "__Host-Http- without Secure",
      name: "__Host-Http-a",
      reason: "prefix-rules",
      target: "https://example.com/",
    },
    {
      cookie: "__Host-Http-a=secret; Secure; HttpOnly; Path=/; Domain=example.com",
      label: "__Host-Http- with Domain",
      name: "__Host-Http-a",
      reason: "prefix-rules",
      target: "https://example.com/",
    },
    {
      cookie: "__Host-Http-a=secret; Secure; HttpOnly; Path=/sub",
      label: "__Host-Http- with Path=/sub",
      name: "__Host-Http-a",
      reason: "prefix-rules",
      target: "https://example.com/",
    },
    {
      cookie: "__host-http-a=secret; Secure; Path=/",
      label: "lowercase __host-http- without HttpOnly",
      name: "__host-http-a",
      reason: "prefix-rules",
      target: "https://example.com/",
    },
    {
      cookie: `${"n".repeat(4000)}=secret${"v".repeat(91)}`,
      label: "a name and value of 4097 characters",
      name: "n".repeat(4000),
      reason: "too-large",
      target: "https://example.com/",
    },
    {
      cookie: `a=secret; Path=/${"p".repeat(1024)}`,
      label: "an explicit path of 1025 characters",
      name: "a",
      reason: "path-too-long",
      target: "https://example.com/",
    },
    {
      cookie: "a=secret",
      label: "a default path of 1101 characters",
      name: "a",
      reason: "path-too-long",
      target: `https://example.com/${"d".repeat(1100)}/page`,
    },
    {
      cookie: "a=secret; SameSite=None; Path=/",
      label: "SameSite=None without Secure",
      name: "a",
      reason: "same-site-none-insecure",
      target: "https://example.com/",
    },
    {
      cookie: "a=secret; samesite=none",
      label: "lowercase samesite=none without Secure",
      name: "a",
      reason: "same-site-none-insecure",
      target: "https://example.com/",
    },
  ])("skips $label and reports its name and reason", ({ cookie, target, name, reason }) => {
    expect(parseSeedCookies(["kept=one; Path=/", cookie], new URL(target))).toStrictEqual({
      seeds: [expect.objectContaining({ name: "kept", value: "one" })],
      skipped: [{ name, reason }],
    });
  });

  it.each([
    {
      cookie: "__Host-a=1; Secure; Path=/",
      label: "__Host- with Secure and Path=/",
      name: "__Host-a",
      path: "/",
      target: "https://example.com/deep/page",
    },
    {
      cookie: "__Http-a=1; Secure; HttpOnly; Path=/; Domain=example.com",
      label: "__Http- with Secure, HttpOnly, and Domain",
      name: "__Http-a",
      path: "/",
      target: "https://example.com/",
    },
    {
      cookie: "__Host-Http-a=1; Secure; HttpOnly",
      label: "__Host-Http- with the root default path",
      name: "__Host-Http-a",
      path: "/",
      target: "https://example.com/",
    },
    {
      cookie: "__secure-a=1; Secure; Path=/",
      label: "lowercase __secure- with Secure",
      name: "__secure-a",
      path: "/",
      target: "https://example.com/",
    },
    {
      cookie: `${"n".repeat(4000)}=${"v".repeat(96)}`,
      label: "a name and value of 4096 characters",
      name: "n".repeat(4000),
      path: "/",
      target: "https://example.com/",
    },
    {
      cookie: `a=1; Path=/${"p".repeat(1023)}`,
      label: "an explicit path of 1024 characters",
      name: "a",
      path: `/${"p".repeat(1023)}`,
      target: "https://example.com/",
    },
    {
      cookie: "a=1",
      label: "a default path of 1024 characters",
      name: "a",
      path: `/${"d".repeat(1023)}`,
      target: `https://example.com/${"d".repeat(1023)}/page`,
    },
    {
      cookie: "a=1; SameSite=None; Secure",
      label: "SameSite=None with Secure",
      name: "a",
      path: "/",
      target: "https://example.com/",
    },
  ])("seeds $label", ({ cookie, target, name, path }) => {
    expect(parseSeedCookies([cookie], new URL(target))).toStrictEqual({
      seeds: [expect.objectContaining({ name, path })],
      skipped: [],
    });
  });

  it("refuses malformed cookies without echoing cookie values", () => {
    const url = new URL("https://example.com/");

    for (const cookies of [
      ["name=secret\r\nInjected: yes"],
      ["missing-pair"],
      ["bad name=secret"],
    ]) {
      expect(() => parseSeedCookies(cookies, url)).toThrow(
        expect.objectContaining({ code: "INVALID_OPTIONS" }),
      );
      expect(() => parseSeedCookies(cookies, url)).not.toThrow(/secret/u);
    }
  });
});
