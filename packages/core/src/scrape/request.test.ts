import { describe, expect, it } from "vite-plus/test";

import { XrioError } from "../errors.ts";
import { parseScrapeInput } from "./request.ts";
import { OUTPUT_FORMATS, SCRAPE_MODES } from "./types.ts";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- feeding the parser deliberately malformed input
const messageOf = (input: unknown): string => {
  try {
    parseScrapeInput(input);
  } catch (error) {
    if (error instanceof XrioError && error.code === "invalid_request") {
      return error.message;
    }

    throw error;
  }

  return "";
};

describe("parseScrapeInput defaults", () => {
  it("defaults to the http mode and html format, with no location", () => {
    expect(parseScrapeInput({ url: "https://example.com" })).toStrictEqual({
      format: "html",
      mode: "http",
      url: "https://example.com/",
    });
  });

  it("keeps a trimmed location and drops fields that were not given", () => {
    const request = parseScrapeInput({
      location: { city: " Austin ", country: "US" },
      url: "https://example.com",
    });

    expect(request.location).toStrictEqual({ city: "Austin", country: "US" });
  });

  it("accepts an empty location object", () => {
    expect(parseScrapeInput({ location: {}, url: "https://example.com" }).location).toStrictEqual(
      {},
    );
  });

  it("normalizes the url", () => {
    expect(parseScrapeInput({ url: "HTTPS://Example.com/a b" }).url).toBe(
      "https://example.com/a%20b",
    );
  });
});

describe("parseScrapeInput accepted choices", () => {
  it.each(SCRAPE_MODES)("accepts mode %s", (mode) => {
    expect(parseScrapeInput({ mode, url: "https://example.com" }).mode).toBe(mode);
  });

  it.each(OUTPUT_FORMATS)("accepts format %s", (format) => {
    expect(parseScrapeInput({ format, url: "https://example.com" }).format).toBe(format);
  });
});

describe("parseScrapeInput rejections", () => {
  it.each([null, undefined, "https://example.com", 42, ["https://example.com"]])(
    "rejects non-object input %j",
    (input) => {
      expect(messageOf(input)).toBe("A scrape request must be an object.");
    },
  );

  it.each([{}, { url: 42 }, { url: null }])("rejects a missing or non-string url %j", (input) => {
    expect(messageOf(input)).toContain('"url" is required');
  });

  it.each(["nope", "ftp://example.com", "file:///etc/passwd", "data:text/html,hi", "/relative"])(
    "rejects the non-web url %s",
    (url) => {
      expect(messageOf({ url })).toContain("absolute http or https URL");
    },
  );

  it("rejects an unknown mode and lists the valid ones", () => {
    expect(messageOf({ mode: "turbo", url: "https://example.com" })).toBe(
      '"mode" must be one of: http, headless, headful.',
    );
  });

  it("rejects an unknown format and lists the valid ones", () => {
    expect(messageOf({ format: "pdf", url: "https://example.com" })).toBe(
      '"format" must be one of: html, md, xml, json, csv.',
    );
  });

  it.each(["Austin", 5, null, ["US"]])("rejects a non-object location %j", (location) => {
    expect(messageOf({ location, url: "https://example.com" })).toContain(
      '"location" must be an object',
    );
  });

  it.each([{ country: 1 }, { state: "   " }, { city: "" }, { city: null }])(
    "rejects an invalid location field %j",
    (location) => {
      expect(messageOf({ location, url: "https://example.com" })).toMatch(
        /"location\.(?:country|state|city)" must be a non-empty string\./u,
      );
    },
  );
});
