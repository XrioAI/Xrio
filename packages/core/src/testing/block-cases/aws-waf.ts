import type { BlockCase } from "../block-cases.ts";

export const awsWafCases = {
  fp_aws_waf_challenge_passed_202: {
    cookies: [],
    expect: {
      decoys: [],
      page: "over_text_limit",
      passedChallenges: ["aws_waf_action", "aws_waf_challenge_request"],
      ruleIds: ["aws_waf_action", "aws_waf_challenge_request", "waf_status"],
      vendor: null,
      verdict: "suspect",
    },
    headers: {
      "access-control-expose-headers": "x-amzn-waf-action",
      "cache-control": "no-store, max-age=0",
      "content-length": "2007",
      "content-type": "text/html; charset=UTF-8",
      server: "CloudFront",
      via: "1.1 REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (CloudFront)",
      "x-amzn-waf-action": "challenge",
      "x-cache": "Error from cloudfront",
    },
    html: `<!DOCTYPE html>
<html lang="en"><head><title>Example Retailer. Weekly deals.</title></head>
<body>
<header><a id="cart" href="/cart">Cart</a><a href="/orders">Orders</a></header>
<main>
  <h1>Today's deals</h1>
  <section>
    <article class="product">
      <h2>Stainless electric kettle, 1 litre</h2>
      <p>A one-litre kettle with a concealed element and a hinged lid that clears the tap. Boils a
      single mug in just under a minute and the whole litre in a little over three. The base is
      cordless and rotates a full turn, so it suits a left- or right-handed worktop without
      rearranging the counter. The water gauge is marked on both sides in cups and in millilitres,
      and the spout pours without dribbling down the body, which is the failure most cheap kettles
      share. Descaling is a matter of a filter that lifts out from behind the spout.</p>
      <button class="add-to-cart" data-sku="EK-1L">Add to cart</button>
      <span>19.99 USD</span>
    </article>
    <article class="product">
      <h2>Cast iron skillet, 26 cm, pre-seasoned</h2>
      <p>A twenty-six centimetre pan cast in one piece, so the handle cannot work loose the way a
      riveted one eventually does. It arrives pre-seasoned and is usable straight out of the box,
      though the surface improves over the first several cooks. Weight is a little under two
      kilograms, which is what gives it the heat retention that makes it worth owning: it holds
      temperature when cold food goes in instead of dropping away like thin aluminium. Oven safe
      throughout, and the pour lips on both sides mean fat comes out without a spatula.</p>
      <button class="add-to-cart" data-sku="CI-26">Add to cart</button>
      <span>34.50 USD</span>
    </article>
    <article class="product">
      <h2>Merino base layer, long sleeve</h2>
      <p>A long-sleeved base layer in a fine merino knit, warm for its weight and slow to hold
      odour, which is the practical reason people pay more for wool than for a synthetic. Flatlock
      seams sit away from the shoulder so a pack strap does not chafe over a long day. It can be
      worn several days between washes and dries overnight indoors. Sizing runs close to the body by
      design, because a base layer that hangs loose traps no air and does very little.</p>
      <button class="add-to-cart" data-sku="ML-BL">Add to cart</button>
      <span>62.00 USD</span>
    </article>
    <article class="product">
      <h2>Desk lamp with adjustable colour temperature</h2>
      <p>A weighted-base lamp with a hinge at the base and another two thirds of the way along the
      arm, so the head reaches across a wide desk without the whole thing walking forward. Colour
      temperature runs from a warm evening white to a cool daylight, and brightness is separate from
      it rather than tied to the same dial, which is the arrangement most lamps at this price get
      wrong. Draws under twelve watts at full output and stays cool enough to reposition mid-task.</p>
      <button class="add-to-cart" data-sku="DL-CT">Add to cart</button>
      <span>41.00 USD</span>
    </article>
    <article class="product">
      <h2>Chef's knife, 20 cm, forged</h2>
      <p>A twenty centimetre forged blade with a full tang and a bolster that gives the pinch grip
      something to sit against. Ground thin behind the edge, which is the measurement that decides
      how a knife feels in use and the one no manufacturer prints. Holds a working edge for a couple
      of months of daily cooking and comes back with a few passes on a rod. The spine is rounded so
      a guiding finger on top does not go numb partway through a box of onions.</p>
      <button class="add-to-cart" data-sku="CK-20">Add to cart</button>
      <span>78.00 USD</span>
    </article>
    <article class="product">
      <h2>Storage boxes, 12 litre, set of four</h2>
      <p>Four twelve-litre boxes with lids that clip on all four sides, sized so three sit across a
      standard shelf without overhanging the edge. The walls are straight rather than tapered, which
      loses a little nesting convenience and gains real usable volume, and the clear body means the
      contents are identifiable without a label. Stack four high loaded and the bottom lid does not
      bow. Sold as a set because a single box is rarely what anybody actually needs.</p>
      <button class="add-to-cart" data-sku="SB-12">Add to cart</button>
      <span>27.00 USD</span>
    </article>
    <article class="product">
      <h2>Wool duvet, four seasons, double</h2>
      <p>Two wool duvets that clip together, one light and one medium, so the same purchase covers a
      warm summer and a cold January without a second set going into storage. Wool moves moisture
      rather than trapping it, which is the practical difference from a synthetic filling and the
      reason it sleeps cooler at the same warmth rating. The cotton casing is dense enough that the
      filling does not migrate to the corners over a season, and the clips are at the sides rather
      than the top so the two layers do not slide apart overnight.</p>
      <button class="add-to-cart" data-sku="WD-4S">Add to cart</button>
      <span>149.00 USD</span>
    </article>
    <article class="product">
      <h2>Bicycle floor pump with gauge</h2>
      <p>A steel-barrel floor pump that reaches a hundred and sixty PSI without the base lifting off
      the floor, which is the failure that makes cheap pumps infuriating rather than merely slow. The
      gauge sits at the top where it can be read while pumping instead of down at ankle height, and it
      is accurate to within a couple of PSI against a digital reference. The head takes both valve
      types by flipping an internal insert rather than swapping a part that gets lost in a drawer.</p>
      <button class="add-to-cart" data-sku="BP-160">Add to cart</button>
      <span>52.00 USD</span>
    </article>
    <article class="product">
      <h2>Noise-isolating earphones, wired</h2>
      <p>Wired earphones with a shaped tip that seals the canal mechanically rather than cancelling
      noise electronically, which costs nothing in battery and holds up better on a train than most
      active systems at three times the price. The cable is fabric-sleeved above the splitter and
      rubber below it, so it neither tangles in a bag nor transmits every brush against a collar. The
      inline control has three buttons rather than one, so volume does not require reaching for a
      phone. Sound is even across the range and deliberately not bass-heavy.</p>
      <button class="add-to-cart" data-sku="NI-W1">Add to cart</button>
      <span>29.00 USD</span>
    </article>
    <article class="product">
      <h2>Folding step stool, aluminium</h2>
      <p>An aluminium stool that folds to under six centimetres and holds a hundred and fifty
      kilograms, so it stores behind a door and is still worth standing on. The treads are ribbed
      across the direction of travel and wide enough for a whole foot, which the very compact designs
      give up on. It opens with one hand and locks positively rather than relying on friction, and the
      feet are rubber rather than plastic so it does not creep on a tiled floor while in use.</p>
      <button class="add-to-cart" data-sku="FS-AL">Add to cart</button>
      <span>36.00 USD</span>
    </article>
    <article class="product">
      <h2>Insulated food flask, 500 ml</h2>
      <p>A half-litre flask with a wide enough mouth to eat from directly and to clean without a
      bottle brush, which rules out most vacuum bottles sold for the same purpose. Stew put in
      boiling at seven in the morning is still too hot to eat at one, and that is the whole
      specification; the published hour ratings are measured in still air and are optimistic. The
      lid seals with a gasket that comes out for washing rather than being moulded in, so it does
      not start smelling of last month's lunch after a season of daily use.</p>
      <button class="add-to-cart" data-sku="IF-500">Add to cart</button>
      <span>31.00 USD</span>
    </article>
    <article class="product">
      <h2>Extension lead, six socket, surge protected</h2>
      <p>Six sockets spaced far enough apart that a row of plug-top adapters actually fits, which the
      cheaper strips get wrong and nobody checks until the parcel is open. Two metres of cable in a
      three-core with a moulded plug, individually switched so a desk can be shut down without
      reaching behind furniture. The surge component is rated in joules on the label rather than
      described as protection, and there is an indicator that reports when it has been spent —
      otherwise it stops working silently and you would never know.</p>
      <button class="add-to-cart" data-sku="EL-6S">Add to cart</button>
      <span>22.50 USD</span>
    </article>
    <article class="product">
      <h2>Cotton bath towels, set of two</h2>
      <p>Two long-staple cotton towels at a mid weight, chosen because the very heavy ones look
      luxurious in a shop and then take two days to dry in a small bathroom in winter. They come out
      of the first wash slightly larger as the terry relaxes, and they stop shedding lint after the
      second. Edges are double-turned and stitched rather than overlocked, which is the part that
      decides whether a towel survives four years of a washing machine or starts unravelling in one.</p>
      <button class="add-to-cart" data-sku="BT-2S">Add to cart</button>
      <span>44.00 USD</span>
    </article>
  </section>
  <nav><a href="/deals?page=2">Next page</a><a href="/departments">All departments</a></nav>
</main>
<script src="/assets/nav-bundle.js" defer></script>
</body></html>
`,
    requestUrls: [
      "https://www.retailer.example/",
      "https://token.awswaf.com/REDACTED/challenge.js",
      "https://www.retailer.example/assets/nav-bundle.js",
      "https://img.retailer.example/deals/kettle-1l.jpg",
    ],
    status: 202,
    url: "https://www.retailer.example/",
    why: "A second solved AWS WAF challenge, with a longer request log, is withheld the same way and leaves the bare 202.",
  },
  fp_aws_waf_listings_challenge_missed_401: {
    cookies: [],
    expect: {
      decoys: [],
      page: "over_text_limit",
      passedChallenges: [],
      ruleIds: [],
      vendor: null,
      verdict: "ok",
    },
    headers: { "content-length": "4006", "content-type": "text/html", server: "CloudFront" },
    html: `<!DOCTYPE html>
<html lang="de"><head><title>Immobilienportal &ndash; Wohnungen und H&auml;user</title></head>
<body>
<header>
  <a href="/">Startseite</a><a href="/wohnung-mieten">Wohnung mieten</a>
  <a href="/haus-kaufen">Haus kaufen</a><a href="/merkliste">Merkliste</a>
  <img src="https://static.portal.example/legacy/imperva/logo.svg" alt="Logo">
</header>
<main>
  <h1>Immobilien finden</h1>
  <section>
    <article class="ergebnis">
      <h2>3-Zimmer-Wohnung mit Balkon, Altbau, zentrale Lage</h2>
      <p>Die Wohnung liegt im zweiten Obergeschoss eines gepflegten Altbaus aus den zwanziger Jahren
      und ist ueber ein gerades Treppenhaus ohne Aufzug erreichbar. Alle drei Zimmer sind einzeln
      begehbar, was bei einem Grundriss dieses Alters nicht selbstverstaendlich ist und den Schnitt
      auch fuer eine Wohngemeinschaft brauchbar macht. Die Deckenhoehe betraegt knapp drei Meter,
      die Fluegelfenster wurden vor vier Jahren gegen zweifach verglaste Kastenfenster getauscht,
      und die urspruenglichen Dielen liegen unter dem Parkett noch vollstaendig vor. Geheizt wird
      ueber eine Gaszentralheizung im Keller, deren Kessel im vergangenen Jahr erneuert wurde. Der
      Balkon zeigt nach Suedwesten in einen begruenten Innenhof und ist damit ab dem spaeten
      Nachmittag besonnt, ohne dass die Wohnung sich im Hochsommer aufheizt.</p>
      <span class="preis">1.240 EUR Kaltmiete</span><span>82 m&sup2;</span>
    </article>
    <article class="ergebnis">
      <h2>Reihenmittelhaus mit kleinem Garten, Baujahr 1998</h2>
      <p>Ein Reihenmittelhaus auf drei Ebenen, das seit dem Bau nur einmal den Eigentuemer gewechselt
      hat und entsprechend durchgaengig gepflegt wurde. Im Erdgeschoss liegen Kueche, Gaeste-WC und
      ein durchgehender Wohnbereich mit Zugang zur Terrasse, im Obergeschoss drei Schlafzimmer und
      das Bad, unter dem Dach ein ausgebauter Raum mit Dachflaechenfenstern, der als Arbeitszimmer
      genutzt wird. Die Daemmung entspricht dem Standard des Baujahrs und wurde 2016 an der oberen
      Geschossdecke nachgebessert, was sich im Verbrauchsausweis deutlich ablesen laesst. Der Garten
      ist knapp zweihundert Quadratmeter gross, nach Osten ausgerichtet und durch eine gewachsene
      Hecke zu beiden Seiten abgeschirmt. Ein Stellplatz gehoert zum Haus, ein zweiter kann
      angemietet werden.</p>
      <span class="preis">449.000 EUR Kaufpreis</span><span>136 m&sup2;</span>
    </article>
    <article class="ergebnis">
      <h2>Dachgeschosswohnung, saniert, mit Einbaukueche</h2>
      <p>Der Ausbau des Dachgeschosses wurde 2021 abgeschlossen und ist bauamtlich abgenommen, was
      bei Wohnungen dieser Art die entscheidende Frage ist und hier belegt werden kann. Die
      Schraegen beginnen erst auf zwei Metern Hoehe, sodass die nutzbare Flaeche nahe an der
      angegebenen Wohnflaeche liegt und nicht rechnerisch geschoent ist. Fussbodenheizung in allen
      Raeumen, eine Wohnraumlueftung mit Waermerueckgewinnung und dreifach verglaste Fenster halten
      die Nebenkosten niedrig. Die Einbaukueche stammt aus dem Jahr des Umbaus und verbleibt
      ablosefrei in der Wohnung. Ein Kellerabteil und ein Fahrradraum im Erdgeschoss gehoeren dazu.
      Die Strasse ist eine Anliegerstrasse ohne Durchgangsverkehr, die naechste Haltestelle liegt
      etwa vierhundert Meter entfernt.</p>
      <span class="preis">1.080 EUR Kaltmiete</span><span>67 m&sup2;</span>
    </article>
    <article class="ergebnis">
      <h2>Doppelhaushaelfte mit Werkstatt, ruhige Randlage</h2>
      <p>Das Haus steht am Ortsrand, die Grundstuecksgrenze schliesst nach hinten an Feldflur an, und
      an dieser Seite ist eine Bebauung planungsrechtlich ausgeschlossen. An die Haushaelfte
      angebaut ist eine gemauerte Werkstatt von etwa dreissig Quadratmetern mit eigenem Zugang,
      Starkstromanschluss und einem Tor, durch das ein Fahrzeug passt. Die Heizung ist eine
      Luft-Wasser-Waermepumpe aus dem Jahr 2019, ergaenzt durch einen Kaminofen im Wohnzimmer, der
      an einen eigenen Zug angeschlossen ist. Das Dach wurde bei der Uebernahme neu eingedeckt und
      traegt seither eine Photovoltaikanlage mit knapp neun Kilowatt Spitzenleistung und einem
      Speicher im Hauswirtschaftsraum. Der Zuschnitt der Zimmer ist konventionell und ohne
      Durchgangsraeume.</p>
      <span class="preis">385.000 EUR Kaufpreis</span><span>121 m&sup2;</span>
    </article>
    <article class="ergebnis">
      <h2>2-Zimmer-Wohnung im Neubau, bezugsfertig</h2>
      <p>Eine Wohnung im zweiten von vier Obergeschossen eines Neubaus, der im Fruehjahr fertig
      gestellt wurde und in dem die Haelfte der Einheiten bereits bewohnt ist. Beide Zimmer sind
      nach Sueden orientiert, die Kueche ist offen zum Wohnraum geplant und bereits mit Anschluessen
      fuer Geschirrspueler und Waschmaschine versehen, sodass kein separater Hauswirtschaftsraum
      noetig ist. Das Bad hat ein Fenster, was in Neubauten dieser Preisklasse selten geworden ist,
      und eine bodengleiche Dusche. Aufzug bis in die Tiefgarage, in der ein Stellplatz mit
      Vorruestung fuer eine Wallbox zugeordnet ist. Der Innenhof ist begruent und
      verkehrsberuhigt, die Anbindung an den Nahverkehr liegt bei knapp zehn Minuten zu Fuss.</p>
      <span class="preis">960 EUR Kaltmiete</span><span>54 m&sup2;</span>
    </article>
    <article class="ergebnis">
      <h2>Buerofläche im Erdgeschoss, teilbar, mit Schaufenster</h2>
      <p>Eine Flaeche im Erdgeschoss eines gemischt genutzten Gebaeudes, die derzeit als Bueroraum
      genutzt wird und ueber zwei Schaufensterachsen zur Strasse verfuegt. Der Grundriss laesst eine
      Teilung in zwei Einheiten von jeweils etwa der halben Flaeche zu, die Vorbereitung dafuer ist
      im Estrich bereits angelegt. Zwei WC-Anlagen und eine Teekueche sind vorhanden, die Elektrik
      wurde bei der letzten Nutzungsaenderung vollstaendig erneuert und abgenommen. Die Decke ist
      abgehaengt und laesst sich fuer eine Verkabelung oeffnen, ohne dass Schlitze gestemmt werden
      muessen. Stellplaetze koennen im Hof angemietet werden, die Anlieferung ist ueber eine
      Zufahrt an der Rueckseite moeglich.</p>
      <span class="preis">14,50 EUR pro m&sup2;</span><span>178 m&sup2;</span>
    </article>
    <article class="ergebnis">
      <h2>Grundstueck, erschlossen, Bebauungsplan liegt vor</h2>
      <p>Ein voll erschlossenes Grundstueck in zweiter Reihe, fuer das ein rechtskraeftiger
      Bebauungsplan vorliegt und eine Bauvoranfrage fuer ein Einfamilienhaus mit Einliegerwohnung
      bereits positiv beschieden wurde. Wasser, Abwasser, Strom und Glasfaser liegen an der
      Grundstuecksgrenze an, die Anschlusskosten sind entrichtet und die Bescheide liegen bei den
      Unterlagen. Der Zuschnitt ist nahezu rechteckig mit knapp achtzehn Metern Breite zur Zufahrt,
      das Gelaende faellt ueber die Laenge um etwa einen Meter nach hinten ab. Ein Baugrundgutachten
      aus dem Vorjahr weist tragfaehigen Boden ab achtzig Zentimetern aus und schliesst
      Schichtenwasser im Kellerbereich nicht aus, was in der Kalkulation beruecksichtigt werden
      sollte. Altlasten sind nicht verzeichnet, das Grundbuch ist unbelastet.</p>
      <span class="preis">198.000 EUR Kaufpreis</span><span>612 m&sup2;</span>
    </article>
  </section>
  <nav><a href="/suche?seite=2">Naechste Seite</a><a href="/ratgeber">Ratgeber</a></nav>
</main>
<script src="https://REDACTED.edge.sdk.awswaf.com/REDACTED/REDACTED/challenge.js" defer></script>
<script src="/assets/suche-bundle.js" defer></script>
</body></html>
`,
    requestUrls: ["https://REDACTED.edge.sdk.awswaf.com/REDACTED/REDACTED/challenge.js"],
    status: 401,
    url: "https://target.example/page",
    why: "A bundle from the edge SDK host matches no AWS WAF rule and 401 is no WAF status, so nothing fires.",
  },
  fp_aws_waf_retail_challenge_passed_202: {
    cookies: [],
    expect: {
      decoys: [],
      page: "over_text_limit",
      passedChallenges: ["aws_waf_action", "aws_waf_challenge_request"],
      ruleIds: ["aws_waf_action", "aws_waf_challenge_request", "waf_status"],
      vendor: null,
      verdict: "suspect",
    },
    headers: {
      "content-length": "2007",
      "content-type": "text/html; charset=utf-8",
      server: "CloudFront",
      "x-amzn-waf-action": "challenge",
    },
    html: `<!DOCTYPE html>
<html lang="en"><head><title>Example Retailer. Weekly deals.</title></head>
<body>
<header>
  <a id="cart" href="/cart">Cart</a>
  <a class="cart-count" href="/cart">3</a>
  <a href="/orders">Order history</a>
  <a href="/account">Account</a>
</header>
<main>
  <h1>Today's deals</h1>
  <section>
    <article class="product">
      <h2>Upright vacuum with a washable filter</h2>
      <p>An upright with a bin rather than a bag, which removes the running cost that makes cheap
      vacuums expensive over five years, and a filter stack that comes out in one piece and goes
      under a tap. The head is driven rather than passive, so it pulls itself forward on carpet
      instead of being shoved, and the brush bar can be switched off for a hard floor where a
      spinning bar mostly flings grit at the skirting. Cable is nine metres, which covers a room and
      the hall it opens onto without hunting for another socket halfway through. The stated suction
      figure is measured at the hose rather than at the motor, which is the number that describes
      what the machine does and the one most manufacturers decline to print.</p>
      <button class="add-to-cart" data-sku="UV-9M">Add to cart</button>
      <span>119.00 USD</span>
    </article>
    <article class="product">
      <h2>Ceramic frying pan, 28 cm, induction base</h2>
      <p>A twenty-eight centimetre pan with a ceramic surface over a forged aluminium body and a
      steel disc bonded into the base so it works on induction. Ceramic gives up some of the working
      life of a good non-stick in exchange for tolerating a hotter pan, which is the trade worth
      making if you sear rather than simmer. The handle is riveted through rather than spot-welded,
      and it stays cool because it is hollow along its length instead of solid. It is oven safe to
      two hundred degrees with the handle on, which is enough to finish a chicken thigh but not
      enough to run it under a grill, and the instructions say so rather than leaving it vague.</p>
      <button class="add-to-cart" data-sku="CF-28">Add to cart</button>
      <span>38.00 USD</span>
    </article>
    <article class="product">
      <h2>Rechargeable head torch, 400 lumen</h2>
      <p>A head torch that runs four hours at its useful setting rather than the ninety seconds it
      can hold the headline figure for, and which steps down gradually as the cell drains instead of
      cutting out. The beam has a spot in the middle and a wide flood around it from a second
      emitter, so it works both for a path and for the inside of an engine bay. It charges over the
      same connector as a phone, and the port has a proper gasket rather than a rubber plug that
      falls off in the first month. The strap is elastic with a silicone line on the inside, which is
      what stops it creeping up a forehead over a long evening.</p>
      <button class="add-to-cart" data-sku="HT-400">Add to cart</button>
      <span>34.00 USD</span>
    </article>
    <article class="product">
      <h2>Cotton percale sheet set, king</h2>
      <p>A percale weave rather than a sateen, so it feels cool and slightly crisp instead of smooth
      and warm, which is the difference people are actually describing when they argue about thread
      count. The fitted sheet has a deep enough skirt for a mattress with a topper on it, and the
      elastic runs the whole way round rather than just at the corners, which is the part that
      decides whether it stays put through a week. It softens over roughly ten washes and then stops
      changing. Long-staple cotton, so it pills far less than the short-staple sheets that undercut
      it by a third and last a season.</p>
      <button class="add-to-cart" data-sku="PS-K">Add to cart</button>
      <span>68.00 USD</span>
    </article>
    <article class="product">
      <h2>Digital kitchen scale, 5 kg, 1 g resolution</h2>
      <p>A flat scale that reads to a gram up to five kilograms and holds calibration for longer than
      the year most of them manage, because the load cell sits on a rigid plate rather than on the
      plastic housing. Tare works while a bowl is on it and does not time out mid-recipe, which is
      the single most irritating failure in this category. The display is offset from the platform so
      a wide bowl does not hide it, and it reads in grams, ounces and millilitres without cycling
      through settings nobody uses. It takes two ordinary cells rather than a coin cell soldered to a
      board.</p>
      <button class="add-to-cart" data-sku="KS-5K">Add to cart</button>
      <span>21.00 USD</span>
    </article>
    <article class="product">
      <h2>Mesh task chair with adjustable lumbar</h2>
      <p>A mesh back with a lumbar pad that moves up and down as well as in and out, which matters
      because backs differ in height more than they differ in curvature and most chairs only adjust
      the second. The seat is foam rather than mesh, on the reasoning that a mesh seat cuts along the
      thigh after a couple of hours. Arms drop far enough to slide the chair under a low desk and
      rise far enough to support a forearm at a high one. Gas lift is rated for a hundred and thirty
      kilograms and is a replaceable standard part, so a sagging chair in year four is a ten-minute
      repair rather than a landfill decision.</p>
      <button class="add-to-cart" data-sku="TC-LM">Add to cart</button>
      <span>189.00 USD</span>
    </article>
    <article class="product">
      <h2>Weatherproof outdoor camera, wired</h2>
      <p>A wired camera rather than a battery one, because the battery models spend their lives
      either flat or charging and the cable is a one-time inconvenience. It records to a card in the
      housing as well as to an account, so an outage does not become a gap, and the card slot is
      inside the sealed section rather than behind a flap. Night footage comes from an infrared array
      that is bright enough to identify a face at four metres and no further, which is what the range
      figure means once you discount the wall it is bouncing off. The mount has three axes and locks
      with a hex key rather than a thumbscrew that vibrates loose.</p>
      <button class="add-to-cart" data-sku="OC-W1">Add to cart</button>
      <span>74.00 USD</span>
    </article>
    <article class="product">
      <h2>Carbon steel wok, 32 cm, flat bottom</h2>
      <p>Carbon steel at a gauge heavy enough not to warp on a domestic ring and light enough to
      lift one-handed while it has food in it, which is the whole argument for carbon over cast iron
      in this shape. The bottom is flat because a domestic hob is flat, and a round-bottomed wok on a
      ring is a party trick rather than a cooking surface. It arrives with a factory coating that has
      to come off before first use and the instructions say how, at length, rather than assuming.
      Seasoned properly it releases better than any coated pan and it can be taken back to bare metal
      and started again, which no coated pan can.</p>
      <button class="add-to-cart" data-sku="CW-32">Add to cart</button>
      <span>42.00 USD</span>
    </article>
    <article class="product">
      <h2>Air purifier for a room up to 40 square metres</h2>
      <p>A purifier rated for a forty square metre room at two air changes an hour, which is the
      figure that matters rather than the larger one quoted at the maximum fan speed nobody can sleep
      through. The filter is a true HEPA cartridge with a carbon layer bonded to it, sold as one part
      because separating them saves nothing and doubles the chance of fitting one wrong. At the two
      lowest settings it is quieter than a fridge; at the top setting it is not, and the manual says
      so in decibels for each of the five steps instead of describing them. The particulate sensor is
      a laser type rather than an infrared one, so it responds to cooking smoke within seconds rather
      than minutes, and the reading it drives is shown as a number as well as a colour.</p>
      <button class="add-to-cart" data-sku="AP-40">Add to cart</button>
      <span>159.00 USD</span>
    </article>
    <article class="product">
      <h2>Cordless drill driver, 18 V, two batteries</h2>
      <p>An eighteen volt drill with a metal chuck and a clutch that has enough low settings to be
      useful on small screws rather than crowding them all into the first two positions. Two batteries
      come with it and the charger fills one in about forty minutes, which is what makes a second
      battery worth having instead of a spare that is always flat. Torque is quoted both hard and
      soft, and the gearbox has two ranges with a collar that changes them positively rather than
      needing to be nudged while the motor turns. The light sits below the chuck rather than above
      it, so the bit does not cast a shadow across the hole being started, which sounds trivial until
      you work under a sink.</p>
      <button class="add-to-cart" data-sku="DD-18">Add to cart</button>
      <span>96.00 USD</span>
    </article>
  </section>
  <nav><a href="/deals?page=2">Next page</a><a href="/departments">All departments</a></nav>
</main>
<script src="/assets/nav-bundle.js" defer></script>
</body></html>
`,
    requestUrls: ["https://token.awswaf.com/REDACTED/challenge.js"],
    status: 202,
    url: "https://target.example/page",
    why: "A solved AWS WAF challenge on a served page is withheld as passed, leaving only the 202 as a weak signal.",
  },
  tp_aws_waf_202_captcha: {
    cookies: [
      "aws-waf-token=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Path=/; Secure; SameSite=None",
    ],
    expect: {
      decoys: [],
      page: "interstitial_heavy_script",
      passedChallenges: [],
      ruleIds: [
        "aws_waf_action",
        "aws_waf_challenge_dom",
        "aws_waf_challenge_request",
        "challenge_title",
        "thin_text_heavy_script",
        "waf_status",
      ],
      vendor: "aws_waf",
      verdict: "blocked",
    },
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=UTF-8",
      "x-amzn-requestid": "REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "x-amzn-waf-action": "captcha",
    },
    html: `<!DOCTYPE html><html lang="en"><head><title>Human verification</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<div id="captcha-container"></div>
<script src="https://REDACTEDxxxx.us-east-1.token.awswaf.com/REDACTEDxxxx/challenge.js"></script>
<script src="https://REDACTEDxxxx.us-east-1.token.awswaf.com/REDACTEDxxxx/captcha.js"></script>
<script>AwsWafCaptcha.renderCaptcha(document.getElementById('captcha-container'), {apiKey:'REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', onSuccess: function(){ location.reload(); }});</script>
</body></html>
`,
    requestUrls: [
      "https://www.bank.example/rates",
      "https://REDACTEDxxxx.us-east-1.token.awswaf.com/REDACTEDxxxx/challenge.js",
      "https://REDACTEDxxxx.us-east-1.token.awswaf.com/REDACTEDxxxx/captcha.js",
      "https://REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/REDACTEDxxxx/report",
    ],
    status: 202,
    url: "https://www.bank.example/rates",
    why: "An AWS WAF captcha served as 202 is blocked by header, request log, markup and thin script.",
  },
  tp_aws_waf_405_decayed_signature: {
    cookies: [],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: ["challenge_title", "waf_status"],
      vendor: null,
      verdict: "blocked",
    },
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=UTF-8",
      "x-amzn-requestid": "REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    },
    html: `<!DOCTYPE html><html lang="en"><head><title>Human Verification</title></head>
<body>
<h1>Additional verification required</h1>
<p>We need to confirm that this request came from a browser before we can continue. This check runs
once per session and usually finishes on its own within a few seconds.</p>
<div id="verification-slot"></div>
</body></html>
`,
    requestUrls: ["https://www.tickets.example/api/availability"],
    status: 405,
    url: "https://www.tickets.example/api/availability",
    why: "With the WAF action header gone, status and title from two families still promote to blocked.",
  },
} satisfies Record<string, BlockCase>;
