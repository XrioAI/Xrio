import type { BlockCase } from "../block-cases.ts";

export const akamaiCases = {
  fp_akamai_normal_200: {
    cookies: [
      "bm_sz=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Domain=.air.example; Path=/",
      "ak_bmsc=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Domain=.air.example; Path=/",
      "_abck=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Domain=.air.example; Path=/",
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
      "content-type": "text/html;charset=UTF-8",
      server: "AkamaiGHost",
      "x-akamai-transformed": "9 12345 0 pmb=mRUM,1",
    },
    html: `<!DOCTYPE html>
<html lang="en"><head><title>Find flights — Example Air</title></head>
<body>
<main>
  <h1 id="search-heading">Where would you like to go?</h1>
  <form action="/booking/search" method="get">
    <label for="from">From</label><input id="from" name="from" value="FRA">
    <label for="to">To</label><input id="to" name="to" value="LIS">
    <label for="depart">Departure</label><input id="depart" name="depart" type="date">
    <button type="submit">Search flights</button>
  </form>
  <section><h2>Popular routes this month</h2>
  <p>Frankfurt to Lisbon, Munich to Palma and Berlin to Naples are the most booked routes for
  August. Fares shown include taxes and one cabin bag; checked baggage is priced per leg during
  checkout and can be added up to four hours before departure.</p></section>
</main>
<script src="/static/booking.bundle.js" defer></script>
</body></html>
`,
    requestUrls: [
      "https://www.air.example/booking/flights",
      "https://www.air.example/akam/13/1f2e3d4c",
      "https://www.air.example/static/booking.bundle.js",
    ],
    status: 200,
    url: "https://www.air.example/booking/flights",
    why: "A resolved Akamai sensor cookie ends in the same trailing fields as an unvalidated one and matches nothing.",
  },
  fp_akamai_retail_homepage_200: {
    cookies: ["_abck=REDACTEDxxxxxxxxxxxxxxxxxxxxx; Path=/; Secure"],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: [],
      vendor: null,
      verdict: "ok",
    },
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-akamai-transformed": "9 12345 0 pmb=mRUM,1",
    },
    html: `<!DOCTYPE html>
<html lang="en"><head><title>Electronics Store | Weekly deals</title>
<script src="/assets/vendor.js" defer></script>
</head>
<body>
<header><a href="/cart">Cart</a><a href="/deals/electronics">Top deals</a><a href="/stores">Stores</a></header>
<main>
  <h1>Top deals this week</h1>
  <article>
    <h2>65-inch 4K television</h2>
    <p>A sixty-five inch panel at the size most rooms actually want, which is one notch larger than
    the one people talk themselves into and then regret. It does the two things that matter on a
    television at this price: it gets bright enough that daytime viewing does not need the curtains
    shut, and its local dimming keeps letterbox bars from glowing grey during a film.</p>
    <span>699.99</span>
  </article>
  <article>
    <h2>Noise-cancelling over-ear headphones</h2>
    <p>Thirty hours on a charge with cancelling on, and the case is flat rather than clamshell so it
    goes in a bag without a fight. The cancelling is tuned for engine and cabin noise rather than
    for voices, which is the honest trade — it will not silence an office, and it makes a long
    flight feel about two hours shorter.</p>
    <span>249.99</span>
  </article>
  <nav><a href="/deals/electronics?page=2">Next page</a><a href="/stores/find">Find a store</a></nav>
</main>
<script src="/assets/homepage/_next/static/chunks/main.js" defer></script>
</body></html>
`,
    requestUrls: [],
    status: 200,
    url: "https://target.example/page",
    why: "An unvalidated Akamai sensor cookie and the transformed-content header on a fully delivered page are not a block.",
  },
  tp_akamai_edge_error_403: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: ["waf_status"],
      vendor: null,
      verdict: "suspect",
    },
    headers: {
      "content-type": "text/html",
      server: "AkamaiGHost",
      "x-akamai-transformed": "9 12345 0 pmb=mRUM,1",
    },
    html: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="robots" content="noindex,nofollow"><title>Error Page</title><style>body{margin:0;font-family:Arial,sans-serif;color:#333}.ref{font-weight:700;font-family:monospace}</style></head><body><main><p>Request refused</p><p>This page could not be loaded right now.</p><p class="ref">REDACTEDxxxxxxxxxxxxxxxxxxxxx</p><p>Wait a moment and try again, or return to the start page.</p><a href="https://www.target.example/">Go to homepage</a></main><footer><p>Copyright 2026 Example Marketplace. All rights reserved.</p></footer><script type="text/javascript" src="/REDACTED" defer=""></script></body></html>
`,
    requestUrls: [],
    status: 403,
    url: "https://target.example/item/1",
    why: "An Akamai edge refusal with a bare reference id and no prefix is a plain 403, so suspect.",
  },
  tp_akamai_reference_403: {
    cookies: [
      "bm_sz=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Domain=.air.example; Path=/",
      "ak_bmsc=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Domain=.air.example; Path=/",
      "_abck=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Domain=.air.example; Path=/",
    ],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: ["akamai_reference_id", "waf_status"],
      vendor: "akamai",
      verdict: "blocked",
    },
    headers: { "content-type": "text/html", "mime-version": "1.0", server: "AkamaiGHost" },
    html: `<HTML><HEAD>
<TITLE>Access Denied</TITLE>
</HEAD><BODY>
<H1>Access Denied</H1>
You don't have permission to access "http&#58;&#47;&#47;www&#46;air&#46;example&#47;booking&#47;search" on this server.<P>
Reference #18.7f3a1c2d.1786518862.9f8e7d6c<P>
https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18&#46;7f3a1c2d&#46;1786518862&#46;9f8e7d6c
</BODY></HTML>
`,
    requestUrls: ["https://www.air.example/booking/search?from=FRA&to=LIS"],
    status: 403,
    url: "https://www.air.example/booking/search?from=FRA&to=LIS",
    why: "Akamai's error reference triple decides alone on an interstitial-shaped page.",
  },
  tp_akamai_sec_cpt_challenge_200: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_heavy_script",
      passedChallenges: [],
      ruleIds: ["akamai_sec_cpt_challenge", "thin_text_heavy_script"],
      vendor: "akamai",
      verdict: "blocked",
    },
    headers: { "content-type": "text/html;charset=UTF-8" },
    html: `<!DOCTYPE html><html><head></head><body><script type="text/javascript" src="/AbCdEfGh/Q1B/_xx/REDACTED/challenge?v=REDACTED&amp;t=REDACTED"></script>
<div id="sec-if-cpt-container" role="main" style="display: none">
    <div class="behavioral-content">
        <div id="sec-bc-text-container"></div>
        <div id="sec-bc-tile-parent">
            <div id="sec-bc-tile-container"></div>
        </div>
        <div class="sec-bc-button-parent">
            <div class="behavioral-button progress-btn-disabled">
                <div class="btn" id="progress-button" role="button" tabindex="0" disabled=""></div>
                <div class="progress"></div>
            </div>
        </div>
        <div class="scf-akamai-logo-sec-abc">
            <div class="scf-akamai-logo-msg">
                <p class="scf-akamai-protected-by">Powered and protected by</p>
            </div>
            <div class="scf-akamai-logo-img">
                <img src="https://www.example.com/images/logo/akamai-logo.svg" class="scf-akamai-logo" loading="lazy" alt="Akamai">
            </div>
            <div class="akamai-privacy"><a href="https://www.example.com/privacy" target="_blank">Privacy<span class="_hidden"></span></a></div>
        </div>
    </div>
</div>
<script>
    (function() {
        var chlgeId = '';
        var context = 't';
        var scripts = document.getElementsByTagName('script');
        for (var i = 0; i < scripts.length; i++) {
            if (scripts[i].src && scripts[i].src.match(/t=([^&#]*)/)) {
                chlgeId = scripts[i].src.match(/t=([^&#]*)/)[1];
                context = /[?&]ch=true/.test(scripts[i].src) ? 'i' : 't';
            }
        }
        var proxied = window.XMLHttpRequest.prototype.send;
        window.XMLHttpRequest.prototype.send = function() {
            var pointer = this
            var intervalId = window.setInterval(function() {
                if (pointer.readyState === 4 && pointer.responseURL && pointer.responseURL.indexOf('t=' + chlgeId) > -1) {
                    if (context === 't') {
                        location.reload(true);
                    }
                    clearInterval(intervalId);
                }
            }, 1);
            return proxied.apply(this, [].slice.call(arguments));
        };
    })();
</script>
<script type="text/javascript" src="https://www.example.com/AbCdEfGh/Q1B/_xx/REDACTED/sensor"></script>



</body></html>
`,
    requestUrls: [
      "https://www.example.com/products/widget",
      "https://www.example.com/AbCdEfGh/Q1B/_xx/REDACTED/challenge?v=REDACTED&t=REDACTED",
      "https://www.example.com/AbCdEfGh/Q1B/_xx/REDACTED/sensor",
    ],
    status: 200,
    url: "https://www.example.com/products/widget",
    why: "Akamai's sec-cpt interstitial arrives as a 200 with a hidden challenge container and almost no prose, and its own script reloads the document when the challenge request completes, so it is a challenge to wait on and not a delivered page.",
  },
} satisfies Record<string, BlockCase>;
