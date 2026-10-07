import type { BlockCase } from "../block-cases.ts";

export const perimeterxCases = {
  fp_perimeterx_protected_page_200: {
    cookies: [
      "ak_bmsc=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Domain=.superstore.example; Path=/; Secure; SameSite=None",
      "bm_mi=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Domain=.superstore.example; Path=/; Secure; SameSite=None",
      "akavpau_p2=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; path=/",
    ],
    expect: {
      decoys: ["perimeterx_app_id"],
      page: "over_text_limit",
      passedChallenges: [],
      ruleIds: [],
      vendor: null,
      verdict: "ok",
    },
    headers: {
      "accept-ch": "Sec-CH-DPR, DPR, Sec-CH-Device-Memory, Device-Memory, Downlink",
      "cache-control": "max-age=0, no-cache, no-store",
      "content-type": "text/html; charset=utf-8",
      vary: "Accept-Encoding",
      "x-akamai-transformed": "0 - 0 -",
    },
    html: `<!DOCTYPE html>
<html lang="en"><head><title>Example Superstore | Weekly deals</title></head>
<body>
<header><a href="/cart">Cart</a><a href="/orders">Orders</a><a href="/departments">Departments</a></header>
<main>
  <h1>Deals of the week</h1>
  <section>
    <article>
      <h2>Chest freezer, 200 litre</h2>
      <p>A two hundred litre chest freezer with a counterbalanced lid that stays up on its own,
      which matters more than the brochure suggests when both hands are full. Chest designs hold
      cold far better than uprights because the cold air does not fall out every time the lid opens,
      and this one recovers temperature within about twenty minutes of a full reload. There is a
      wire basket at the top for the things you actually reach for, and a drain plug at the front so
      defrosting does not mean bailing meltwater out with a jug.</p>
      <span>329.00 USD</span>
    </article>
    <article>
      <h2>Cordless drill driver, 18 V, two batteries</h2>
      <p>An eighteen volt drill with a two-speed gearbox, so it has both the torque for long screws
      into joists and the speed for drilling clean holes without burning the bit. Two batteries in
      the box is the part that makes it usable: one on charge and one in the tool means a whole
      afternoon's work rather than a stop every forty minutes. The chuck is keyless metal rather
      than plastic and holds round shanks without slipping, which is where the cheaper kits give
      themselves away. A belt clip and a magnetic bit holder are moulded into the housing.</p>
      <span>89.00 USD</span>
    </article>
    <article>
      <h2>Air fryer, 5.7 litre</h2>
      <p>A five and a half litre basket, which is genuinely enough for a family meal rather than the
      two portions the marketing photograph implies. It preheats in around three minutes and the
      basket comes apart for washing, including the crisping plate that most designs rivet in place
      and which is the part that actually gets dirty. The controls are a dial and a button rather
      than a touch panel, so they still work with wet hands. It runs quieter than the extractor fan
      above the hob, which is the comparison that matters in a small kitchen.</p>
      <span>74.50 USD</span>
    </article>
    <article>
      <h2>Memory foam mattress, queen, 25 cm</h2>
      <p>Twenty-five centimetres of foam in three layers, with the softest at the top and a firm
      base that stops the whole thing bottoming out under a hip. It arrives vacuum rolled and takes
      about a day to reach full height, and a further week or so before it stops smelling faintly of
      the factory, which is normal and worth knowing in advance. The cover unzips and washes. Foam
      sleeps warmer than sprung, so this one has a perforated middle layer to move air, and it does
      help, though anyone who sleeps very hot should still consider a sprung hybrid instead.</p>
      <span>399.00 USD</span>
    </article>
    <article>
      <h2>Robot vacuum with mapping</h2>
      <p>A robot vacuum that builds an actual map rather than bouncing off furniture at random, so a
      second pass covers the parts it missed instead of repeating the parts it did. Rooms can be
      named and cleaned individually, and the no-go lines held properly across a fortnight of
      testing around a pet bowl. Suction is adequate on hard floors and short carpet and is not a
      substitute for an upright on anything deeper. The bin is small, which is the honest trade for
      a machine thin enough to fit under a sofa, so expect to empty it every couple of runs.</p>
      <span>218.00 USD</span>
    </article>
    <article>
      <h2>Insulated water bottle, 750 ml</h2>
      <p>Three quarters of a litre of vacuum-insulated stainless steel with a lid that seals well
      enough to go in a bag on its side. Cold drinks stay cold for a full working day and the
      outside never sweats, so it does not leave a ring on a desk or soak the papers next to it. The
      mouth is wide enough for ice cubes and for a bottle brush, which is the practical test. The
      powder coat has survived being dropped on concrete more than once with nothing worse than a
      scuff at the base rim.</p>
      <span>26.00 USD</span>
    </article>
    <article>
      <h2>Upright bagless vacuum, pet model</h2>
      <p>An upright with a tangle-resistant brush roll, which is the one feature that separates a
      pet vacuum from an ordinary one wearing a different sticker. Hair feeds off the bar into the
      bin instead of wrapping around it, so it does not need cutting free with scissors every
      fortnight. The bin seals at the bottom and empties without putting a hand inside it. Filters
      are washable and there are two of them, which means one can dry fully while the other is in
      use rather than the machine running damp and smelling of it.</p>
      <span>148.00 USD</span>
    </article>
    <article>
      <h2>Stand mixer, 4.5 litre, tilt head</h2>
      <p>A four and a half litre bowl and a planetary action that reaches the whole of it, so a
      single batch of dough does not need scraping down three times. The head tilts rather than the
      bowl lifting, which is easier to load and slightly less stable at the highest speed with a
      full load of stiff dough. Attachments run off a standard hub, so a mincer or a pasta roller
      from another maker will fit. It weighs enough to stay put on the counter, which is a virtue in
      use and a nuisance when it needs to go back in a cupboard.</p>
      <span>229.00 USD</span>
    </article>
    <article>
      <h2>Garden hose, 30 m, reinforced</h2>
      <p>Thirty metres of three-layer hose with a braided middle, which is what stops it kinking at
      the point where it leaves the reel under pressure. It stays flexible below freezing rather
      than going stiff and cracking, and it has survived a winter left connected outdoors. The
      fittings are brass rather than plastic and thread onto a standard tap connector without tape.
      Coiling it back onto the reel is a two-handed job because the hose is heavy for its length,
      which is the direct cost of the reinforcement that makes it last.</p>
      <span>58.00 USD</span>
    </article>
  </section>
  <nav><a href="/deals?page=2">Next page</a><a href="/departments">All departments</a></nav>
</main>
<script>window._pxAppId = "PXexample01";</script>
<script src="/static/bundle/main.js" defer></script>
</body></html>
`,
    requestUrls: [
      "https://www.superstore.example/",
      "https://REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxx/api/v2/collector",
      "https://www.superstore.example/static/bundle/main.js",
      "https://REDACTEDxxxxxxxxxxxxxxxxx/images/deals/kettle.jpeg",
    ],
    status: 200,
    url: "https://www.superstore.example/",
    why: "The PerimeterX sensor on a served page that was never challenged counts for nothing.",
  },
  fp_perimeterx_sensor_homepage_200: {
    cookies: [],
    expect: {
      decoys: ["perimeterx_app_id"],
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
<html lang="en"><head><title>Superstore | Weekly deals</title>
<script>window._pxAppId='PXa1b2c3d4'</script>
<script src="/px/PXa1b2c3d4/init.js" defer></script>
</head>
<body>
<header><a href="/cart">Cart</a><a href="/orders">Orders</a><a href="/departments">Departments</a></header>
<main>
  <h1>Deals of the week</h1>
  <article>
    <h2>Chest freezer, 200 litre</h2>
    <p>A two hundred litre chest freezer with a counterbalanced lid that stays up on its own, which
    matters more than the brochure suggests when both hands are full. Chest designs hold cold better
    than uprights because the cold air does not fall out every time the lid opens, and this one
    recovers temperature within about twenty minutes of a full reload. There is a wire basket at the
    top for the things you actually reach for, and a drain plug at the front so defrosting does not
    mean bailing meltwater out with a jug.</p>
    <span>329.00 USD</span>
  </article>
  <article>
    <h2>Air fryer, 5.7 litre</h2>
    <p>A basket large enough for a family meal rather than the two portions the marketing photograph
    implies. It preheats in around three minutes and comes apart for washing, including the crisping
    plate that most designs rivet in place and which is the part that actually gets dirty.</p>
    <span>74.50 USD</span>
  </article>
  <nav><a href="/deals?page=2">Next page</a><a href="/departments">All departments</a></nav>
</main>
<script src="/static/bundle/main.js" defer></script>
</body></html>
`,
    requestUrls: [],
    status: 200,
    url: "https://target.example/page",
    why: "The PerimeterX sensor beside prose is held out by the no-prose gate alone.",
  },
  fp_perimeterx_stacked_cloudflare_200: {
    cookies: [
      "_pxhd=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Expires=Thu, 12 Aug 2027 15:00:00 GMT; Path=/",
      "site_dc=REDACTED; Path=/; Domain=homegoods.example",
      "visitor_id=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Path=/; Secure",
    ],
    expect: {
      decoys: ["perimeterx_app_id"],
      page: "over_text_limit",
      passedChallenges: [],
      ruleIds: [],
      vendor: null,
      verdict: "ok",
    },
    headers: {
      "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate",
      "cf-cache-status": "DYNAMIC",
      "cf-ray": "REDACTEDxxxxxxxxxxxx",
      "content-type": "text/html; charset=utf-8",
      server: "cloudflare",
      vary: "accept-encoding",
    },
    html: `<!DOCTYPE html>
<html lang="en"><head><title>Example Homegoods - Furniture and decor</title></head>
<body>
<header><nav><a href="/furniture">Furniture</a><a href="/decor">Decor</a><a href="/sale">Sale</a></nav></header>
<main>
  <h1>Sofas and couches</h1>
  <section>
    <article>
      <h2>Three-seat fabric sofa, deep seat</h2>
      <p>A deep-seated three seater in a woven fabric, firm enough to get out of easily and soft
      enough to sit in for an evening. The frame is kiln-dried hardwood with corner blocks rather
      than stapled softwood, which is the difference between a sofa that lasts fifteen years and one
      that starts creaking in three. Cushions are foam wrapped in fibre, so they hold shape better
      than pure feather and do not need plumping every day. The legs unscrew for delivery, which
      matters if the stairwell has a tight turn.</p>
      <span>899.00 USD</span>
    </article>
    <article>
      <h2>Two-seat leather loveseat</h2>
      <p>Top-grain leather on the seating surfaces and a matched split hide elsewhere, which is the
      usual arrangement at this price and is worth understanding rather than being surprised by. The
      grain will soften and mark with use, and that is the material behaving correctly rather than
      wearing out. The seat height is a little lower than average, which suits a room with a low
      coffee table and does not suit anyone who finds standing up from a low chair difficult.</p>
      <span>1,240.00 USD</span>
    </article>
    <article>
      <h2>Sleeper sofa with memory foam mattress</h2>
      <p>A sleeper whose mattress is memory foam rather than the traditional thin innerspring, which
      transforms it from something a guest tolerates into something they will sleep through the
      night on. The mechanism pulls out in one motion and the bar that ruins most sofa beds sits
      below the foam rather than through it. Folded, it reads as an ordinary sofa with no visible
      hinge. It is heavy, which is the trade, and moving it is genuinely a two-person job.</p>
      <span>1,090.00 USD</span>
    </article>
    <article>
      <h2>Modular sectional, four piece</h2>
      <p>Four pieces that clip together in several arrangements, so a corner unit can face left or
      right and the ottoman can sit inside the L or stand alone. The clips hold firmly enough that
      it does not drift apart in daily use, which is the failure of the cheaper modular ranges. The
      cover is removable and machine washable on a cool cycle, and there is enough spare fabric in
      the hems to survive a couple of washes without going tight over the foam.</p>
      <span>1,780.00 USD</span>
    </article>
    <article>
      <h2>Accent armchair, curved back</h2>
      <p>A curved-back armchair narrow enough to fit a room that cannot take a full second sofa,
      with a swivel base that turns smoothly and stops where it is put. The upholstery is a boucle
      that hides marks well and catches on claws, so it is the wrong chair for a house with cats and
      a good one otherwise. The cushion is a single piece of foam rather than a zipped cover, so it
      cannot be flipped, and it has kept its shape through several months of daily sitting.</p>
      <span>420.00 USD</span>
    </article>
    <article>
      <h2>Coffee table, solid oak, 120 cm</h2>
      <p>A hundred and twenty centimetres of solid oak with a lower shelf, finished in a hardwax oil
      that can be repaired in place rather than a lacquer that has to be stripped. Rings from a wet
      glass lift out with a little more oil and a cloth. The corners are eased rather than sharp,
      which is worth having at shin height. It arrives flat with four legs to bolt on, and the
      threaded inserts are metal rather than driven straight into the timber.</p>
      <span>335.00 USD</span>
    </article>
    <article>
      <h2>Dining table, extending, seats six to eight</h2>
      <p>A table that seats six closed and eight with the leaf in, where the leaf stores inside the
      table rather than in a cupboard nobody has space for. The extension runs on metal rails that
      stayed smooth through a few dozen cycles, and the two halves close flush enough that a
      tablecloth is not required to hide the join. The finish is a matt lacquer that resists water
      marks better than oil and cannot be spot-repaired the way oil can, which is the trade.</p>
      <span>740.00 USD</span>
    </article>
    <article>
      <h2>Bookcase, five shelf, adjustable</h2>
      <p>Five shelves on a pin system rather than fixed, so the bottom two can be set tall enough
      for records or folio books. The shelves are a solid engineered board rather than a hollow
      panel, and at eighty centimetres wide they carry a full run of hardbacks without the visible
      sag that afflicts most flat-pack shelving by the second year. A tip restraint is in the box
      and should be used, because the unit is deliberately shallow to suit a narrow room.</p>
      <span>265.00 USD</span>
    </article>
    <article>
      <h2>Area rug, 160 by 230 cm, hand-tufted wool</h2>
      <p>Hand-tufted wool at a medium pile, dense enough underfoot that it does not flatten into
      tracks along the route between the door and the sofa. Wool sheds for the first month or two
      and then stops, which is normal and worth expecting rather than returning it over. It takes a
      spill far better than a synthetic because the fibre is naturally water-repellent for the first
      few minutes. A separate underlay is not included and is genuinely worth buying.</p>
      <span>310.00 USD</span>
    </article>
    <article>
      <h2>Floor lamp, arched, marble base</h2>
      <p>An arched floor lamp that reaches about a metre and a half over a seating area, so it lights
      a reading spot without a table underneath it. The base is real marble rather than a filled
      resin, which is why it holds an arch that far out without creeping across the floor when the
      shade is nudged. The arch comes in three sections that thread together, and the joins line up
      without forcing. It takes a standard bulb rather than an integrated panel, so the whole thing
      is not landfill when the light eventually fails.</p>
      <span>195.00 USD</span>
    </article>
  </section>
  <nav><a href="/furniture/sofas?page=2">Next page</a><a href="/furniture">All furniture</a></nav>
</main>
<script>window._pxAppId = "PXexample02";</script>
<script src="/packs/js/application.js" defer></script>
</body></html>
`,
    requestUrls: [
      "https://www.homegoods.example/",
      "https://www.homegoods.example/packs/js/application.js",
      "https://img.homegoods.example/products/sofa-3seat.jpg",
    ],
    status: 200,
    url: "https://www.homegoods.example/",
    why: "PerimeterX and Cloudflare markers on a passing page, neither challenging, count for nothing.",
  },
  tp_perimeterx_block_403: {
    cookies: [
      "_pxhd=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxx; Expires=Wed, 11 Aug 2027 09:14:22 GMT; Path=/",
    ],
    expect: {
      decoys: [],
      page: "interstitial_no_prose",
      passedChallenges: [],
      ruleIds: [
        "challenge_title",
        "perimeterx_app_id",
        "perimeterx_captcha_element",
        "perimeterx_captcha_request",
        "perimeterx_pp_header",
        "waf_status",
      ],
      vendor: "perimeterx",
      verdict: "blocked",
    },
    headers: { "content-type": "text/html; charset=utf-8", server: "nginx", "x-px-pp": "1" },
    html: `<!DOCTYPE html><html lang="en"><head><title>Access to this page has been denied.</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<div id="px-captcha"></div>
<p>Please verify you are a human.</p>
<script>window._pxAppId = 'PXABC123'; window._pxJsClientSrc = '/PXABC123/init.js'; window._pxFirstPartyEnabled = true;</script>
<script src="https://captcha.px-cdn.net/PXABC123/captcha.js?a=c&REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"></script>
</body></html>
`,
    requestUrls: [
      "https://www.sneakers.example/launch/runner-retro",
      "https://REDACTEDxxxxxxxxxxxxxxxxxxxxxxx/api/v2/collector",
      "https://captcha.px-cdn.net/PXABC123/captcha.js?a=c&REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx&v=&m=0",
    ],
    status: 403,
    url: "https://www.sneakers.example/launch/runner-retro",
    why: "PerimeterX enforcement decides on its captcha host and header, with the sensor adding to it.",
  },
  tp_perimeterx_block_without_enforcement_headers_429: {
    cookies: [
      "_pxhd=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Path=/",
    ],
    expect: {
      decoys: [],
      page: "interstitial_no_prose",
      passedChallenges: [],
      ruleIds: ["challenge_title", "perimeterx_captcha_element", "waf_status"],
      vendor: "perimeterx",
      verdict: "blocked",
    },
    headers: { "content-type": "text/html; charset=utf-8" },
    html: `<!DOCTYPE html>
<html lang="en"><head><title>Access to this page has been denied</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
<div id="px-captcha-wrapper">
  <div class="px-captcha-container">
    <div id="px-captcha" class="px-captcha-block" data-px-captcha="1"></div>
    <div class="px-captcha-message px-captcha-error px-captcha-hidden"></div>
    <div class="px-captcha-retry px-captcha-button px-captcha-footer"></div>
    <div class="px-captcha-header px-captcha-title px-captcha-subtitle"></div>
    <div class="px-captcha-spinner px-captcha-loading px-captcha-frame"></div>
    <div class="px-captcha-ref px-captcha-vid px-captcha-uuid px-captcha-blockscript"></div>
    <div class="px-captcha-a px-captcha-b px-captcha-c px-captcha-d px-captcha-e"></div>
    <div class="px-captcha-f px-captcha-g px-captcha-h px-captcha-i px-captcha-j"></div>
    <div class="px-captcha-k px-captcha-l px-captcha-m px-captcha-n px-captcha-o"></div>
  </div>
</div>
<p>Please verify you are a human.</p>
<p>Reference ID: REDACTEDxxxxxxx</p>
<script>window._pxVid = "REDACTEDxxxx"; window._pxUuid = "REDACTEDxxxxxxxxxxxxxxx";</script>
<script src="/px-captcha/blockscript.js"></script>
</body></html>
`,
    requestUrls: ["https://www.homegoods.example/search?q=desk%20lamp"],
    status: 429,
    url: "https://www.homegoods.example/search?q=desk%20lamp",
    why: "A PerimeterX block with no enforcement header is promoted by weak signals from three families.",
  },
} satisfies Record<string, BlockCase>;
