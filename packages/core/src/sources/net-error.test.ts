import { describe, expect, it } from "vite-plus/test";

import { networkFailure } from "./net-error.ts";

describe("shared network errors", () => {
  it.each([
    { code: "TLS_CERTIFICATE_INVALID", netError: "net::ERR_CERT_AUTHORITY_INVALID" },
    { code: "TLS_CERTIFICATE_INVALID", netError: "net::ERR_CERT_DATE_INVALID" },
    { code: "TLS_CERTIFICATE_INVALID", netError: "CERTIFICATE_VERIFY_FAILED" },
    { code: "TOO_MANY_REDIRECTS", netError: "net::ERR_TOO_MANY_REDIRECTS" },
    { code: "NETWORK_ERROR", netError: "net::ERR_CONNECTION_RESET" },
  ])("maps $netError to $code", ({ netError, code }) => {
    const error = networkFailure(new URL("https://example.test/"), netError);
    expect(error.code).toBe(code);
    expect(error.details).toStrictEqual(code === "NETWORK_ERROR" ? { netError } : undefined);
  });

  it.each([
    {
      details: { netError: "net::ERR_CONNECTION_REFUSED" },
      failure: "net::ERR_CONNECTION_REFUSED",
    },
    {
      details: { netError: "net::ERR_HTTP2_PROTOCOL_ERROR" },
      failure: "net::ERR_HTTP2_PROTOCOL_ERROR",
    },
    {
      details: undefined,
      failure: "client error (Connect): tcp connect error: Connection refused (os error 61)",
    },
  ])("names netError only for Chrome's net::ERR_* names: $failure", ({ failure, details }) => {
    const error = networkFailure(new URL("https://example.test/"), failure);
    expect([error.code, error.details]).toStrictEqual(["NETWORK_ERROR", details]);
  });
});
