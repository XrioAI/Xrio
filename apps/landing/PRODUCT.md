# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who need reliable, structured data extracted from live web pages —
building their own apps, pipelines, or agents, not doing one-off manual
scraping. The audience is framed as "developers" generally (per the existing
design brief in `.impeccable/TASTE.md`), not narrowed to a specific vertical
like AI/RAG data or market intelligence.

## Product Purpose

Xrio is a scraping/extraction API and CLI positioned as "curl for the modern
web" — the same ergonomics as curl (drop-in flags, pipe-friendly output), but
capable of what curl alone cannot do: render JavaScript-heavy pages, route
through proxies, and produce browser-identical TLS fingerprints so protected
sites see a real browser instead of a scraper. Success is a page fetched and
returned in the caller's requested format with no post-processing.

## Positioning

The mechanism a competitor can't casually copy: curl-compatibility (existing
scripts run unmodified) combined with full anti-bot evasion (JS rendering +
proxy rotation + TLS fingerprinting) in one command/API call, instead of
stitching together a headless browser, a proxy provider, and a fingerprinting
library separately.

## Operating Context

Called from the command line (curl-compatible flags) or from code via SDKs
(Python, Node.js, Go), typically inside scripts, pipelines, or agents that
need extracted web content — not through a GUI. Output tiers scale with how
hard the target page fights back: plain HTML, JS-rendered HTML, or
JS-rendered + residential-proxy-routed, each priced differently per 1,000
requests.

## Capabilities and Constraints

- JavaScript rendering via full headless browser execution (SPAs, lazy load,
  infinite scroll).
- Proxy routing: residential, datacenter, and mobile proxies with rotation,
  geo-targeting, session persistence.
- TLS fingerprinting: browser-identical handshakes (e.g. presents as Chrome 120) to pass Cloudflare/Akamai bot checks.
- Output format conversion: JSON, Markdown, XML, HTML, plain text.
- curl-compatible: drop-in replacement, same flags, pipe-friendly output.
- Official SDKs: Python, Node.js, Go — async-native, streaming responses.
- Pricing is usage-based per 1,000 requests across three difficulty tiers
  (HTML / Browser Rendered / Browser Rendered + Proxy), with pay-as-you-go
  and monthly-commitment discount levels, plus a trial credit. **Actual rate
  figures are not decided yet** — the site intentionally renders them as em
  dashes rather than placeholder numbers; that must never be mistaken for
  real pricing.
- Currently pre-launch/beta (hero badge reads v0.9.1). Copy and CTAs should
  read as early access / waitlist, not "sign up and use it today."

## Brand Commitments

- Product name: Xrio. Tagline in use: "Fetch Everything" / "Scrape Anything."
- Built by Proxidize (repo is `proxidize/xrio-landing-page`), but by explicit
  decision **Xrio stands alone as its own brand** — no Proxidize co-branding,
  mention, or trust signal anywhere on the site.

## Evidence on Hand

None. No testimonials, customer logos, case studies, or benchmarks exist yet,
and the page has no such section today. Do not fabricate any — this is
pre-launch, and a future proof section needs real evidence before it ships.

## Product Principles

1. Curl-familiarity is load-bearing — never introduce jargon or flows a curl
   user wouldn't recognize.
2. The evasion capability (TLS + proxy + rendering working together) is the
   actual value; explain features by what protection they defeat, not as
   generic "web scraping."
3. Say "not decided yet" honestly (em dashes, no overpromising CTAs) rather
   than inventing numbers, users, or proof this early.
4. Keep Xrio's brand independent of Proxidize in all public-facing copy and
   design.

## Accessibility & Inclusion

No product-specific requirement established.
