import type { BlockCase } from "../block-cases.ts";

export const ticketmasterCases = {
  tp_ticketmaster_eps_block_403: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_heavy_script",
      passedChallenges: [],
      ruleIds: [
        "thin_text_heavy_script",
        "ticketmaster_eps_block",
        "ticketmaster_eps_header",
        "waf_status",
      ],
      vendor: "ticketmaster",
      verdict: "blocked",
    },
    headers: { "content-length": "5999", "content-type": "text/html; charset=utf-8", "tm-bl": "1" },
    html: `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta name="robots" content="noindex, nofollow">
<title>Browsing paused</title>
<script>
window.addEventListener("DOMContentLoaded", () => {
  const verdict = document.querySelector("abuse-component");
  const reference = verdict?.getAttribute("rid") ?? "";
  verdict?.setAttribute("data-reference", reference);
  setTimeout(() => window.location.reload(), 30000);
});
</script>
</head>
<body>
<abuse-component ip="192.0.2.10" rid="REDACTED" action="block" reload="true"></abuse-component>
</body></html>
`,
    requestUrls: [],
    status: 403,
    url: "https://target.example/page",
    why: "An abuse-component block page decides at any page size, beside its header and thin script.",
  },
  tp_ticketmaster_eps_identify_401: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_heavy_script",
      passedChallenges: [],
      ruleIds: ["thin_text_heavy_script", "ticketmaster_eps_header"],
      vendor: "ticketmaster",
      verdict: "blocked",
    },
    headers: { "content-length": "5962", "content-type": "text/html; charset=utf-8", "tm-bl": "1" },
    html: `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta name="robots" content="noindex, nofollow">
<title>Verify your identity</title>
<script>
window.addEventListener("DOMContentLoaded", () => {
  const verdict = document.querySelector("abuse-component");
  const reference = verdict?.getAttribute("rid") ?? "";
  verdict?.setAttribute("data-reference", reference);
  setTimeout(() => window.location.reload(), 30000);
});
</script>
</head>
<body>
<abuse-component ip="192.0.2.10" rid="REDACTED" action="identify" reload="true"></abuse-component>
</body></html>
`,
    requestUrls: [],
    status: 401,
    url: "https://target.example/page",
    why: "An abuse-component identity check is blocked by its header and thin script.",
  },
} satisfies Record<string, BlockCase>;
