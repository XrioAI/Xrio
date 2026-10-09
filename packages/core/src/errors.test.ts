import { describe, expect, it } from "vite-plus/test";

import { invalidOptions, isXrioError, XrioError } from "./errors.ts";

const timeout = new XrioError("TIMEOUT", "Timed out", { details: undefined });

const invalid = invalidOptions("Invalid");

describe(isXrioError, () => {
  it.each([
    { code: undefined, expected: true, value: timeout },
    { code: "TIMEOUT", expected: true, value: timeout },
    { code: "UNSUPPORTED_CONTENT_TYPE", expected: false, value: timeout },
    { code: undefined, expected: true, value: invalid },
    { code: "INVALID_OPTIONS", expected: true, value: invalid },
    {
      code: undefined,
      expected: false,
      value: Object.assign(new Error("Impostor"), { code: "TIMEOUT" }),
    },
    {
      code: undefined,
      expected: false,
      value: Object.assign(new Error("Impostor"), { code: "INVALID_OPTIONS" }),
    },
    {
      code: undefined,
      expected: false,
      value: Object.assign(new TypeError("Native"), { code: "ERR_INVALID_URL" }),
    },
    { code: undefined, expected: false, value: { code: "TIMEOUT" } },
    { code: undefined, expected: false, value: undefined },
  ] as const)("checks $value.code against $code", ({ code, expected, value }) => {
    expect(code === undefined ? isXrioError(value) : isXrioError(value, code)).toBe(expected);
  });

  it("keeps the original error as the cause", () => {
    const cause = new Error("Original");

    expect(new XrioError("TIMEOUT", "Timed out", { cause, details: undefined }).cause).toBe(cause);
    expect(invalidOptions("Invalid", cause).cause).toBe(cause);
  });
});
