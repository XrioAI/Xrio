export type Tier = "E0" | "E1" | "E2" | "E3";

export type BuiltinKind =
  | "content_type_not_html"
  | "body_is_json"
  | "body_is_xml"
  | "thin_text_heavy_script"
  | "classifier_failure";

type DomGate = "none" | "interstitial" | "no_prose";

interface RuleIdentity {
  id: string;
  family: string;
  vendor?: string;
  detail: string;
}

type RuleProof =
  | { tier: "E0"; proves?: "challenge_issued" }
  | { tier: "E1" | "E2" | "E3"; proves?: never };

type RuleMatcher =
  | { source: "request_log"; pattern: RegExp }
  | { source: "response_header"; header: string; pattern?: RegExp }
  | { source: "response_header"; headerPrefix: string }
  | { source: "set_cookie"; pattern: RegExp; requiresHtml: boolean }
  | { source: "status"; statuses: readonly number[] }
  | { source: "dom"; target: "html" | "title" | "text"; pattern: RegExp; gate: DomGate }
  | { source: "final_url"; hostSuffix: string; verdict?: "queued" }
  | { source: "builtin"; kind: BuiltinKind };

export type Rule = RuleIdentity & RuleProof & RuleMatcher;

export const gates = {
  domScanMaxChars: 1_048_576,
  interstitialMaxHtmlChars: 50_000,
  interstitialMaxTextChars: 5000,
  minProseChars: 100,
  minScriptChars: 200,
  scriptToTextRatio: 10,
  smallPageChars: 10_000,
} as const;

export const rules = [
  {
    detail:
      "request to Cloudflare's challenge orchestration, verification or flow path — issued only from inside an interstitial, and locale-independent (unlike the title). NOT the whole /cdn-cgi/challenge-platform/ prefix: passive JS Detections loads .../scripts/jsd/main.js and beacons to .../h/b/jsd/r/ on pages that render perfectly, so the broad prefix is a false-positive generator on any site with JSD enabled",
    family: "cloudflare",
    id: "cf_challenge_platform_request",
    pattern: /\/cdn-cgi\/challenge-platform\/h\/[a-z]\/(?:orchestrate|cv|flow)\//u,
    proves: "challenge_issued",
    source: "request_log",
    tier: "E0",
    vendor: "cloudflare",
  },
  {
    detail: "request to DataDome's captcha delivery host",
    family: "datadome",
    id: "datadome_captcha_delivery_request",
    pattern: /geo\.captcha-delivery\.com/u,
    proves: "challenge_issued",
    source: "request_log",
    tier: "E0",
    vendor: "datadome",
  },
  {
    detail:
      "request to a PerimeterX captcha host — distinct from its collector, which runs on passing pages",
    family: "perimeterx",
    id: "perimeterx_captcha_request",
    pattern: /captcha\.(?:px-cdn\.net|px-cloud\.net|perimeterx\.net)/u,
    proves: "challenge_issued",
    source: "request_log",
    tier: "E0",
    vendor: "perimeterx",
  },
  {
    detail: "request for the AWS WAF challenge/captcha bundle",
    family: "aws_waf",
    id: "aws_waf_challenge_request",
    pattern: /token\.awswaf\.com\/[^\s]{0,256}(?:challenge|captcha)\.js/u,
    proves: "challenge_issued",
    source: "request_log",
    tier: "E0",
    vendor: "aws_waf",
  },
  {
    detail:
      "Imperva's challenge resource variant (the plain _Incapsula_Resource loader is normal traffic)",
    family: "imperva",
    id: "imperva_captcha_request",
    pattern: /\/_Incapsula_Resource\?[^\s]{0,256}SWCGHOEL/u,
    proves: "challenge_issued",
    source: "request_log",
    tier: "E0",
    vendor: "imperva",
  },
  {
    detail:
      "request for Spur's Monocle loader with its site token — the assessment script an interstitial loads before it can decide. Path-keyed, not host-keyed: Spur serves it from mcl.spur.us and documents first-party proxying, and the one measured deployment (gopuff.com, 2026-09-10) proxies it at mcl.<target>. Issued on the pass and on the denial alike, which is why it is challenge_issued; and being a request-log rule it also arms the challenge wait, which is what rebinds the response on a pass instead of grading the homepage against the interstitial's 203",
    family: "spur",
    id: "spur_monocle_loader_request",
    pattern: /\/d\/mcl\.js\?tk=/u,
    proves: "challenge_issued",
    source: "request_log",
    tier: "E0",
    vendor: "spur",
  },
  {
    detail:
      "Cloudflare's documented mitigation header. Fires on 403, 503 *and 200* — which is why status can never be the primary axis",
    family: "cloudflare",
    header: "cf-mitigated",
    id: "cf_mitigated_challenge",
    pattern: /challenge/iu,
    proves: "challenge_issued",
    source: "response_header",
    tier: "E0",
    vendor: "cloudflare",
  },
  {
    detail:
      "AWS WAF states the action it took; it also returns 202 and 405, which look like success to a status-only classifier",
    family: "aws_waf",
    header: "x-amzn-waf-action",
    id: "aws_waf_action",
    pattern: /challenge|captcha/iu,
    proves: "challenge_issued",
    source: "response_header",
    tier: "E0",
    vendor: "aws_waf",
  },
  {
    detail: "Vercel Attack Challenge Mode; presence is the signal",
    family: "vercel",
    header: "x-vercel-mitigated",
    id: "vercel_mitigated",
    proves: "challenge_issued",
    source: "response_header",
    tier: "E0",
    vendor: "vercel",
  },
  {
    detail:
      "DataDome echoes the status it generated, distinguishing its response from the origin's",
    family: "datadome",
    header: "x-datadome-response",
    id: "datadome_response_header",
    proves: "challenge_issued",
    source: "response_header",
    tier: "E0",
    vendor: "datadome",
  },
  {
    detail: "PerimeterX enforcement header",
    family: "perimeterx",
    header: "x-px-pp",
    id: "perimeterx_pp_header",
    proves: "challenge_issued",
    source: "response_header",
    tier: "E0",
    vendor: "perimeterx",
  },
  {
    detail: "PerimeterX enforcement header",
    family: "perimeterx",
    header: "x-px-gt",
    id: "perimeterx_gt_header",
    proves: "challenge_issued",
    source: "response_header",
    tier: "E0",
    vendor: "perimeterx",
  },
  {
    detail: "any Kasada KPSDK response header",
    family: "kasada",
    headerPrefix: "x-kpsdk-",
    id: "kasada_kpsdk_header",
    proves: "challenge_issued",
    source: "response_header",
    tier: "E0",
    vendor: "kasada",
  },
  {
    detail:
      "Ticketmaster's EPS marks its own interstitial responses: tm-bl: 1 on every 401 identity check and 403 block measured (sixteen of sixteen, 2026-09-29) and on none of the served event pages. challenge_issued because the 401 is issued on the pass and the refusal alike, and the page navigates to decide; this is what arms the challenge wait",
    family: "ticketmaster",
    header: "tm-bl",
    id: "ticketmaster_eps_header",
    proves: "challenge_issued",
    source: "response_header",
    tier: "E0",
    vendor: "ticketmaster",
  },
  {
    detail:
      "a cf_chl_* cookie is set only by a challenge page — unlike __cf_bm (normal traffic) and cf_clearance (we already passed). It is routinely the second or third Set-Cookie value, so a dict-shaped header read drops it",
    family: "cloudflare",
    id: "cf_challenge_cookie",
    pattern: /cf_chl_[a-z0-9_]{0,256}=/u,
    requiresHtml: true,
    source: "set_cookie",
    tier: "E1",
    vendor: "cloudflare",
  },
  {
    detail:
      "a status anti-bot vendors use. 202 and 405 are AWS WAF's, and a 202 reads as success to every implementation surveyed. Xrio has no status allow-list, so this is always weak evidence and never decides alone",
    family: "status",
    id: "waf_status",
    source: "status",
    statuses: [403, 429, 503, 202, 405],
    tier: "E2",
  },
  {
    detail:
      "Cloudflare's challenge orchestration path in the markup — the same fact as the request-log rule, one tier weaker because the DOM can merely be quoting it. Excludes the JS Detections paths for the same reason",
    family: "cloudflare",
    gate: "interstitial",
    id: "cf_challenge_platform_dom",
    pattern: /\/cdn-cgi\/challenge-platform\/h\/[a-z]\/(?:orchestrate|cv|flow)\//u,
    source: "dom",
    target: "html",
    tier: "E1",
    vendor: "cloudflare",
  },
  {
    detail: "the challenge page's own configuration object",
    family: "cloudflare",
    gate: "interstitial",
    id: "cf_chl_opt",
    pattern: /window\._cf_chl_opt/u,
    source: "dom",
    target: "html",
    tier: "E1",
    vendor: "cloudflare",
  },
  {
    detail:
      "Cloudflare's four-digit error code element (1020 firewall rule, 1015 rate limit, 1010 bad browser)",
    family: "cloudflare",
    gate: "interstitial",
    id: "cf_error_code_span",
    pattern: /<span class=.?cf-error-code.?>\s*\d{4}/u,
    source: "dom",
    target: "html",
    tier: "E1",
    vendor: "cloudflare",
  },
  {
    detail: "Cloudflare's own error-1020 body text",
    family: "cloudflare",
    gate: "interstitial",
    id: "cf_restrict_access_text",
    pattern: /used Cloudflare to restrict access/u,
    source: "dom",
    target: "html",
    tier: "E1",
    vendor: "cloudflare",
  },
  {
    detail:
      "the headline of Cloudflare's current block template ('Sorry, you have been blocked'), by its translation key rather than its English text, so the localized template matches too. Neither older Cloudflare template rule matches this template",
    family: "cloudflare",
    gate: "interstitial",
    id: "cf_block_headline",
    pattern: /data-translate=.?block_headline/u,
    source: "dom",
    target: "html",
    tier: "E1",
    vendor: "cloudflare",
  },
  {
    detail:
      "Imperva's resource loader. Present on PASSING pages of a protected site, so it carries the strictest shape gate: interstitial-shape alone is not enough, because a real product page has only a few hundred characters of prose and is therefore interstitial-shaped by that measure",
    family: "imperva",
    gate: "no_prose",
    id: "imperva_resource",
    pattern: /_Incapsula_Resource/u,
    source: "dom",
    target: "html",
    tier: "E1",
    vendor: "imperva",
  },
  {
    detail: "Imperva's block page prints the incident id",
    family: "imperva",
    gate: "interstitial",
    id: "imperva_incident_id",
    pattern: /Incapsula incident ID/u,
    source: "dom",
    target: "html",
    tier: "E1",
    vendor: "imperva",
  },
  {
    detail:
      "PerimeterX sensor bootstrap. Present on every page of a protected site that renders fine, which is the most common mistake in scrapers that detect PerimeterX at all — so it requires a document with no prose whatsoever, not merely a small one",
    family: "perimeterx",
    gate: "no_prose",
    id: "perimeterx_app_id",
    pattern: /window\._pxAppId\s*=/u,
    source: "dom",
    target: "html",
    tier: "E1",
    vendor: "perimeterx",
  },
  {
    detail:
      "Kasada SDK bootstrap. Same caveat as the PerimeterX sensor: the SDK loads on passing pages, so it requires a document with no prose whatsoever",
    family: "kasada",
    gate: "no_prose",
    id: "kasada_script_start",
    pattern: /KPSDK\.scriptStart/u,
    source: "dom",
    target: "html",
    tier: "E1",
    vendor: "kasada",
  },
  {
    detail:
      "Akamai's error reference triple. Distinctive enough to stand alone on an interstitial-shaped page",
    family: "akamai",
    gate: "interstitial",
    id: "akamai_reference_id",
    pattern: /Reference #\d+\.[0-9a-f]+\.\d+\.[0-9a-f]+/u,
    source: "dom",
    target: "html",
    tier: "E1",
    vendor: "akamai",
  },
  {
    detail: "DataDome's captcha host referenced in the markup",
    family: "datadome",
    gate: "interstitial",
    id: "datadome_captcha_host_dom",
    pattern: /geo\.captcha-delivery\.com/u,
    source: "dom",
    target: "html",
    tier: "E1",
    vendor: "datadome",
  },
  {
    detail: "AWS WAF challenge bundle referenced in the markup",
    family: "aws_waf",
    gate: "interstitial",
    id: "aws_waf_challenge_dom",
    pattern: /token\.awswaf\.com\/[^\s]{0,256}(?:challenge|captcha)\.js/u,
    source: "dom",
    target: "html",
    tier: "E1",
    vendor: "aws_waf",
  },
  {
    detail:
      "the sentence an integrator's Monocle interstitial writes into the page when its validation endpoint answers 402 — Spur's assessment said proxy or VPN. Visible text only, because the same sentence sits in the interstitial's own script as a template before any answer arrives, and matching the markup would fire on an assessment still in progress. One deployment (gopuff.com, 2026-09-10: three of four mobile exits, identically under branded Chrome), and narrow on purpose: it exists so the report says WHY — the exit was judged a proxy — not to decide the verdict, which spur_monocle_loader_request already decides on an interstitial-shaped capture",
    family: "spur",
    gate: "interstitial",
    id: "spur_monocle_denied_text",
    pattern: /Captcha validation failed\. Please disconnect from any VPNs or proxies/u,
    source: "dom",
    target: "text",
    tier: "E1",
    vendor: "spur",
  },
  {
    detail:
      "Ticketmaster's EPS block page, the template its identity check navigates to when it refuses: the abuse-component element carries the verdict in its action attribute (identify on the check itself). Measured at 6,893 and 158,789 characters, the larger with a tag manager inlined; the element never appears on a served page",
    family: "ticketmaster",
    gate: "none",
    id: "ticketmaster_eps_block",
    pattern: /<abuse-component[^>]{0,1024}\baction="block"/u,
    source: "dom",
    target: "html",
    tier: "E0",
    vendor: "ticketmaster",
  },
  {
    detail:
      "LinkedIn's authwall, the sign-up form a 999 navigates an anonymous visitor to instead of the profile it asked for, identified by its own canonical link. 66 KB with prose, so no size gate would admit it; a served profile's canonical is the profile's own URL",
    family: "linkedin",
    gate: "none",
    id: "linkedin_authwall_canonical",
    pattern: /rel="canonical" href="(?:https:\/\/[a-z.]*linkedin\.com)?\/authwall"/u,
    source: "dom",
    target: "html",
    tier: "E0",
    vendor: "linkedin",
  },
  {
    detail: "an interstitial title. English-only by nature, hence E2 forever",
    family: "title",
    gate: "none",
    id: "challenge_title",
    pattern:
      /just a moment|attention required|checking (?:if )?your browser|please wait\.\.\.|one moment, please|human verification|verifying you are (?:a )?human|are you a robot|access to this page has been denied|pardon our interruption|bot verification/iu,
    source: "dom",
    target: "title",
    tier: "E2",
  },
  {
    detail: "the challenge page's form element",
    family: "captcha_widget",
    gate: "interstitial",
    id: "cf_challenge_form",
    pattern: /id=.?challenge-form/u,
    source: "dom",
    target: "html",
    tier: "E2",
    vendor: "cloudflare",
  },
  {
    detail:
      "a reCAPTCHA widget mounted in the markup. Site authors put these on their own forms, so it counts only on an interstitial-shaped page",
    family: "captcha_widget",
    gate: "interstitial",
    id: "recaptcha_widget",
    pattern: /g-recaptcha/u,
    source: "dom",
    target: "html",
    tier: "E2",
  },
  {
    detail: "an hCaptcha widget mounted in the markup. Same site-author caveat as reCAPTCHA",
    family: "captcha_widget",
    gate: "interstitial",
    id: "hcaptcha_widget",
    pattern: /h-captcha/u,
    source: "dom",
    target: "html",
    tier: "E2",
  },
  {
    detail: "PerimeterX's captcha mount point",
    family: "captcha_widget",
    gate: "interstitial",
    id: "perimeterx_captcha_element",
    pattern: /px-captcha/u,
    source: "dom",
    target: "html",
    tier: "E2",
    vendor: "perimeterx",
  },
  {
    detail: "DataDome's captcha markup",
    family: "captcha_widget",
    gate: "interstitial",
    id: "datadome_captcha_element",
    pattern: /captcha__human|captcha-delivery/u,
    source: "dom",
    target: "html",
    tier: "E2",
    vendor: "datadome",
  },
  {
    detail:
      "we were parked in a Queue-it waiting room. Not a block: retrying harder is exactly the wrong response, so it gets its own verdict",
    family: "queue",
    hostSuffix: ".queue-it.net",
    id: "queue_it_waiting_room",
    source: "final_url",
    tier: "E0",
    vendor: "queue-it",
    verdict: "queued",
  },
  {
    detail:
      "the response is not HTML, so no structural or weak signal counts. An absent content-type counts as not-HTML: fewer blocks is the safe direction",
    family: "content_type",
    id: "content_type_not_html",
    kind: "content_type_not_html",
    source: "builtin",
    tier: "E3",
  },
  {
    detail: "the body parses as JSON — an API error, not an interstitial, whatever the status says",
    family: "body_format",
    id: "body_is_json",
    kind: "body_is_json",
    source: "builtin",
    tier: "E3",
  },
  {
    detail: "the body parses as XML (S3 AccessDenied and friends)",
    family: "body_format",
    id: "body_is_xml",
    kind: "body_is_xml",
    source: "builtin",
    tier: "E3",
  },
  {
    detail:
      "a small document with almost no prose and a lot of script. Bounded by min_text_chars rather than thin_text_chars so a login form — legitimately thin — does not qualify",
    family: "page_shape",
    id: "thin_text_heavy_script",
    kind: "thin_text_heavy_script",
    source: "builtin",
    tier: "E2",
  },
  {
    detail:
      "classification itself failed, so the verdict is UNKNOWN. An infrastructure error must never masquerade as a WAF outcome",
    family: "internal",
    id: "classifier_failure",
    kind: "classifier_failure",
    source: "builtin",
    tier: "E3",
  },
] as const satisfies readonly Rule[];
