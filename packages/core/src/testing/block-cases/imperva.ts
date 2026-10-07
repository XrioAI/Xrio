import type { BlockCase } from "../block-cases.ts";

export const impervaCases = {
  fp_imperva_loader_homepage_200: {
    cookies: ["visid_incap_REDACTED=REDACTEDxxxxxxxxxxxxxx; Path=/"],
    expect: {
      decoys: ["imperva_resource"],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: [],
      vendor: null,
      verdict: "ok",
    },
    headers: {
      "content-type": "text/html",
      server: "cloudflare",
      "x-iinfo": "12-34567890-34567891 NNNY CT(0 0 0) RT(1712345678 99) q(0 0 0 -1) r(2 2) U6",
    },
    html: `<!DOCTYPE html>
<html lang="en"><head><title>Tables | Restaurant reservations near you</title></head>
<body>
<header><a href="/cities">Cities</a><a href="/notify">Notify</a><a href="/account">Account</a></header>
<main>
  <h1>Popular this week in Riverton</h1>
  <article>
    <h2>Tonight, 7:00 PM, two guests</h2>
    <p>A twenty-eight seat room built around a wood grill, which is the whole menu rather than a
    feature of it. Bookings open twenty-eight days ahead at nine in the morning and the counter seats
    go first, partly because they are the only ones with a view of the fire and partly because they
    are the only ones that take walk-ins on a slow Tuesday. The wine list is short, entirely
    importer-direct, and priced closer to retail than the neighbourhood average.</p>
    <span>Notify me when a table opens</span>
  </article>
  <article>
    <h2>Saturday, 6:30 PM, four guests</h2>
    <p>A neighbourhood trattoria that has been in the same family since the room was a bakery, and
    still bakes its own bread in the original oven at the back. Pasta is cut to order, the menu turns
    over about every six weeks, and there is a standing corkage arrangement on Mondays that regulars
    treat as the main reason to come on a Monday.</p>
    <span>Book</span>
  </article>
</main>
<script type="text/javascript" src="/_Incapsula_Resource?SWJIYLWA=[redacted]&amp;ns=1&amp;cb=1234567890" async=""></script>
<script src="/modules/app.js" defer></script>
</body></html>
`,
    requestUrls: [],
    status: 200,
    url: "https://target.example/page",
    why: "Imperva's resource loader beside prose stays quiet, and only a page with almost no prose lets it decide.",
  },
  tp_imperva_block_403: {
    cookies: [
      "visid_incap_REDACTED=REDACTEDxxxxxxxxxxxxxx; expires=Wed, 11 Aug 2027 09:14:22 GMT; HttpOnly; path=/; Domain=.pharma.example",
      "incap_ses_REDACTED=REDACTEDxxxxxxxxxxxxxxxxx; path=/; Domain=.pharma.example",
    ],
    expect: {
      decoys: [],
      page: "interstitial_no_prose",
      passedChallenges: [],
      ruleIds: ["imperva_incident_id", "imperva_resource", "waf_status"],
      vendor: "imperva",
      verdict: "blocked",
    },
    headers: {
      "content-type": "text/html",
      "x-cdn": "Incapsula",
      "x-iinfo": "12-34567890-34567891 NNNY CT(0 0 0) RT(1786518862 99) q(0 0 0 -1) r(2 2) U6",
    },
    html: `<html style="height:100%"><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="format-detection" content="telephone=no">
<meta name="robots" content="noindex, nofollow">
</head>
<body style="margin:0px;height:100%">
<iframe id="main-iframe" src="/_Incapsula_Resource?SWUDNSAI=31&xinfo=12-34567890-0&REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" frameborder="0" width="100%" height="100%"></iframe>
<div>Request unsuccessful. Incapsula incident ID: 1234000123456789-123456789012345678</div>
<script src="/_Incapsula_Resource?REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx&ns=1&cb=1786518862"></script>
</body></html>
`,
    requestUrls: [
      "https://www.pharma.example/products/generics",
      "https://www.pharma.example/_Incapsula_Resource?REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx&ns=1&cb=1786518862",
    ],
    status: 403,
    url: "https://www.pharma.example/products/generics",
    why: "Imperva's incident id and resource loader decide on a page with almost no prose.",
  },
} satisfies Record<string, BlockCase>;
