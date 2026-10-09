import { describe, expect, it } from "vite-plus/test";

import { parseChromeProduct } from "./port.ts";

describe(parseChromeProduct, () => {
  it.each([
    "154.0.8037.57",
    "Chrome/154",
    "Chrome/154.0.x.57",
    "Other/154.0.8037.57",
    "Chrome/0.0.8037.57",
    "Chrome/99999999999999999999.0.8037.57",
    "",
  ])('rejects malformed product "%s"', (value) => {
    expect(() => parseChromeProduct(value)).toThrow("malformed product");
  });

  it("retains the observed headless token and complete version", () => {
    expect(parseChromeProduct("HeadlessChrome/154.0.8037.57")).toStrictEqual({
      headless: true,
      major: 154,
      version: "154.0.8037.57",
    });
  });

  it("reads a headed product", () => {
    expect(parseChromeProduct("Chrome/150.0.7800.1")).toStrictEqual({
      headless: false,
      major: 150,
      version: "150.0.7800.1",
    });
  });
});
