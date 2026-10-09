import type { BlockCase } from "../block-cases.ts";

const SERVED_STYLESHEET_RULES = 1000;

export const spurCases = {
  fp_spur_monocle_challenge_passed_203: {
    cookies: [
      "__cf_bm=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; HttpOnly; SameSite=None; Secure; Path=/; Domain=target.example; Expires=Thu, 10 Sep 2026 03:37:21 GMT",
    ],
    expect: {
      decoys: [],
      page: "over_html_limit",
      passedChallenges: ["spur_monocle_loader_request"],
      ruleIds: ["spur_monocle_loader_request"],
      vendor: null,
      verdict: "ok",
    },
    headers: {
      "alt-svc": 'h3=":443"; ma=86400',
      "cf-ray": "REDACTEDxxxxxxxxxxxx",
      "content-length": "8801",
      "content-type": "text/html",
      date: "Thu, 10 Sep 2026 03:07:21 GMT",
      server: "cloudflare",
      vary: "accept-encoding",
    },
    html: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Groceries delivered in minutes</title>
<style>${".tile{margin:0 0 8px;padding:12px;border-radius:8px}\n".repeat(SERVED_STYLESHEET_RULES)}</style>
<script src="https://mcl.target.example/d/mcl.js?tk=REDACTED" async></script>
</head>
<body>
<header><a href="/">Home</a><a href="/deals">Deals</a><a href="/account">Account</a><a href="/cart">Cart</a></header>
<main>
<h1>Snacks, drinks and essentials, delivered in minutes</h1>
<p>Order from a local store that is open late and stocked with the things people actually run out of:
milk, bread, coffee, batteries, cold drinks and the odd bag of crisps. Delivery usually arrives within
half an hour, and the fee shown at checkout is the whole fee.</p>
<section class="tile"><h2>Breakfast</h2><p>Eggs, yoghurt, cereal and fresh bread from a nearby bakery,
restocked every morning before seven.</p></section>
<section class="tile"><h2>Household</h2><p>Detergent, paper towels, bin bags and light bulbs, in the sizes
that fit a small flat rather than a warehouse club.</p></section>
<section class="tile"><h2>Late night</h2><p>Ice cream, frozen pizza and cold drinks until two in the
morning on weekends, with the same delivery fee as the afternoon.</p></section>
</main>
<footer><a href="/help">Help</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a></footer>
</body></html>
`,
    requestUrls: [
      "https://www.target.example/",
      "https://www.googletagmanager.com/gtag/js?id=AW-REDACTED&gtg_health=1",
      "https://www.target.example/gtm/",
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap",
      "https://mcl.target.example/d/mcl.js?tk=REDACTED",
      "https://www.target.example/monocle/verify",
      "https://www.target.example/",
      "https://assets.target.example/",
      "https://images.target.example/badges/app-store.svg",
      "https://images.target.example/icons/social.svg",
    ],
    status: 203,
    url: "https://www.target.example/",
    why: "Spur's loader request on a page past the HTML gate is a passed challenge, not a block.",
  },
  tp_spur_monocle_denied_203: {
    cookies: [
      "__cf_bm=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; HttpOnly; SameSite=None; Secure; Path=/; Domain=target.example; Expires=Thu, 10 Sep 2026 03:37:21 GMT",
    ],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: ["spur_monocle_denied_text", "spur_monocle_loader_request"],
      vendor: "spur",
      verdict: "blocked",
    },
    headers: {
      "alt-svc": 'h3=":443"; ma=86400',
      "cf-ray": "REDACTEDxxxxxxxxxxxx",
      "content-length": "8801",
      "content-type": "text/html",
      date: "Thu, 10 Sep 2026 03:07:21 GMT",
      server: "cloudflare",
      vary: "accept-encoding",
    },
    html: `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Access check</title>
<script src="https://mcl.target.example/d/mcl.js?tk=REDACTED" async></script>
<script>
const statusLine = () => document.getElementById("connectionStatus");
const validate = async (bundle) => {
  const response = await fetch("/monocle/verify", { body: bundle, method: "POST" });
  if (response.status === 402) {
    statusLine().textContent = "Captcha validation failed. Please disconnect from any VPNs or proxies and try again.";
  }
};
</script>
</head>
<body>
<div class="center-div">
<div class="loading" id="connectionStatus">Captcha validation failed. Please disconnect from any VPNs or proxies and try again. 203.0.113.7 - REDACTED</div>
</div>
</body></html>
`,
    requestUrls: [
      "https://www.target.example/",
      "https://www.googletagmanager.com/gtag/js?id=AW-REDACTED&gtg_health=1",
      "https://www.target.example/gtm/",
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap",
      "https://mcl.target.example/d/mcl.js?tk=REDACTED",
      "https://www.target.example/monocle/verify",
    ],
    status: 203,
    url: "https://www.target.example/",
    why: "A Monocle denial is blocked by the loader request and its visible sentence.",
  },
} satisfies Record<string, BlockCase>;
