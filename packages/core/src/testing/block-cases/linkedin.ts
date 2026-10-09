import type { BlockCase } from "../block-cases.ts";

export const linkedinCases = {
  tp_linkedin_authwall_200: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: ["linkedin_authwall_canonical"],
      vendor: "linkedin",
      verdict: "blocked",
    },
    headers: {
      "cf-cache-status": "HIT",
      "cf-ray": "REDACTEDxxxxxxxxxxxx",
      "content-length": "10062",
      "content-type": "text/html; charset=utf-8",
      server: "cloudflare",
    },
    html: `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, minimum-scale=1.0">
<link rel="canonical" href="/authwall">
<title>Sign Up</title>
<meta name="robots" content="noindex, noarchive">
<script src="/static/authwall/bundle.js" defer></script>
</head>
<body dir="ltr">
<main>
<h1>Join to see the full profile</h1>
<p>Sign in or create a free account to see this member's experience, education and the people they know.</p>
<form action="/uas/login-submit" method="post">
<label for="session_key">Email or phone</label><input id="session_key" name="session_key" type="text">
<label for="session_password">Password</label><input id="session_password" name="session_password" type="password">
<button type="submit">Sign in</button>
</form>
<p>New here? <a href="/signup">Join now</a></p>
</main>
</body></html>
`,
    requestUrls: [],
    status: 200,
    url: "https://target.example/after-redirect",
    why: "An authwall is identified by its own canonical link at any page size, even at status 200.",
  },
} satisfies Record<string, BlockCase>;
