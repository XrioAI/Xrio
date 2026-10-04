import { describe, expect, it } from "vite-plus/test";

import { httpIdentity } from "./humanizer.ts";

const CHROME_HTTP1_HEADER_ORDER = [
  "Host",
  "Connection",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "Upgrade-Insecure-Requests",
  "User-Agent",
  "Accept",
  "Sec-Fetch-Site",
  "Sec-Fetch-Mode",
  "Sec-Fetch-User",
  "Sec-Fetch-Dest",
  "Accept-Encoding",
  "Accept-Language",
  "Priority",
  "Cookie",
];

describe(httpIdentity, () => {
  it.each([
    { header: "en-US,en;q=0.9", locale: undefined },
    { header: "en-US,en;q=0.9", locale: "en-US" },
    { header: "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7", locale: "de-DE" },
    { header: "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7", locale: "pt-BR" },
    { header: "en-AU,en-US;q=0.9,en;q=0.8", locale: "en-AU" },
    { header: "ja,en-US;q=0.9,en;q=0.8", locale: "ja-JP" },
    { header: "nb-NO,nb;q=0.9,no;q=0.8,nn;q=0.7,en-US;q=0.6,en;q=0.5", locale: "nb-NO" },
  ])("hands the http client the Chrome 149 Linux profile and $locale's header", (pins) => {
    expect(httpIdentity({ locale: pins.locale, timezone: undefined }).inputs).toStrictEqual({
      browser: "chrome_149",
      headerOrder: CHROME_HTTP1_HEADER_ORDER,
      headers: { "accept-language": pins.header },
      os: "linux",
    });
  });

  it("refuses a locale whose Chrome list is unmeasured, which the options never let through", () => {
    expect(() => httpIdentity({ locale: "sw-KE", timezone: undefined })).toThrow(
      "Xrio has not measured Chrome's language list for sw-KE.",
    );
  });
});
