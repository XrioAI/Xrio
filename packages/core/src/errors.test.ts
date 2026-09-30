import { describe, expect, it } from "vite-plus/test";

import { XrioError, toError } from "./errors.ts";

describe(XrioError, () => {
  it("carries a code and keeps the original error as its cause", () => {
    const cause = new Error("root");
    const error = new XrioError("fetch_failed", "nope", { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      cause,
      code: "fetch_failed",
      message: "nope",
      name: "XrioError",
    });
  });
});

describe(toError, () => {
  it("returns Error instances untouched", () => {
    const error = new Error("same");

    expect(toError(error)).toBe(error);
  });

  it("wraps anything else, keeping the original value as the cause", () => {
    const wrapped = toError({ reason: 1 });

    expect(wrapped.message).toBe("[object Object]");
    expect(wrapped.cause).toStrictEqual({ reason: 1 });
  });
});
