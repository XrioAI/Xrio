/* What the patches keep consistent, in plain words: settings a browser is configured with,
   matched to each other and to the locale. Deliberately not the engine-level names — those are
   the names of detection checks, and a list of them reads as a list of things being hidden. */
const PATCHES = [
  "Timezone and locale",
  "Fonts for the locale",
  "Speech voices for the locale",
  "Screen size and scaling",
  "Graphics renderer",
  "Canvas rendering",
  "Audio output",
  "CPU cores and memory",
  "Permission defaults",
];

/* The column is ~610px tall on desktop and the list is far shorter, so each marquee copy runs
   the list REPEAT times — enough rows to overfill the column, or the loop shows a gap. */
const REPEAT = 3;

const ROWS = Array.from({ length: REPEAT }, () => PATCHES).flat();

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
        /* ink-dim, not fg-lo: the ordinals are how you read the length of the list, so
             they have to survive as text on both schemes. */
        color: "var(--xrio-ink-dim)",
        fontFamily: "var(--xrio-mono)",
        fontSize: 10,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {String((i % PATCHES.length) + 1).padStart(2, "0")}
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
        {ROWS.map((p, i) => (
          <Row key={i} name={p} i={i} dup={i >= PATCHES.length} align={align} />
        ))}
        {ROWS.map((p, i) => (
          <Row key={`dup-${i}`} name={p} i={i} dup align={align} />
        ))}
      </ul>
    </div>
  </div>
);
