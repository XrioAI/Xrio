import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { stdioSink } from "./logger.ts";

describe(stdioSink, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes debug and info lines to stdout", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    stdioSink("hello", "info");
    stdioSink("detail", "debug");

    expect(out.mock.calls).toStrictEqual([["hello\n"], ["detail\n"]]);
    expect(err).not.toHaveBeenCalled();
  });

  it("writes warnings and errors to stderr", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    stdioSink("careful", "warn");
    stdioSink("broken", "error");

    expect(err.mock.calls).toStrictEqual([["careful\n"], ["broken\n"]]);
    expect(out).not.toHaveBeenCalled();
  });
});
