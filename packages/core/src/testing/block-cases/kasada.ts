import type { BlockCase } from "../block-cases.ts";

export const kasadaCases = {
  fp_kasada_listings_challenge_passed_429: {
    cookies: [],
    expect: {
      decoys: [],
      page: "over_text_limit",
      passedChallenges: ["kasada_kpsdk_header"],
      ruleIds: ["kasada_kpsdk_header", "waf_status"],
      vendor: null,
      verdict: "suspect",
    },
    headers: {
      "content-length": "19605",
      "content-type": "text/html; charset=utf-8",
      server: "cloudflare",
      "x-kpsdk-ct": "REDACTED",
      "x-kpsdk-r": "REDACTED",
    },
    html: `<!DOCTYPE html>
<html lang="en"><head><title>Homes for Sale, Apartments &amp; Houses for Rent</title></head>
<body>
<header>
  <a href="/search?city=riverton">Homes for sale</a>
  <a href="/rent?city=riverton">Apartments for rent</a>
  <a href="/rates">Mortgage rates</a>
  <a href="/account">Sign in</a>
</header>
<main>
  <h1>Homes for sale in Riverton</h1>
  <p>Four hundred and eleven listings updated in the last twenty-four hours. Sorted by newest first.
  Median list price in this search is up about two per cent on the same week last year, and the
  median time on market is nineteen days, which is four days shorter than the metro average. Prices
  below are asking prices and do not include the buyer agent commission arrangements that changed
  across the state in the spring; ask your agent how that is being handled on any listing you tour.</p>

  <article>
    <h2>18 Example Terrace, Northside</h2>
    <p>A three bedroom, two bath Victorian on a quarter acre, set back far enough from the road that
    the front rooms stay quiet with the windows open. The kitchen was taken back to the studs six
    years ago and the mechanicals went with it, so the boiler, the panel and the supply lines are all
    the same age as the cabinets rather than the same age as the house. Original plaster survives in
    the two front rooms and has been repaired rather than replaced, which is visible if you look at
    the ceiling line and invisible from anywhere else. The third bedroom is small enough that it is
    honestly an office, and the listing photographs show it as one. There is off-street parking for
    two cars in tandem, which in this neighbourhood is worth roughly what a garage is worth
    elsewhere. The basement is dry but low, at six foot two under the beams, so it is storage and a
    laundry rather than a room anybody will finish.</p>
    <span>$789,000 &middot; 3 bd &middot; 2 ba &middot; 1,840 sqft</span>
  </article>

  <article>
    <h2>402 Example Road, Unit 6, Harbourside</h2>
    <p>A two bedroom corner unit on the fourth floor of a six storey building put up in 2019, with
    windows on two sides and a balcony deep enough to hold a table rather than only a chair. The
    building has an elevator, a package room and a small gym that is genuinely used, and the
    association fee covers heat, which is unusual enough here to be worth reading twice. Assessments
    have been flat for three years and the reserve study is attached to the disclosure packet. Deeded
    garage parking transfers with the unit. Noise from the road is present with the balcony door
    open and gone with it closed.</p>
    <span>$742,500 &middot; 2 bd &middot; 2 ba &middot; 1,105 sqft</span>
  </article>

  <article>
    <h2>77 Example Street, Westfield</h2>
    <p>A two family with the owner's unit up and a rented unit down, which is the arrangement most
    buyers in this price band are looking for and the reason properties like this rarely sit. The
    lower tenancy is at will and under market by roughly four hundred a month, so a buyer intending
    to keep it should budget for either a rent increase conversation or a vacancy. Separate utilities
    throughout, including two boilers and two meters, and the roof was stripped and re-shingled in
    2021 with the permit on file. The yard is fully fenced and flat, with a shed that is staying. The
    driveway holds three cars, one behind the other. What the photographs do not show is that the
    front stair is steep and turns twice, which matters for anybody moving furniture or planning to
    age in the building.</p>
    <span>$965,000 &middot; 5 bd &middot; 3 ba &middot; 2,610 sqft</span>
  </article>

  <article>
    <h2>9 Example Avenue, Eastgate</h2>
    <p>A one bedroom in a small association of nine units, converted from a single family in the
    nineteen eighties and renovated unit by unit since. This one was done last year: new bath, new
    kitchen, refinished floors, and the windows replaced with double glazing that has made a
    measurable difference to the heating bill according to the seller's statements, which are in the
    packet. There is a shared basement with a deeded storage cage and a coin laundry that the
    association is in the process of replacing with card machines. No parking, which is the reason
    for the price, though the street is permit-only and permits are currently issued without a
    waiting list. A ten minute walk to the tram.</p>
    <span>$429,000 &middot; 1 bd &middot; 1 ba &middot; 640 sqft</span>
  </article>

  <article>
    <h2>250 Example Lane, Southfield</h2>
    <p>A single family on a corner lot with a wraparound porch that has been rebuilt from the joists
    up, so it is sound rather than merely charming. Inside, the layout is original and closed off in
    the way houses of this age are: a front parlour, a back parlour and a kitchen at the rear, with
    the dining room where a modern build would put an island. Opening it up is possible and the
    listing agent has an engineer's letter on the load-bearing wall for anybody who asks. Heating is
    forced hot water on one zone, which is the main deferred item. The lot is large for the street at
    just over five thousand square feet and has a mature pear tree that produces more than one
    household can use.</p>
    <span>$685,000 &middot; 4 bd &middot; 2 ba &middot; 2,020 sqft</span>
  </article>

  <h2>What buyers in this search also looked at</h2>
  <p>Searches like this one usually widen in one of two directions. The first is outward, to
  the three neighbouring towns, where the same money buys roughly three hundred more square feet
  and adds fifteen minutes to a commute. The second is downward in property type, from single
  family to condominium, which trades the yard and the parking for a fee that covers the roof and
  the exterior. Both are worth pricing before touring, because the mortgage arithmetic differs more
  than the sticker prices suggest once association fees and taxes are included.</p>

  <h2>About this neighbourhood</h2>
  <p>Northside runs from the park to the reservoir and changes character over about four
  streets, which is why two listings a short walk apart can price a hundred thousand dollars apart
  without either being wrong. The southern end is quieter, mostly two and three family houses on
  deep lots, and the northern end near the station is denser and has most of the restaurants.
  School assignment in this city is by lottery rather than by street, so a listing's proximity to a
  particular school building says less than buyers moving from the suburbs expect it to. Street
  parking is permit-only above the reservoir and unrestricted below it.</p>

  <h2>Mortgage rates this week</h2>
  <p>The average thirty year fixed quoted through this site's lender panel moved down four basis
  points week over week. Rates shown are national averages for a borrower with a seven hundred and
  sixty credit score putting twenty per cent down on a conforming loan, and a quote for any specific
  property will differ. Points, lender credits and escrow arrangements move the effective rate more
  than the headline number does, so compare loan estimates rather than advertised rates.</p>

  <nav>
    <a href="/search?city=riverton&amp;page=2">Next page</a>
    <a href="/search?city=millbrook">Millbrook</a>
    <a href="/search?city=lakeside">Lakeside</a>
  </nav>
</main>
<script>
var t = {fetchStart: 0, fetchEnd: 0, scriptStart: 0, scriptEnd: 0, asset: undefined};
t.scriptStart = performance.now();
</script>
<script src="/static/bundle/main.js" defer></script>
</body></html>
`,
    requestUrls: [],
    status: 429,
    url: "https://target.example/page",
    why: "Kasada headers on a served 429 are withheld as passed, leaving the status as the only signal.",
  },
  tp_kasada_403: {
    cookies: ["KP_UIDz=REDACTEDxxxxxxxxxxxxxxxxxxxxxxx; Path=/; Secure"],
    expect: {
      decoys: [],
      page: "interstitial_no_prose",
      passedChallenges: [],
      ruleIds: ["challenge_title", "kasada_kpsdk_header", "kasada_script_start", "waf_status"],
      vendor: "kasada",
      verdict: "blocked",
    },
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-kpsdk-ct": "REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "x-kpsdk-r": "1786518862",
    },
    html: `<!DOCTYPE html><html><head><title>Pardon Our Interruption</title></head>
<body>
<p>As you were browsing something about your browser made us think you were a bot.</p>
<script>KPSDK.scriptStart = Date.now(); KPSDK.configure([{"type":"showChallenge"}]);</script>
<script src="/REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxx/REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxx/p.js"></script>
</body></html>
`,
    requestUrls: [
      "https://www.marketplace.example/listing/998877",
      "https://www.marketplace.example/REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxx/REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxx/p.js",
      "https://www.marketplace.example/REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxx/REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxx/fp",
    ],
    status: 403,
    url: "https://www.marketplace.example/listing/998877",
    why: "Kasada's header prefix and bootstrap decide on a page with almost no prose.",
  },
  tp_kasada_block_429: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_heavy_script",
      passedChallenges: [],
      ruleIds: ["kasada_kpsdk_header", "thin_text_heavy_script", "waf_status"],
      vendor: "kasada",
      verdict: "blocked",
    },
    headers: {
      "content-length": "675",
      "content-type": "text/html; charset=utf-8",
      "x-kpsdk-ct": "REDACTED",
      "x-kpsdk-r": "REDACTED",
    },
    html: `<!DOCTYPE html><html><head></head><body><script>window.KPSDK={};KPSDK.now=typeof performance!=='undefined'&&performance.now?performance.now.bind(performance):Date.now.bind(Date);KPSDK.start=KPSDK.now();</script><script src="/REDACTED/REDACTED/ips.js?KP_UIDz=REDACTED&amp;x-kpsdk-im=REDACTED"></script><iframe src="javascript:;" style="display: none;"></iframe></body></html>
`,
    requestUrls: [],
    status: 429,
    url: "https://target.example/page",
    why: "A captured Kasada block with no text decides on its response headers.",
  },
} satisfies Record<string, BlockCase>;
