import type { BlockCase } from "../block-cases.ts";

export const datadomeCases = {
  fp_datadome_challenge_passed_403: {
    cookies: [
      "datadome=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Max-Age=31536000; Domain=.reviews.example; Path=/; Secure; SameSite=Lax",
      "__cf_bm=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; HttpOnly; SameSite=None; Secure; Path=/; Domain=reviews.example",
    ],
    expect: {
      decoys: [],
      page: "over_text_limit",
      passedChallenges: ["datadome_captcha_delivery_request"],
      ruleIds: ["datadome_captcha_delivery_request", "waf_status"],
      vendor: null,
      verdict: "suspect",
    },
    headers: {
      "access-control-expose-headers": "x-dd-b, x-set-cookie",
      "cache-control": "max-age=0, private, no-cache, no-store, must-revalidate",
      "cf-ray": "REDACTEDxxxxxxxxxxxx",
      "content-type": "text/html;charset=utf-8",
      server: "cloudflare",
      "strict-transport-security": "max-age=15552000; includeSubDomains; preload",
      "x-content-type-options": "nosniff",
      "x-datadome": "protected",
      "x-datadome-cid": "REDACTEDxxxxxxxxxxxxxxxxxxxxxxxx",
      "x-dd-b": "259",
    },
    html: `<!DOCTYPE html>
<html lang="en"><head><title>Software reviews by teams | Example Reviews</title></head>
<body>
<header><nav><a href="/categories">Categories</a><a href="/write-review">Write a review</a></nav></header>
<main>
  <h1>Find the right software for your team</h1>
  <section class="category">
    <h2>CRM platforms</h2>
    <article class="review">
      <h3>Solid pipeline management, reporting needs work</h3>
      <p>We moved a fourteen-person sales team onto this last spring and the pipeline side has been
      genuinely good: stages are configurable without an admin certification, and the deal view does
      not hide the next action behind three clicks the way our previous tool did. Reporting is where
      it thins out. Anything beyond the shipped dashboards means exporting to a spreadsheet, and the
      export drops custom fields unless you name them individually, which nobody discovers until the
      first quarter-end. Support answered within a day and confirmed it as expected behaviour.</p>
    </article>
    <article class="review">
      <h3>Good value at our size, would hesitate above fifty seats</h3>
      <p>Priced well for a team of our size and the onboarding was a fortnight rather than a quarter.
      Permissions are the thing I would look at hard before growing: they are per-role rather than
      per-record, so a regional split means duplicating roles and keeping them in step by hand. That
      is manageable at twenty users and I would not want to run it at eighty. The mobile app is a
      genuine app rather than a wrapped page, which matters more than I expected for a field team.</p>
    </article>
  </section>
  <section class="category">
    <h2>Help desk and ticketing</h2>
    <article class="review">
      <h3>Automation rules saved us a headcount</h3>
      <p>The rules engine is the reason to buy this. We route on sender domain, keyword and business
      hours, and roughly two thirds of inbound now reaches the right queue without a human triaging
      it. Writing the rules is plain enough that our support lead maintains them without involving
      engineering. The reporting on first-response time is trustworthy, which sounds like a low bar
      until you have used a tool that quietly excludes reopened tickets from the average.</p>
    </article>
    <article class="review">
      <h3>Search is the weak point</h3>
      <p>Everything about the agent view is fine and the SLA handling is better than what we
      replaced. Search across closed tickets is poor: it matches on subject far more strongly than on
      body, so finding the ticket where somebody explained a workaround eighteen months ago is mostly
      luck. We have started pasting resolutions into a separate wiki, which rather defeats the point
      of keeping the history in one place. Everything else here I would recommend without caveat.</p>
    </article>
  </section>
  <section class="category">
    <h2>Analytics and BI</h2>
    <article class="review">
      <h3>Fast once modelled, slow to model</h3>
      <p>Query performance against our warehouse is genuinely quick and the caching is intelligent
      about what to invalidate. Getting there took a full quarter of modelling work that was not in
      anybody's estimate, because the semantic layer wants every relationship declared before it will
      let an analyst self-serve. That is the right design and it is also the reason three of our
      teams gave up and went back to writing SQL by hand. Budget for the modelling, not the licence.</p>
    </article>
    <article class="review">
      <h3>Sharing and permissions are the best I have used</h3>
      <p>Row-level security is declared once in the model and then holds everywhere — dashboards,
      exports, the API, scheduled emails. We have external clients looking at the same dashboard
      seeing only their own rows, and it has not leaked once in two years of quarterly audits. The
      chart library is plainer than some competitors and I will take that trade every time.</p>
    </article>
  </section>
  <section class="category">
    <h2>Project management</h2>
    <article class="review">
      <h3>Works well until you need dependencies</h3>
      <p>Boards, assignments and comments are all clean and the whole team picked it up without a
      training session, which is worth a great deal on its own. Dependencies between tasks are where
      it stops being adequate: they exist, but they do not affect scheduling, so a slipped task leaves
      everything downstream showing its original date and somebody has to notice by eye. For a team
      running two-week iterations that is tolerable. For anything with a hard external deadline and a
      chain of handoffs I would want real critical-path handling before committing.</p>
    </article>
    <article class="review">
      <h3>The API is why we stayed</h3>
      <p>We evaluated four tools and this one won on the API rather than the interface. Everything the
      UI can do is reachable programmatically, the webhooks fire reliably and include enough of the
      changed object that we rarely have to call back for detail, and the rate limits are documented
      rather than discovered. We generate about a third of our tasks from other systems and none of
      that needed a workaround. The interface is middling and I would still choose it again.</p>
    </article>
    <article class="review">
      <h3>Notifications are overwhelming by default</h3>
      <p>Good tool, poor defaults. Out of the box every member is subscribed to every board they can
      see, which meant several hundred emails in the first week and two people quietly filtering the
      whole domain to a folder — the worst possible outcome, since they then missed the ones that
      mattered. It is all configurable per person and per board, and once we had sat down and set it
      properly the signal-to-noise has been fine. Budget an afternoon for that before rolling out.</p>
    </article>
    <article class="review">
      <h3>Reporting good, time tracking bolted on</h3>
      <p>Burndown and velocity reporting are accurate and did not need reconciling against a
      spreadsheet, which is more than I can say for the tool we left. Time tracking feels like a
      later addition: it lives in a separate panel, does not roll up to the parent task, and the
      export groups by user rather than by project, so billing month-end is still a manual step. If
      you do not bill by the hour none of that matters and the rest is strong.</p>
    </article>
  </section>
  <section class="category">
    <h2>Payroll and HR</h2>
    <article class="review">
      <h3>Compliance updates arrive before we hear about them</h3>
      <p>The reason to buy payroll software rather than run a spreadsheet is that somebody else tracks
      the legislation, and on that count this has been excellent. Rate and threshold changes have
      landed ahead of every deadline for three years, with a note explaining what moved rather than a
      silent update. Onboarding a new starter takes about ten minutes including the right-to-work
      record. The interface is dated and I genuinely do not care, because the numbers have been
      correct every month and that is the entire job.</p>
    </article>
    <article class="review">
      <h3>Reporting to finance needed a workaround</h3>
      <p>Payroll itself is fine. Getting the journal into our accounting system was not: the shipped
      export assumes one cost centre per employee, and we split several people across two, so we ended
      up writing a small script against the API to reshape it. Support were candid that this was not
      supported rather than pretending otherwise, which I appreciated more than a vague promise. Once
      the script existed it has run untouched for two years. Ask about your own split before signing.</p>
    </article>
    <article class="review">
      <h3>Self-service portal cut our admin questions</h3>
      <p>Giving staff their own access to payslips, holiday balances and the annual statement removed
      most of what used to arrive as email to one overloaded person. Holiday requests route to the
      right approver without a rule per team, and the balance shown accounts for carry-over correctly,
      which our previous system did not and which caused an argument every January. Two-factor is
      available and can be enforced, and we did enforce it, given what is behind that login.</p>
    </article>
  </section>
  <nav><a href="/categories?page=2">Next page</a><a href="/compare">Compare products</a></nav>
</main>
<script src="/packs/js/application.js" defer></script>
</body></html>
`,
    requestUrls: [
      "https://www.reviews.example/",
      "https://geo.captcha-delivery.com/interstitial/?REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx&REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxx&cid=REDACTED",
      "https://www.reviews.example/packs/js/application.js",
      "https://images.reviews.example/logos/vendor-84.png",
    ],
    status: 403,
    url: "https://www.reviews.example/",
    why: "A solved DataDome challenge under a stale 403 is withheld as passed, leaving suspect.",
  },
  fp_datadome_normal_200: {
    cookies: [
      "datadome=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Max-Age=31536000; Domain=.classifieds.example; Path=/; Secure; SameSite=Lax",
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
      "content-type": "text/html; charset=utf-8",
      server: "nginx",
      "x-cache": "Miss from cloudfront",
      "x-datadome": "protected",
    },
    html: `<!DOCTYPE html>
<html lang="fr"><head><title>Petites annonces — Example Classifieds</title></head>
<body>
<main>
  <h1>Toutes nos annonces</h1>
  <section>
    <article data-testid="listing">
      <a href="/annonces/velo-course-54cm">Vélo de course taille 54, cadre aluminium</a>
      <p>Vélo de course en très bon état, révisé en juillet, groupe Shimano 105 complet et roues
      récentes. Vendu avec deux porte-bidons et une selle de rechange. Visible en semaine après
      18h dans le centre, remise en main propre uniquement.</p>
      <span>240 EUR</span><span>Lyon 3e</span>
    </article>
    <article data-testid="listing">
      <a href="/annonces/canape-trois-places">Canapé trois places convertible</a>
      <p>Canapé convertible en tissu gris, couchage deux personnes, mécanisme testé et sans jeu.
      Quelques traces d'usage sur l'accoudoir gauche, visibles sur les photos. Dimensions 210 par 95
      centimètres, à récupérer sur place avec un véhicule adapté.</p>
      <span>150 EUR</span><span>Villeurbanne</span>
    </article>
    <article data-testid="listing">
      <a href="/annonces/REDACTEDxxxxxxxxxxxxx">Appartement T2 meublé, 44 m2</a>
      <p>Deux pièces au troisième étage avec ascenseur, cuisine équipée, double vitrage récent et
      cave privative. Charges comprenant l'eau froide et l'entretien des parties communes. Libre à
      partir du mois prochain, dossier avec garant demandé.</p>
      <span>780 EUR / mois</span><span>Lyon 7e</span>
    </article>
  </section>
  <nav><a href="/annonces?page=2">Page suivante</a><a href="/categories">Toutes les catégories</a></nav>
</main>
<script src="https://js.datadome.co/tags.js" async></script>
<script src="/_next/static/chunks/main.js" defer></script>
</body></html>
`,
    requestUrls: [
      "https://www.classifieds.example/",
      "https://js.datadome.co/tags.js",
      "https://www.classifieds.example/_next/static/chunks/main.js",
      "https://img.classifieds.example/listings/REDACTEDxxxxxxxxxxxxx",
    ],
    status: 200,
    url: "https://www.classifieds.example/",
    why: "x-datadome: protected and the client cookie ride delivered pages, so they are no signal.",
  },
  tp_datadome_block_403: {
    cookies: ["datadome=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxx; Path=/; Secure"],
    expect: {
      decoys: [],
      page: "interstitial_heavy_script",
      passedChallenges: [],
      ruleIds: [
        "datadome_captcha_delivery_request",
        "datadome_captcha_element",
        "datadome_captcha_host_dom",
        "thin_text_heavy_script",
        "waf_status",
      ],
      vendor: "datadome",
      verdict: "blocked",
    },
    headers: {
      "content-length": "776",
      "content-type": "text/html; charset=utf-8",
      server: "cloudflare",
      "x-datadome": "protected",
      "x-datadome-cid": "REDACTED",
    },
    html: `<html lang="es"><head><title>target.example</title><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="margin:0"><script data-cfasync="false">var dd={'rt':'i','cid':'REDACTED','hsh':'REDACTED','b':1234567,'s':12345,'e':'REDACTED','qp':'','host':'geo.captcha-delivery.com','cookie':'REDACTED'}</script><script data-cfasync="false" src="https://ct.captcha-delivery.com/i.js"></script><iframe src="https://geo.captcha-delivery.com/interstitial/?initialCid=REDACTED&amp;cid=REDACTED&amp;s=12345&amp;b=1234567" title="Device check" width="100%" height="100%" frameborder="0"></iframe></body></html>
`,
    requestUrls: ["https://geo.captcha-delivery.com/REDACTED"],
    status: 403,
    url: "https://target.example/page",
    why: "A captured DataDome device check decides on the captcha host in the request log and the markup.",
  },
  tp_datadome_captcha_403: {
    cookies: [
      "datadome=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxx; Max-Age=31536000; Domain=.classifieds.example; Path=/; Secure; SameSite=Lax",
    ],
    expect: {
      decoys: [],
      page: "interstitial_heavy_script",
      passedChallenges: [],
      ruleIds: [
        "datadome_captcha_delivery_request",
        "datadome_captcha_element",
        "datadome_captcha_host_dom",
        "datadome_response_header",
        "thin_text_heavy_script",
        "waf_status",
      ],
      vendor: "datadome",
      verdict: "blocked",
    },
    headers: {
      "content-type": "text/html; charset=utf-8",
      server: "nginx",
      "x-datadome": "protected",
      "x-datadome-response": "403",
    },
    html: `<!DOCTYPE html><html><head><title>classifieds.example</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<div class="captcha__human">
  <div class="captcha__human__title">Verify you are human</div>
  <iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=REDACTEDxxxx&amp;REDACTEDxxxxxxxxxxxx" width="100%" height="400"></iframe>
</div>
<script>var dd={'rt':'c','cid':'REDACTEDxxxxxxxx','hsh':'REDACTEDxxxxxxxxxxxx','t':'fe','s':12345,'e':'REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'};</script>
<script src="https://ct.captcha-delivery.com/c.js"></script>
</body></html>
`,
    requestUrls: [
      "https://www.classifieds.example/annonces/velo",
      "https://geo.captcha-delivery.com/captcha/?initialCid=REDACTED&REDACTEDxxxxxxxxxxxx&REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx&REDACTEDxxxxxxxxxxxxxxxxx&t=fe",
      "https://geo.captcha-delivery.com/captcha/static/css/captcha.css",
    ],
    status: 403,
    url: "https://www.classifieds.example/annonces/velo",
    why: "A DataDome captcha interstitial decides on its captcha request, response header and thin script.",
  },
} satisfies Record<string, BlockCase>;
