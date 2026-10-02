/* The launch differentiator, given the whole band and almost no furniture: a numeral, a
   sentence, and the list it is counting. No card, no ticks, no canvas — everything else on
   the page frames its content, so the one section whose content IS a number gets to stand
   on the page unframed. */

const PATCHES = [
  "navigator.webdriver",
  "CDP Runtime.enable leak",
  "WebGL vendor / renderer",
  "AudioContext fingerprint",
  "Canvas readback noise",
  "Permissions.query state",
  "chrome.runtime presence",
  "Notification.permission",
  "iframe.contentWindow proxy",
  "Function.toString native",
  "WebRTC local IP leak",
  "ClientRects jitter",
  "navigator.plugins table",
  "Intl timezone / locale",
  "screen metrics parity",
  "Battery Status API",
  "mediaDevices.enumerate",
  "speechSynthesis voices",
  "TLS ClientHello order",
  "HTTP/2 SETTINGS frame",
  "font enumeration set",
  "hardwareConcurrency",
  "deviceMemory rounding",
  "userAgentData brands",
];

const Row = ({
  name,
  i,
  dup,
  align = "left",
}: {
  name: string;
  i: number;
  dup?: boolean;
  align?: "left" | "right";
}) => (
  <li
    aria-hidden={dup}
    className={`flex items-baseline gap-4 ${align === "right" ? "flex-row-reverse" : ""}`}
    style={{ padding: "5px 0" }}
  >
    <span
      style={{
        /* ink-dim, not fg-lo: the ordinals are how you read "these are 24 of 45", so
             they have to survive as text on both schemes. */
        color: "var(--xrio-ink-dim)",
        fontFamily: "var(--xrio-mono)",
        fontSize: 10,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {String(i + 1).padStart(2, "0")}
    </span>
    <span
      style={{
        /* A few rows in ink so the column has a rhythm rather than one flat grey. The
             stride is prime against the list length so the accents do not line up between
             the two copies the marquee stacks. */
        color: i % 7 === 3 ? "var(--xrio-accent-text)" : "var(--xrio-fg2)",
        fontFamily: "var(--xrio-mono)",
        fontSize: 11.5,
      }}
    >
      {name}
    </span>
  </li>
);

/* The scrolling column on its own, so the feature grid can carry the real list instead of a
   drawing standing in for it. Height is the caller's.

   align="right" reverses each row rather than just changing text-align: the ordinals have to
   stay on the OUTSIDE edge, so right-set they lead from the right and the names read inward
   from the rule. Text-align alone would have stranded the numbers in the middle. */
export const PatchMarquee = ({
  height = 420,
  align = "left",
  fill = false,
}: {
  height?: number;
  align?: "left" | "right";
  /* Take whatever height the cell has instead of naming one. A fixed figure in a cell that
     spans two rows left a band of nothing under the count. */
  fill?: boolean;
}) => (
  <div className={fill ? "md:flex md:min-h-0 md:flex-1 md:flex-col" : undefined}>
    <div
      className={`patch-marquee relative overflow-hidden ${
        fill ? "h-[320px] md:h-auto md:min-h-0 md:flex-1" : ""
      }`}
      style={fill ? undefined : { height }}
    >
      {/* Rendered twice — see PATCH MARQUEE in globals.css. aria-hidden on the second
            copy only: the first is a real list a screen reader can walk. */}
      <ul className="patch-marquee-track">
        {PATCHES.map((p, i) => (
          <Row key={p} name={p} i={i} align={align} />
        ))}
        {PATCHES.map((p, i) => (
          <Row key={`${p}-2`} name={p} i={i} dup align={align} />
        ))}
      </ul>
    </div>
    <p className={`xrio-kicker mt-5 ${align === "right" ? "text-right" : ""}`}>24 of 45 shown</p>
  </div>
);
