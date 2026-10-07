import type { BlockCase } from "../block-cases.ts";

export const genericCases = {
  fp_allowed_403_target: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: ["waf_status"],
      vendor: null,
      verdict: "suspect",
    },
    headers: { "content-type": "text/html; charset=utf-8", server: "Caddy" },
    html: `<!DOCTYPE html>
<html lang="en"><head><title>Members only — Example Cooperative</title></head>
<body>
<main>
<h1>This document is for members</h1>
<p>The annual report is published to members four weeks before it is released publicly. Sign in with
your membership number to read it now, or wait for the public release on the first of next month.
Membership is open to anyone who has bought from a member farm in the past year.</p>
<a href="/login">Sign in</a>
</main>
</body></html>
`,
    requestUrls: ["https://members.cooperative.example/library/annual-report-2026"],
    status: 403,
    url: "https://members.cooperative.example/library/annual-report-2026",
    why: "A page that answers 403 as part of its normal contract is one weak status signal, so suspect.",
  },
  fp_apache_403: {
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
      "content-type": "text/html; charset=iso-8859-1",
      date: "Tue, 11 Aug 2026 09:14:22 GMT",
      server: "Apache/2.4.62 (Debian)",
    },
    html: `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">
<html><head>
<title>403 Forbidden</title>
</head><body>
<h1>Forbidden</h1>
<p>You don't have permission to access this resource on this server. If you believe this is a
mistake, contact the site administrator listed below and quote the time of your request.</p>
<hr>
<address>Apache/2.4.62 (Debian) Server at www.example.com Port 443</address>
</body></html>
`,
    requestUrls: ["https://www.example.com/internal/reports"],
    status: 403,
    url: "https://www.example.com/internal/reports",
    why: "A stock Apache 403 is one weak status signal, so suspect rather than blocked.",
  },
  fp_json_api_403: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: ["body_is_json", "content_type_not_html", "waf_status"],
      vendor: null,
      verdict: "ok",
    },
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      server: "nginx",
      "x-request-id": "REDACTEDxxxxxxxxxxxxxxxxxx",
    },
    html: `{"error":"forbidden","code":"INSUFFICIENT_SCOPE","message":"The token is valid but lacks the accounts:read scope.","request_id":"REDACTEDxxxxxxxxxxxxxxxxxx"}
`,
    requestUrls: ["https://api.example.com/v2/accounts/4711"],
    status: 403,
    url: "https://api.example.com/v2/accounts/4711",
    why: "An API's own 403 with a JSON body is cancelled by the non-HTML content type.",
  },
  fp_json_body_mislabeled_as_html: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_no_prose",
      passedChallenges: [],
      ruleIds: ["body_is_json", "waf_status"],
      vendor: null,
      verdict: "ok",
    },
    headers: { "content-type": "text/html; charset=utf-8", server: "Microsoft-IIS/10.0" },
    html: `{"ok":false,"error":{"code":403,"reason":"order 4711 belongs to another tenant"}}
`,
    requestUrls: ["https://legacy.example.net/rpc/getOrder?id=4711"],
    status: 403,
    url: "https://legacy.example.net/rpc/getOrder?id=4711",
    why: "A JSON body under a text/html content type is caught by the body sniff alone.",
  },
  fp_nginx_403: {
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
      date: "Tue, 11 Aug 2026 09:15:03 GMT",
      server: "nginx/1.27.3",
    },
    html: `<html>
<head><title>403 Forbidden</title></head>
<body>
<center><h1>403 Forbidden</h1></center>
<hr><center>nginx/1.27.3</center>
<p>Directory listing is disabled for this location and no index document was found. Ask the
operator of this site to publish an index file if you expected content here.</p>
</body>
</html>
`,
    requestUrls: ["https://static.example.net/private/"],
    status: 403,
    url: "https://static.example.net/private/",
    why: "A stock nginx 403 is one weak status signal, so suspect.",
  },
  fp_polite_429_retry_after: {
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
      "content-type": "text/html; charset=utf-8",
      "retry-after": "120",
      server: "gunicorn/23.0.0",
      "x-ratelimit-limit": "60",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1786518982",
    },
    html: `<!DOCTYPE html>
<html lang="en"><head><title>Too Many Requests</title></head>
<body>
<h1>Slow down a little</h1>
<p>You have used all sixty requests in your one-minute window for this endpoint. The window resets
in about two minutes; the Retry-After header on this response carries the exact number of seconds.
Authenticated clients get a higher limit, and bulk exports have a separate endpoint that is not rate
limited per minute at all.</p>
</body></html>
`,
    requestUrls: ["https://api.example.com/search?q=espresso"],
    status: 429,
    url: "https://api.example.com/search?q=espresso",
    why: "A rate limit that names Retry-After is one weak signal, so suspect and never blocked.",
  },
  fp_s3_accessdenied_xml: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_no_prose",
      passedChallenges: [],
      ruleIds: ["body_is_xml", "content_type_not_html", "waf_status"],
      vendor: null,
      verdict: "ok",
    },
    headers: {
      "content-type": "application/xml",
      server: "AmazonS3",
      "x-amz-id-2": "REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "x-amz-request-id": "REDACTEDxxxxxxxx",
    },
    html: `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessDenied</Code><Message>Access Denied</Message><RequestId>REDACTEDxxxxxxxx</RequestId><HostId>REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</HostId></Error>
`,
    requestUrls: ["https://REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/reports/q3.pdf"],
    status: 403,
    url: "https://REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/reports/q3.pdf",
    why: "An object-store AccessDenied XML body cancels the weak status signal.",
  },
  fp_security_vendor_blog: {
    cookies: [],
    expect: {
      decoys: [
        "akamai_reference_id",
        "cf_chl_opt",
        "cf_restrict_access_text",
        "datadome_captcha_element",
        "datadome_captcha_host_dom",
        "hcaptcha_widget",
        "imperva_incident_id",
        "imperva_resource",
        "kasada_script_start",
        "perimeterx_app_id",
        "perimeterx_captcha_element",
        "recaptcha_widget",
      ],
      page: "over_text_limit",
      passedChallenges: [],
      ruleIds: [],
      vendor: null,
      verdict: "ok",
    },
    headers: {
      "cache-control": "public, max-age=600",
      "content-type": "text/html; charset=utf-8",
      server: "nginx",
    },
    html: `<!DOCTYPE html>
<html lang="en"><head>
<title>Anti-bot signatures: a field guide to Cloudflare, DataDome, PerimeterX, Akamai, Imperva and Kasada</title>
</head>
<body>
<article>
<h1>Anti-bot signatures: a field guide</h1>
<p class="byline">Posted 4 August 2026 &middot; 11 minute read</p>

<p>Every vendor in this space leaves fingerprints, and most of them are documented badly or not at
all. Over the last two years we have collected block pages from roughly nine hundred targets and
sorted them by what actually distinguishes a mitigation from an ordinary error page. What follows is
the reference we wish had existed when we started. It names the markers directly, because a field
guide that refuses to print the strings it is describing is useless to the person reading it at two
in the morning with a failing crawl.</p>

<h2>Cloudflare</h2>
<p>Cloudflare is the one everybody meets first. The managed challenge interstitial is a small
document that bootstraps a configuration object into the global scope; historically that object is
written as window._cf_chl_opt and carries the challenge type, the ray id and the origin host. The
page then fetches its orchestration bundle from a path under the site's own domain, which is where
the widely quoted /cdn-cgi/challenge-platform/ prefix comes from. A detail that trips people up: the
same prefix is used by JS Detections, which is entirely passive and runs on pages that load
perfectly, so the prefix on its own tells you nothing. The interstitial-only paths are the
orchestrate, cv and flow segments. Firewall blocks are a different page altogether, built around a
four digit error code in a span with the class cf-error-code, and error 1020 prints a sentence
saying that the site owner used Cloudflare to restrict access.</p>
<p>The header worth trusting is cf-mitigated, which Cloudflare documents and which appears on 403,
503 and — the part that surprises people — plain 200 responses. Do not confuse any of that with
cf-ray, server: cloudflare, or the __cf_bm cookie. Those three ride along on every response from
every Cloudflare-fronted origin on the internet, and cf_clearance means the opposite of a block: it
is proof that a challenge was already solved. We have reviewed four open-source classifiers that
treat at least one of those three as a block signal, and all four report false positives on
their own test corpora.</p>

<h2>DataDome</h2>
<p>DataDome's block page loads its captcha from geo.captcha-delivery.com and mounts it into markup
with class names built on the captcha__human prefix. The response carries an x-datadome header
stating what DataDome decided. The client cookie named datadome, on the other hand, is set on every
response the product handles, blocked or not, so it belongs in the same bucket as __cf_bm.</p>

<h2>PerimeterX (HUMAN)</h2>
<p>PerimeterX splits into a sensor and an enforcer. The sensor bootstraps with a line of the form
window._pxAppId = 'PXxxxxxxxx' and posts telemetry to a collector host under px-cloud.net. Both of
those appear on pages that render fine, which is the single most common mistake we see in scrapers
that try to detect PerimeterX: they key on the sensor and conclude they are blocked on every page of
a protected site. The enforcement signals are different — a captcha host under px-cdn.net, a
px-captcha mount point, and an x-px-pp or x-px-gt response header.</p>

<h2>Akamai</h2>
<p>Akamai Bot Manager leans on the _abck cookie. The field layout matters more than the value: the
second tilde-separated field is 0 once the sensor has validated the session and -1 while it has not.
The trap is that a validated cookie still ends in ~-1~-1~-1, so a naive substring search for the
unvalidated marker matches the success case. Akamai's own error pages print a reference triple,
formatted like Reference #18.7f3a1c2d.1786518862.9f8e7d6c, and the x-akamai-transformed header is
front-end optimization metadata that says nothing about mitigation.</p>

<h2>Imperva</h2>
<p>Imperva, which most people still call Incapsula, injects a loader whose query string is built
around _Incapsula_Resource. Like the PerimeterX sensor, that loader is present on ordinary pages.
The block page is recognizable because it prints an Incapsula incident ID, and the x-iinfo header is
present on everything the product fronts.</p>

<h2>Kasada</h2>
<p>Kasada's client bootstraps through KPSDK.scriptStart and a script path made of two fixed UUIDs
that have been stable for years. The response headers are the reliable part: anything prefixed
x-kpsdk- comes from Kasada's enforcement layer.</p>

<h2>AWS WAF</h2>
<p>AWS WAF is the one that silently defeats status-based detection. Its challenge and captcha
actions can return 202 and 405, and 202 reads as success to every HTTP client we tested. The signal
to key on is x-amzn-waf-action, which names the action taken, plus the challenge bundle fetched from
a host under token.awswaf.com.</p>

<h2>Queue-it and the waiting-room family</h2>
<p>Waiting rooms deserve their own category and almost never get one. Queue-it parks the visitor on a
host under queue-it.net and holds them there until a slot opens; the page returns 200 and contains
real content, so nothing about the response looks like a mitigation. Treating it as a block is
actively harmful, because the correct response to a waiting room is to wait, and the correct response
to a block is to stop and rotate. Cloudflare and Akamai both ship comparable products, and in every
case the tell is the final URL after redirects rather than anything in the body.</p>

<h2>What we would measure instead</h2>
<p>The uncomfortable conclusion of this survey is that no implementation we reviewed publishes a
false-positive rate, and no public labelled corpus exists to compute one against. Every project we
read tunes toward detection on the stated theory that a false positive is cheap. For an interactive
scraper that may be true. For a scheduled job with a proxy budget, a false block is expensive twice
over: it burns the budget on retries that were never going to help, and it poisons whatever
time-series someone is using to decide whether the tooling is getting better or worse. If you take
one thing from this guide, take the habit of keeping a corpus of pages that are NOT blocks — plain
Apache and nginx errors, object-store denials, JSON API errors, login forms with captcha widgets,
polite rate limits — and running every signature change against it before shipping. The
true-positive half is the easy half.</p>

<h2>Widgets are not mitigations</h2>
<p>Finally, a warning about captcha widgets. Markup containing g-recaptcha, h-captcha or a
cf-turnstile div usually means a site author put a captcha on their own login form. That is not a
mitigation and it is not a block; treating widget markup as evidence classifies most login pages on
the web as blocked. The same goes for this very article, which contains every string above and is
nonetheless just an article.</p>
</article>
<script src="/assets/highlight.js" defer></script>
</body></html>
`,
    requestUrls: [
      "https://blog.security.example/2026/anti-bot-signatures-field-guide",
      "https://blog.security.example/assets/post.css",
      "https://blog.security.example/assets/highlight.js",
    ],
    status: 200,
    url: "https://blog.security.example/2026/anti-bot-signatures-field-guide",
    why: "An article quoting every vendor marker stays ok because a served page is not interstitial-shaped.",
  },
  fp_two_captcha_widgets_one_family: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: ["hcaptcha_widget", "recaptcha_widget"],
      vendor: null,
      verdict: "suspect",
    },
    headers: { "content-type": "text/html; charset=utf-8", server: "nginx" },
    html: `<!DOCTYPE html>
<html lang="en"><head><title>Contact support</title></head>
<body>
<form method="post" action="/contact">
<label for="msg">How can we help?</label>
<textarea id="msg" name="msg"></textarea>
<div class="g-recaptcha" data-sitekey="REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"></div>
<div class="h-captcha" data-sitekey="REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxx"></div>
<button type="submit">Send</button>
</form>
<p>We answer within one business day. Include your account id if you have one, and please do not
paste passwords or API keys into this form.</p>
</body></html>
`,
    requestUrls: [
      "https://support.example.com/contact",
      "https://www.google.com/recaptcha/api.js",
      "https://js.hcaptcha.com/1/api.js",
    ],
    status: 200,
    url: "https://support.example.com/contact",
    why: "Two captcha widgets are one family, so they stay suspect rather than blocked.",
  },
  sel_content_missing_clean_classifier: {
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
      "cf-ray": "REDACTEDxxxxxxxxxxxx",
      "content-type": "text/html; charset=utf-8",
      server: "cloudflare",
    },
    html: `<!DOCTYPE html><html lang="en"><head><title>Espresso Grinder EG-441 — Example Shop</title></head>
<body>
<main>
  <h1 class="pdp__heading">Espresso Grinder EG-441</h1>
  <p class="pdp__price">EUR 389.00</p>
  <p>A flat-burr grinder built for espresso, rebuilt on our new product page template. Everything the
  old page carried is still here, under different class names, which is precisely why a missing
  selector must not be reported as a block.</p>
  <button data-sku="ESP-441">Add to cart</button>
</main>
<script src="/static/app.a1b2c3.js" defer></script>
</body></html>
`,
    requestUrls: [
      "https://shop.example.com/p/espresso-grinder",
      "https://shop.example.com/static/app.a1b2c3.js",
    ],
    status: 200,
    url: "https://shop.example.com/p/espresso-grinder",
    why: "A clean 200 from a redesigned page is ok, because a missing selector is not a block.",
  },
  sel_demote_suspect_to_ok: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: ["waf_status"],
      vendor: null,
      verdict: "suspect",
    },
    headers: { "content-type": "text/html; charset=utf-8", server: "Caddy" },
    html: `<!DOCTYPE html><html lang="en"><head><title>Annual report 2026 — preview</title></head>
<body>
<main>
<h1 id="report-title">Annual report 2026</h1>
<p>This preview is served with a 403 by a misconfigured edge rule, but the document itself is here in
full. The required selector matched, so the render is usable and the weak status signal is recorded
rather than acted on.</p>
</main>
</body></html>
`,
    requestUrls: ["https://members.cooperative.example/library/annual-report-2026"],
    status: 403,
    url: "https://members.cooperative.example/library/annual-report-2026",
    why: "A 403 on a page whose content is present is still only suspect.",
  },
  tp_expected_vendor_absent_403: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: ["waf_status"],
      vendor: null,
      verdict: "suspect",
    },
    headers: { "content-type": "text/html; charset=utf-8", server: "nginx" },
    html: `<!DOCTYPE html><html lang="fr"><head><title>Erreur</title></head>
<body>
<h1>Accès refusé</h1>
<p>Votre requête ne peut pas être traitée pour le moment. Merci de réessayer plus tard ou de nous
contacter si le problème persiste sur cette page.</p>
</body></html>
`,
    requestUrls: ["https://www.classifieds.example/annonces/moto"],
    status: 403,
    url: "https://www.classifieds.example/annonces/moto",
    why: "A 403 with no vendor signal at all is only suspect.",
  },
  unk_parse_failure: {
    cookies: [],
    fault: "request_log_unreadable",
    headers: { "content-type": "text/html; charset=utf-8" },
    html: "",
    status: 200,
    url: "https://www.shop.example/produkte/kaffeemuehle",
    why: "A classifier failure reports unknown, never a WAF outcome.",
  },
} satisfies Record<string, BlockCase>;
