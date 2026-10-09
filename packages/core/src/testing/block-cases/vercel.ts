import type { BlockCase } from "../block-cases.ts";

export const vercelCases = {
  tp_vercel_mitigated_401: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_no_prose",
      passedChallenges: [],
      ruleIds: ["vercel_mitigated"],
      vendor: "vercel",
      verdict: "blocked",
    },
    headers: {
      "cache-control": "no-store, must-revalidate",
      "content-type": "text/html; charset=utf-8",
      server: "Vercel",
      "x-vercel-id": "fra1::REDACTEDxxxxxxxxxxxxxxxxxxxxxxxx",
      "x-vercel-mitigated": "challenge",
    },
    html: `<!DOCTYPE html><html lang="en"><head><title>Verifying your browser</title></head>
<body>
<p>Please wait while we verify your request.</p>
<script>fetch('/.well-known/vercel/security/request-challenge',{method:'POST'}).then(function(r){if(r.ok){location.reload()}});</script>
</body></html>
`,
    requestUrls: [
      "https://app.example/dashboard",
      "https://app.example/.well-known/vercel/security/request-challenge",
    ],
    status: 401,
    url: "https://app.example/dashboard",
    why: "Vercel's mitigation header decides although 401 is no WAF status.",
  },
} satisfies Record<string, BlockCase>;
