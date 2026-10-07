import { describe, expect, it } from "vite-plus/test";

import type { FontStack } from "./contracts.ts";
import {
  FONT_PROBE_FAMILIES,
  FONT_SENTINEL_FAMILIES,
  fontCheckEnvironment,
  fontConfigOf,
  fontConfigPathOf,
} from "./fonts.ts";

const stack: FontStack = {
  cacheDir: "/tmp/xrio-501/fontcache-0123456789abcdef",
  directory: "/opt/xrio/fontstack",
  families: 175,
  payload: "62bbc5617946311ab21ed9ec8ef22f68a15e4ccf06cebf01aca807fedb1def3d",
  rules: ["60-latin.conf", "10-antialias.conf", "50-user.conf", "51-local.conf", "30-metric.conf"],
};

describe(fontConfigOf, () => {
  it("names the stack's share directory, the per-host cache and each rule by absolute path", () => {
    expect(fontConfigOf(stack)).toBe(
      [
        '<?xml version="1.0"?>',
        '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
        "<fontconfig>",
        "  <dir>/opt/xrio/fontstack/share</dir>",
        "  <cachedir>/tmp/xrio-501/fontcache-0123456789abcdef</cachedir>",
        '  <include ignore_missing="no">/opt/xrio/fontstack/fonts/conf.d/10-antialias.conf</include>',
        '  <include ignore_missing="no">/opt/xrio/fontstack/fonts/conf.d/30-metric.conf</include>',
        '  <include ignore_missing="no">/opt/xrio/fontstack/fonts/conf.d/60-latin.conf</include>',
        "</fontconfig>",
        "",
      ].join("\n"),
    );
  });

  it("escapes XML characters in a path", () => {
    expect(fontConfigOf({ ...stack, directory: "/opt/a&b/<stack>", rules: [] })).toContain(
      "<dir>/opt/a&amp;b/&lt;stack&gt;/share</dir>",
    );
  });
});

describe(fontCheckEnvironment, () => {
  it("points both fontconfig variables at the stack and the scratch, and the user's directories at the scratch", () => {
    expect(
      fontCheckEnvironment(stack, { configFile: "/tmp/b1/fonts.conf", home: "/tmp/b1" }),
    ).toStrictEqual({
      FONTCONFIG_FILE: "/tmp/b1/fonts.conf",
      FONTCONFIG_PATH: "/opt/xrio/fontstack/fonts",
      HOME: "/tmp/b1",
      XDG_CACHE_HOME: "/tmp/b1/.cache",
      XDG_CONFIG_HOME: "/tmp/b1/.config",
      XDG_DATA_HOME: "/tmp/b1/.local/share",
    });
    expect(fontConfigPathOf(stack)).toBe("/opt/xrio/fontstack/fonts");
  });
});

describe("the sentinel the identity read measures", () => {
  it("names two families, so the launch probe stays cheap", () => {
    expect(FONT_SENTINEL_FAMILIES).toStrictEqual(["Ubuntu", "KACSTOffice"]);
  });
});

describe("the fonts the identity read measures", () => {
  it("lists 40 distinct families, none holding a quote that would break the CSS font string", () => {
    expect([
      FONT_PROBE_FAMILIES.length,
      new Set(FONT_PROBE_FAMILIES).size,
      FONT_PROBE_FAMILIES.some((family) => /["\\]/u.test(family)),
    ]).toStrictEqual([40, 40, false]);
  });
});
