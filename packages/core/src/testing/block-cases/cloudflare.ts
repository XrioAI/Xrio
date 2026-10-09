import type { BlockCase } from "../block-cases.ts";

export const cloudflareCases = {
  fp_cloudflare_cached_homepage_200: {
    cookies: ["__cf_bm=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Path=/; Secure"],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: [],
      vendor: null,
      verdict: "ok",
    },
    headers: {
      "cf-cache-status": "HIT",
      "cf-ray": "REDACTEDxxxxxxxxxxxx",
      "content-type": "text/html; charset=utf-8",
      server: "cloudflare",
    },
    html: `<!DOCTYPE html>
<html lang="en-US"><head><title>Sportsbook - choose your state</title>
<script async src="https://www.googletagmanager.com/gtm.js?id=GTM-EXAMPLE"></script>
</head>
<body>
<header><a href="/usa">Sportsbook</a><a href="/usa/racing">Racing</a><a href="/members">Log in</a></header>
<main>
  <h1>Choose your state</h1>
  <p>Pick the state you are betting from and the site will send you to the sportsbook licensed
  there. The list below is the set of states this operator is live in today; the second list is the
  one it takes an email address for, so that it can tell you when it launches somewhere you can
  actually place a wager. Nothing on this page is a bet slip — it is a router, and it exists because
  the licence is granted per state rather than per country.</p>
  <ul>
    <li><a href="/usa?state=nj">New Jersey</a></li>
    <li><a href="/usa?state=co">Colorado</a></li>
    <li><a href="/usa?state=oh">Ohio</a></li>
    <li><a href="/usa?state=va">Virginia</a></li>
    <li><a href="/usa?state=ia">Iowa</a></li>
  </ul>
  <section>
    <h2>Not live in your state yet</h2>
    <p>Choose a state from the second list and leave an email address, and you will hear once the
    sportsbook opens there. The address is used for that notice and nothing else, which the page
    says in the small print underneath the form rather than in a policy nobody opens.</p>
    <label for="state">Choose a state</label>
    <select id="state" name="state"><option>Alabama</option><option>California</option><option>New York</option><option>Texas</option></select>
    <button type="submit">Sign Up</button>
  </section>
  <section>
    <h2>Why us?</h2>
    <p>Long experience running a sportsbook, customer service that answers the phone, withdrawals
    that clear in a working day, and a long list of live in-game markets. Those are the four claims the page makes for itself, in that order, and
    they occupy most of its visible height.</p>
  </section>
</main>
<footer>
  <p>Gambling problem? Call or text the helpline for your state. 21+ only, and you must be physically present in a
  state where the sportsbook is licensed. Odds and markets are subject to change.</p>
</footer>
<script src="/usa/assets/app.js" defer></script>
</body></html>
`,
    requestUrls: [],
    status: 200,
    url: "https://target.example/page",
    why: "Cloudflare delivery headers and the bot-management cookie on a served page are non-signals.",
  },
  fp_cloudflare_normal_200: {
    cookies: [
      "__cf_bm=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Path=/; Secure; HttpOnly; SameSite=None",
      "cf_clearance=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Path=/; Secure; HttpOnly",
      "cart_id=REDACTED; Path=/",
    ],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: [],
      vendor: null,
      verdict: "ok",
    },
    headers: {
      "cf-cache-status": "DYNAMIC",
      "cf-ray": "REDACTEDxxxxxxxxxxxx",
      "content-type": "text/html; charset=utf-8",
      server: "cloudflare",
      vary: "Accept-Encoding",
    },
    html: `<!DOCTYPE html>
<html lang="en"><head>
<title>Espresso Grinder EG-441 — Example Shop</title>
<link rel="stylesheet" href="/static/app.9f8e7d.css">
</head>
<body>
<header><nav><a href="/">Example Shop</a><a href="/coffee">Coffee</a><a href="/cart">Cart</a></nav></header>
<main>
  <h1 id="product-title">Espresso Grinder EG-441</h1>
  <p class="price">EUR 389.00</p>
  <p>A flat-burr grinder built for espresso. The 64 mm burrs are driven by a low-speed motor that
  keeps retention under a gram, and the stepless collar lets you dial in a shot without losing your
  reference point. Ships with a portafilter cradle and a two-year warranty.</p>
  <ul>
    <li>64 mm flat burrs, hardened steel</li>
    <li>Stepless adjustment, roughly 8 microns per detent</li>
    <li>Single-dose hopper included</li>
    <li>Under 1 g retention measured across 30 consecutive doses</li>
  </ul>
  <button data-sku="ESP-441">Add to cart</button>
  <section><h2>Reviews</h2>
  <p>Consistent grind quality across a full range of espresso settings, and quiet enough to run
  before six in the morning without waking the house.</p></section>
</main>
<footer><p>Example Shop GmbH — Berlin. Prices include VAT.</p></footer>
<script src="/static/app.9f8e7d.js" defer></script>
</body></html>
`,
    requestUrls: [
      "https://shop.example.com/p/espresso-grinder",
      "https://shop.example.com/static/app.9f8e7d.css",
      "https://shop.example.com/static/app.9f8e7d.js",
      "https://cdn.example.com/img/grinder-hero.webp",
      "https://shop.example.com/api/v1/stock?sku=ESP-441",
    ],
    status: 200,
    url: "https://shop.example.com/p/espresso-grinder",
    why: "cf-ray, server, __cf_bm and cf_clearance on a normal 200 must not count as a block.",
  },
  fp_turnstile_login_200: {
    cookies: [
      "__cf_bm=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Path=/; Secure",
      "csrftoken=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxx; Path=/; Secure",
    ],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: [],
      vendor: null,
      verdict: "ok",
    },
    headers: {
      "cf-ray": "REDACTEDxxxxxxxxxxxx",
      "content-type": "text/html; charset=utf-8",
      server: "cloudflare",
    },
    html: `<!DOCTYPE html>
<html lang="en"><head><title>Sign in — Example Accounts</title>
<link rel="stylesheet" href="/static/login.css">
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>
<body>
<main class="card">
  <h1>Sign in to your Example account</h1>
  <form id="login-form" method="post" action="/login">
    <label for="email">Email address</label>
    <input id="email" name="email" type="email" autocomplete="username" required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <div class="cf-turnstile" data-sitekey="REDACTEDxxxxxxxxxxxxxxxx" data-theme="light"></div>
    <button type="submit">Sign in</button>
  </form>
  <p><a href="/password/reset">Forgot your password?</a> Accounts locked after ten failed attempts
  are released automatically after fifteen minutes. If you use a hardware key, plug it in before you
  submit the form; the browser will prompt you once the password has been accepted.</p>
  <p>New here? <a href="/signup">Create an account</a>. By continuing you agree to the Terms of
  Service and acknowledge the Privacy Policy.</p>
</main>
</body></html>
`,
    requestUrls: [
      "https://accounts.example.org/login",
      "https://accounts.example.org/static/login.css",
      "https://challenges.cloudflare.com/turnstile/v0/api.js",
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/scripts/jsd/main.js",
    ],
    status: 200,
    url: "https://accounts.example.org/login",
    why: "A site author's own Turnstile widget and its public bundle are not the challenge platform.",
  },
  sel_conflict_e0_and_selector_match: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_no_prose",
      passedChallenges: [],
      ruleIds: ["cf_mitigated_challenge", "challenge_title"],
      vendor: "cloudflare",
      verdict: "blocked",
    },
    headers: {
      "cf-mitigated": "challenge",
      "cf-ray": "REDACTEDxxxxxxxxxxxx",
      "content-type": "text/html; charset=UTF-8",
      server: "cloudflare",
    },
    html: `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head>
<body>
<div id="main">
  <noscript>Enable JavaScript and cookies to continue</noscript>
</div>
</body></html>
`,
    requestUrls: ["https://tickets.example.com/events/12345"],
    status: 200,
    url: "https://tickets.example.com/events/12345",
    why: "A decisive cf-mitigated header decides alone on a page with almost no text, and the title corroborates it.",
  },
  tp_cloudflare_1020_dom_only: {
    cookies: ["__cf_bm=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Path=/; Secure"],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: ["cf_error_code_span", "cf_restrict_access_text", "waf_status"],
      vendor: "cloudflare",
      verdict: "blocked",
    },
    headers: {
      "cf-ray": "REDACTEDxxxxxxxxxxxx",
      "content-type": "text/html; charset=UTF-8",
      server: "cloudflare",
    },
    html: `<!DOCTYPE html><html lang="en-US"><head>
<title>Access denied</title>
<meta name="robots" content="noindex,nofollow">
</head>
<body>
<div id="cf-wrapper">
  <div class="cf-error-details-wrapper">
    <h1><span class="cf-error-type">Access denied</span> <span class="cf-error-code">1020</span></h1>
    <h2 class="cf-subheadline">Error 1020 &mdash; Ray ID: REDACTEDxxxxxxxx</h2>
    <p>This website is using a security service to protect itself from online attacks. You cannot
    access this page because the owner of www.retail.example used Cloudflare to restrict access.</p>
  </div>
  <div class="cf-footer"><p>Performance &amp; security by Cloudflare</p></div>
</div>
</body></html>
`,
    requestUrls: ["https://www.retail.example/catalog/search?q=sneakers"],
    status: 403,
    url: "https://www.retail.example/catalog/search?q=sneakers",
    why: "Cloudflare error 1020 decides on its markup with no header or request-log evidence.",
  },
  tp_cloudflare_block_headline_403: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: ["cf_block_headline", "challenge_title", "waf_status"],
      vendor: "cloudflare",
      verdict: "blocked",
    },
    headers: {
      "cf-ray": "REDACTEDxxxxxxxxxxxx",
      "content-type": "text/html; charset=utf-8",
      server: "cloudflare",
    },
    html: `<!DOCTYPE html><html class="no-js" lang="en-US"><head>
<title>Attention Required! | Cloudflare</title>
<meta charset="UTF-8">
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" id="cf_styles-css" href="/cdn-cgi/styles/cf.errors.css">
<script>document.documentElement.className = document.documentElement.className.replace("no-js", "js");</script>
</head>
<body>
<div id="cf-wrapper">
<div id="cf-error-details" class="cf-error-details-wrapper">
<h1 data-translate="block_headline">Sorry, you have been blocked</h1>
<h2 class="cf-subheadline"><span data-translate="unable_to_access">You are unable to access</span> target.example</h2>
<h2 data-translate="blocked_why_headline">Why have I been blocked?</h2>
<p data-translate="blocked_why_detail">A security service in front of this site stopped the request. Some requests are stopped because of what they contain, and some because of where they come from or how quickly they arrive.</p>
<h2 data-translate="blocked_resolve_headline">What can I do to resolve this?</h2>
<p data-translate="blocked_resolve_detail">Contact the owner of the site and tell them what you were doing when this page appeared, together with the reference shown below.</p>
<p>Ray ID: <strong>REDACTED</strong></p>
</div>
</div>
</body></html>
`,
    requestUrls: [],
    status: 403,
    url: "https://target.example/",
    why: "Cloudflare's current block template is recognised by its translation key, not its English text.",
  },
  tp_cloudflare_managed_challenge_200: {
    cookies: [
      "__cf_bm=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Path=/; Secure; HttpOnly",
      "cf_chl_2=REDACTEDxxxxxxxx; Path=/; Secure; HttpOnly; SameSite=Lax",
      "cf_chl_prog=REDACTED; Path=/; Secure; HttpOnly; SameSite=Lax",
    ],
    expect: {
      decoys: [],
      page: "interstitial_heavy_script",
      passedChallenges: [],
      ruleIds: [
        "cf_challenge_cookie",
        "cf_challenge_form",
        "cf_challenge_platform_dom",
        "cf_challenge_platform_request",
        "cf_chl_opt",
        "cf_mitigated_challenge",
        "challenge_title",
        "thin_text_heavy_script",
      ],
      vendor: "cloudflare",
      verdict: "blocked",
    },
    headers: {
      "cache-control": "private, max-age=0, no-store, no-cache, must-revalidate",
      "cf-mitigated": "challenge",
      "cf-ray": "REDACTEDxxxxxxxxxxxx",
      "content-type": "text/html; charset=UTF-8",
      server: "cloudflare",
    },
    html: `<!DOCTYPE html><html lang="en-US" dir="ltr"><head>
<title>Just a moment...</title>
<meta http-equiv="X-UA-Compatible" content="IE=Edge">
<meta name="robots" content="noindex,nofollow">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body class="no-js">
<div class="main-wrapper" role="main"><div class="main-content">
<noscript><div id="challenge-error-title">Enable JavaScript and cookies to continue</div></noscript>
</div></div>
<form id="challenge-form" action="/events/12345?__cf_chl_f_tk=abcdef" method="POST"></form>
<script>window._cf_chl_opt={cvId:'3',cZone:'tickets.example.com',cType:'managed',cRay:'REDACTEDxxxxxxxx',cH:'x11',cUPMDTk:'/events/12345',md:'aaaa',mdrd:'bbbb',chlApivId:'0',chlApiWidgetId:'cf-chl-widget-x11'};</script>
<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?REDACTEDxxxxxxxxxxxx"></script>
</body></html>
`,
    requestUrls: [
      "https://tickets.example.com/events/12345",
      "https://tickets.example.com/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?REDACTEDxxxxxxxxxxxx",
      "https://challenges.cloudflare.com/turnstile/v0/api.js",
      "https://tickets.example.com/cdn-cgi/challenge-platform/h/g/cv/result/REDACTEDxxxxxxxx",
    ],
    status: 200,
    url: "https://tickets.example.com/events/12345",
    why: "A managed challenge at status 200 is caught by header, second-position cookie, request log and markup.",
  },
  tp_non_english_interstitial: {
    cookies: ["__cf_bm=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Path=/; Secure"],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: ["cf_challenge_platform_request", "waf_status"],
      vendor: "cloudflare",
      verdict: "blocked",
    },
    headers: {
      "cache-control": "private, max-age=0, no-store, no-cache, must-revalidate",
      "cf-ray": "REDACTEDxxxxxxxxxxxx",
      "content-type": "text/html; charset=UTF-8",
      server: "cloudflare",
    },
    html: `<!DOCTYPE html><html lang="de-DE" dir="ltr"><head>
<title>Nur einen Moment …</title>
<meta name="robots" content="noindex,nofollow">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body>
<div class="main-wrapper">
<h1>www.shop.example überprüft Ihre Verbindung</h1>
<p>Ihr Browser wird überprüft, bevor Sie auf die Website zugreifen können. Dieser Vorgang dauert nur
wenige Sekunden und muss einmal pro Sitzung durchgeführt werden. Bitte aktivieren Sie JavaScript und
Cookies, damit die Prüfung abgeschlossen werden kann.</p>
</div>
</body></html>
`,
    requestUrls: [
      "https://www.shop.example/produkte/kaffeemuehle",
      "https://www.shop.example/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?REDACTEDxxxxxxxxxxxx",
    ],
    status: 503,
    url: "https://www.shop.example/produkte/kaffeemuehle",
    why: "A German challenge page is caught by the request log because titles are English-only.",
  },
  tp_set_cookie_third_value_decides: {
    cookies: [
      "__cf_bm=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Path=/; Secure",
      "shop_session=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxx; Path=/; HttpOnly",
      "cf_chl_2=REDACTEDxxxxxxxx; Domain=.shop.example; Path=/; Secure; HttpOnly",
    ],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: ["cf_challenge_cookie", "waf_status"],
      vendor: "cloudflare",
      verdict: "blocked",
    },
    headers: {
      "cf-ray": "REDACTEDxxxxxxxxxxxx",
      "content-type": "text/html",
      server: "cloudflare",
    },
    html: `<!DOCTYPE html><html><head><title>Request blocked</title></head>
<body>
<p>Your request could not be completed. If you believe this is an error, contact our support desk and
quote the time of day and the route you were searching for.</p>
</body></html>
`,
    requestUrls: ["https://www.shop.example/api/fares?from=FRA&to=LIS"],
    status: 403,
    url: "https://www.shop.example/api/fares?from=FRA&to=LIS",
    why: "A challenge cookie in third position is still read.",
  },
} satisfies Record<string, BlockCase>;
