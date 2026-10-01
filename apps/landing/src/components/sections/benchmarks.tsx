"use client";

import { useEffect, useRef, useState } from "react";

/* The benchmark band: the top 250 sites on the internet, run against every scraper worth
   comparing to.

   ⚠ THE NUMBERS ARE PLACEHOLDERS AND THE NAMES ARE REAL COMPANIES. Nothing here may ship to a
   public page until a real, reproducible run replaces every value below, and the method line
   has to describe whatever that run actually did.

   TWO COLUMNS, AND THEY ANSWER DIFFERENT QUESTIONS. Down the left is the PROFILE — the radar
   with its selector, and under it the same comparison as measurements. Down the right is the
   RANKING, one row per scraper. A radar says what shape a thing is and cannot order anything;
   a sorted bar list orders precisely and says nothing about shape. Neither is asked to do the
   other's job.

   EVERY COMPETITOR IS ON THE GRID, ONE OF THEM IN FOCUS. Five polygons is only a ball of wool
   when they are all drawn with the same weight. They are not: the unselected sit at a tenth of
   the page's ink, the selected one is the same line at full strength, and Xrio is the only
   coloured line in the figure.

   NO SCORES OUT OF 100 ANYWHERE A READER CAN SEE. A score invites "out of what, weighted how",
   and there is no good answer to it. The readout carries the measurements themselves with their
   units — 98.4%, 1.2s, $2.90 — and the radar's geometry is derived from those behind the
   scenes, because a radar cannot plot five different units without a common one. The derivation
   is the only honest one available: per axis, the best run in the test reaches the outer ring
   and the worst sits near the inner one, so a bigger shape is a better scraper and the rings
   are a grid rather than a scale. Nothing on screen claims otherwise.

   DRAWN, NOT RENDERED. An early cut was a translucent polygon with round joins and round
   markers — the default any charting library hands you, and it read as plastic on a page made
   of hairlines and 1.2px line glyphs. This one is a line drawing and nothing in it is filled:
   thin strokes, mitred joins, rings in the page's own border tokens.

   THE WHOLE BAND IS SIZED TO ONE SCREEN. Every padding below is part of that budget, so
   anything added here has to come out of something else. */

interface Run {
  name: string;
  // of the 250 — the success rate is derived, so the two can never disagree
  blocked: number;
  // median seconds
  p50: number;
  p95: number;
  // requests spent per page that came back
  retries: number;
  // dollars per 1,000 pages; 0 is Xrio, which is free
  cost: number;
}

const N = 250;

/* Sorted best first. The order is the ranking, so nothing has to say so.

   FIVE COMPETITORS, NOT EIGHT. The list was long enough to need reading rather than scanning,
   and every name added costs the selector a row and the radar another outline. These are the
   five a buyer would actually be choosing between. */
const RUNS: Run[] = [
  { blocked: 4, cost: 0, name: "Xrio", p50: 1.2, p95: 2.8, retries: 1.04 },
  { blocked: 15, cost: 2.9, name: "Bright Data", p50: 3.4, p95: 9.1, retries: 1.31 },
  { blocked: 21, cost: 2.6, name: "Oxylabs", p50: 3.1, p95: 8.8, retries: 1.38 },
  { blocked: 28, cost: 1.9, name: "ZenRows", p50: 2.9, p95: 8.4, retries: 1.49 },
  { blocked: 52, cost: 0.98, name: "ScraperAPI", p50: 2.2, p95: 10.6, retries: 1.72 },
  { blocked: 69, cost: 1.25, name: "ScrapingBee", p50: 2.6, p95: 11.4, retries: 1.88 },
];

const got = (r: Run) => ((N - r.blocked) / N) * 100;

/* The five axes. `of` reads the measurement off a run and `fmt` prints one — they are split so
   a value that is mid-tween, belonging to no run at all, can still be read and plotted. `low`
   marks the axes where less is better, which is what lets one rule turn five different units
   into one geometry without anyone having to be told. */
interface Axis {
  key: string;
  of: (r: Run) => number;
  fmt: (v: number) => string;
  low?: true;
}

const AXES: Axis[] = [
  { fmt: (v) => `${v.toFixed(1)}%`, key: "SUCCESS", of: got },
  { fmt: (v) => `${v.toFixed(1)}s`, key: "MEDIAN", low: true, of: (r) => r.p50 },
  { fmt: (v) => `${v.toFixed(1)}s`, key: "P95", low: true, of: (r) => r.p95 },
  { fmt: (v) => `${v.toFixed(2)}×`, key: "RETRIES", low: true, of: (r) => r.retries },
  /* Zero is a price, and "$0.00" reads as a missing value rather than as the point. */
  { fmt: (v) => (v ? `$${v.toFixed(2)}` : "Free"), key: "COST", low: true, of: (r) => r.cost },
];

const [XRIO, ...FIELD] = RUNS;

const VS = FIELD.map((r) => ({ ...r, short: r.name.toUpperCase() }));

const SPAN = AXES.map((a) => {
  const v = RUNS.map(a.of);

  return [Math.min(...v), Math.max(...v)] as const;
});

/* The band is 26 to 94 rather than 0 to 100, at both ends for its own reason. A vertex at the
   centre collapses the polygon into a spike and the shape stops reading as a shape; a vertex on
   the outer ring puts the winning line exactly on top of the grid's own edge, where it reads as
   a border rather than as a reading. Xrio is best on all five, so without the ceiling its
   pentagon simply becomes the frame. */
const reach = (i: number, v: number) => {
  const [lo, hi] = SPAN[i];

  if (hi === lo) {
    return 100;
  }

  const t = AXES[i].low ? (hi - v) / (hi - lo) : (v - lo) / (hi - lo);

  return 26 + 68 * t;
};

/* A run as its five measurements, which is the form everything downstream wants: the readout
   prints them, the geometry derives radii from them, and the tween interpolates them. */
const values = (r: Run) => AXES.map((a) => a.of(r));

const RAW_XRIO = values(XRIO);

const RAW_VS = VS.map(values);

/* Pentagon, point up. The viewBox carries enough air past the outer ring for the axis labels to
   sit outside it without being clipped. */
const RAD = { cx: 170, cy: 128, r: 84 };

const RINGS = [25, 50, 75, 100];

const vertex = (i: number, v: number) => {
  const a = ((-90 + i * (360 / AXES.length)) * Math.PI) / 180;

  return [
    RAD.cx + Math.cos(a) * RAD.r * (v / 100),
    RAD.cy + Math.sin(a) * RAD.r * (v / 100),
  ] as const;
};

const ring = (v: number) => AXES.map((_, i) => vertex(i, v).join(",")).join(" ");

/* `k` scales every radius, so the same call draws the figure mid-entrance and at rest. */
const pts = (raw: number[], k: number) =>
  raw.map((v, i) => vertex(i, reach(i, v) * k).join(",")).join(" ");

/* ~60fps, stepped on a timer rather than on requestAnimationFrame. The frame callback does not
   fire in a document the browser considers hidden — which is the preview pane's permanent state
   here — and a figure that stays collapsed in every preview is a figure nobody can check. The
   belt in the grid above is on a timer for the same reason. Easing is computed from the clock,
   not from the tick count, so timer jitter cannot distort it. */
const STEP = 16;

// the figure arriving
const ENTER = 820;

// the figure answering a pointer
const SWITCH = 380;

/* How much of the entrance each row waits out before it starts. */
const STAGGER = 0.08;

const easeOut = (p: number) => 1 - (1 - p) ** 3;

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const PAD = "clamp(18px, 2.2vw, 26px)";

const RULE = { borderColor: "var(--xrio-border)" };

const MONO = { fontFamily: "var(--xrio-mono)" } as const;

const TICK = {
  ...MONO,
  color: "var(--xrio-ink-dim)",
  fontSize: 10,
  letterSpacing: ".08em",
} as const;

/* Name, track, three figures. One template for the header and every row, so the columns line up
   without a table element. */
const COLS = "md:grid-cols-[108px_minmax(0,1fr)_58px_52px_52px]";

/* Axis, Xrio, comparator. The last track is wide enough for the longest comparator name, which
   sits above it. */
const READOUT = "grid grid-cols-[1fr_52px_92px] items-center gap-3";

/* The card's own grid. Three columns — selector, profile, ranking — and seven bands: a header
   and one per scraper. The bands are 1fr so they divide whatever height the profile asks for,
   and the ranking rows land on them one apiece. */
const GRID =
  "grid-cols-[96px_minmax(0,1fr)] md:grid-cols-[124px_minmax(0,1fr)_minmax(0,1.45fr)] md:grid-rows-[auto_repeat(6,minmax(0,1fr))]";

/* Written out rather than built, so Tailwind can see every class it has to emit. Phone rows run
   3-8 under the profile; at md each one takes its scraper's band in the third column. */
const RANK_ROW = [
  "row-start-4 md:row-start-2",
  "row-start-5 md:row-start-3",
  "row-start-6 md:row-start-4",
  "row-start-7 md:row-start-5",
  "row-start-8 md:row-start-6",
  "row-start-9 md:row-start-7",
];

const Swatch = ({ color }: { color: string }) => (
  <span
    aria-hidden="true"
    style={{ background: color, borderRadius: 2, display: "inline-block", height: 9, width: 9 }}
  />
);

/* The figure's name rides with it on a phone, where the column heads above have nowhere to sit.
   At md the heads take over and the prefix disappears. */
const Figure = ({
  label,
  children,
  lead,
}: {
  label: string;
  children: React.ReactNode;
  lead: boolean;
}) => (
  <span
    className="text-right"
    style={{ ...MONO, color: lead ? "var(--xrio-fg)" : "var(--xrio-fg-mid)", fontSize: 12 }}
  >
    <span className="md:hidden" style={{ ...TICK, marginRight: 4 }}>
      {label}
    </span>
    {children}
  </span>
);

/* One row of the selector. `always` is Xrio: shown as on, not operable, and never the thing a
   pointer changes. Hover picks, because the comparison is cheap to change and the point is
   sweeping the list; click and focus are kept for touch and for the keyboard. */
const Pill = ({
  name,
  on,
  always = false,
  onPick,
}: {
  name: string;
  on: boolean;
  always?: boolean;
  onPick?: () => void;
}) => {
  const body = (
    <>
      <span
        aria-hidden="true"
        style={{
          alignSelf: "stretch",
          background: always || on ? "var(--xrio-accent-fill)" : "transparent",
          width: 2,
        }}
      />
      {/* The row is a band, not a chip: it is as tall as the ranking row it has to line up with,
          so the name has to be centred in it. Stretch stays on the parent for the accent edge,
          which does run the full height. */}
      <span className="flex flex-1 items-center" style={{ padding: "0 12px" }}>
        {name}
      </span>
    </>
  );

  const background = on ? "var(--xrio-well)" : "transparent";
  const color = on ? "var(--xrio-fg)" : "var(--xrio-ink-dim)";

  const style: React.CSSProperties = {
    ...MONO,
    alignItems: "stretch",
    background: always ? "color-mix(in srgb, var(--xrio-accent-text) 8%, transparent)" : background,
    color: always ? "var(--xrio-accent-text)" : color,
    display: "flex",
    flex: "1 1 0",
    textAlign: "left",
  };

  /* The rows are already divided by a rule; the top border is what separates one from the next
     rather than a box around each. */
  const divider = { borderTop: "1px solid var(--xrio-border)" };

  if (always) {
    return (
      <span className="xrio-bench-pill" style={style}>
        {body}
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={on}
      onMouseEnter={onPick}
      onFocus={onPick}
      onClick={onPick}
      className="xrio-bench-pill cursor-pointer"
      style={{ ...style, ...divider }}
    >
      {body}
    </button>
  );
};

export const Benchmarks = () => {
  const [pick, setPick] = useState(0);
  /* How far the figure has grown out of its own centre: 0 before the band is reached, 1 after. */
  const [k, setK] = useState(0);
  /* The comparator's five measurements, interpolated. The readout prints these and the geometry
     derives its radii from them, so the numbers and the shape are the same animation — there is
     no way for the text to say one thing while the polygon shows another. */
  const [vals, setVals] = useState<number[]>(RAW_VS[0]);
  /* 0 at the start of a switch, 1 at the end. Only the comparator's NAME uses it: a name is the
     one thing on screen that cannot be interpolated, so it fades instead. */
  const [prog, setProg] = useState(1);

  const frameRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(false);
  const [shown, setShown] = useState(false);
  const fromVals = useRef<number[]>(RAW_VS[0]);
  const enterTimer = useRef<number>(0);
  const switchTimer = useRef<number>(0);

  const vs = VS[pick];

  /* The list fills top to bottom rather than all at once: each row opens on its own slice of
     the same k, so the column reads as filling instead of flashing. */
  const fill = (i: number) =>
    Math.max(0, Math.min(1, (k - i * STAGGER) / (1 - STAGGER * (RUNS.length - 1))));

  /* The entrance fires once, when the frame first has a decent amount of itself on screen.
     Polled rather than observed: IntersectionObserver is delivered on the rendering lifecycle,
     so in a document the browser considers hidden it never calls back at all — and a figure
     that stays collapsed whenever that happens is worse than one that checks a rectangle four
     times a second until it is sure. The poll stops the moment it fires. */
  useEffect((): ReturnType<React.EffectCallback> => {
    const el = frameRef.current;

    if (!el) {
      return;
    }

    const id = setInterval(() => {
      if (shownRef.current) {
        return;
      }

      const r = el.getBoundingClientRect();
      const seen = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);

      if (seen < Math.min(r.height, window.innerHeight) * 0.3) {
        return;
      }

      shownRef.current = true;
      setShown(true);
      clearInterval(id);
    }, 240);

    return () => {
      clearInterval(id);
    };
  }, []);

  /* The entrance. */
  useEffect((): ReturnType<React.EffectCallback> => {
    if (!shown) {
      return;
    }

    const ms = reduced() ? 0 : ENTER;
    const t0 = performance.now();

    const tick = (now: number) => {
      const p = ms ? Math.min(1, (now - t0) / ms) : 1;
      setK(easeOut(p));

      if (p < 1) {
        enterTimer.current = window.setTimeout(() => {
          tick(performance.now());
        }, STEP);
      }
    };

    tick(performance.now());

    return () => {
      clearTimeout(enterTimer.current);
    };
  }, [shown]);

  /* The switch — a hover, a tap or a tab onto another name. */
  useEffect((): ReturnType<React.EffectCallback> => {
    const to = RAW_VS[pick];
    const from = fromVals.current;
    const ms = reduced() ? 0 : SWITCH;
    const t0 = performance.now();

    const tick = (now: number) => {
      const p = ms ? Math.min(1, (now - t0) / ms) : 1;
      const e = easeOut(p);
      const v = to.map((x, i) => from[i] + (x - from[i]) * e);
      fromVals.current = v;
      setVals(v);
      setProg(e);

      if (p < 1) {
        switchTimer.current = window.setTimeout(() => {
          tick(performance.now());
        }, STEP);
      }
    };

    tick(performance.now());

    return () => {
      clearTimeout(switchTimer.current);
    };
  }, [pick]);

  return (
    <section id="benchmarks" style={{ padding: "clamp(36px, 5vw, 60px) clamp(24px, 6vw, 72px)" }}>
      <div className="mb-7 flex flex-col gap-4 md:mb-8 md:flex-row md:items-end md:justify-between">
        <h2
          style={{
            fontFamily:
              "var(--xrio-display-font, var(--font-space-grotesk), system-ui, sans-serif)",
            fontSize: "clamp(28px, 3.6vw, 44px)",
            fontWeight: 700,
            letterSpacing: "-.03em",
            lineHeight: 1.1,
          }}
        >
          The top 250 sites.
        </h2>
        <p style={{ color: "var(--xrio-fg2)", fontSize: 13, lineHeight: 1.65, maxWidth: 330 }}>
          One pass at each, six scrapers. A site counts only if the page came back — not a block,
          not a challenge, not an empty shell.
        </p>
      </div>

      {/* ── ONE GRID, THREE COLUMNS, SEVEN BANDS ──
          The card is a single grid and every piece in it is a cell on that grid, which is the
          only way the rules can line up: a column with its own stack and its own padding will
          always put its hairlines at heights the column beside it knows nothing about.

          The bands are a header and one per scraper. The selector takes rows 2-7 of the first
          column, so each name sits on the SAME BAND as its row in the ranking — hover a name
          and the row it belongs to is directly across the card from it. The profile is one cell
          spanning all seven, the way the belt cell spans its block in the grid above: a single
          unit, so it owns no edge-to-edge rule of its own and has nothing to misalign with.

          Row heights are 1fr, so the six bands divide whatever height the profile needs. The
          selector divides itself into the same six, which is what keeps its dividers on the
          band boundaries without being told where they are. */}
      <div
        ref={frameRef}
        className={`grid overflow-hidden ${GRID}`}
        style={{
          background: "var(--xrio-surface)",
          border: "1px solid var(--xrio-border3)",
          borderRadius: "var(--xrio-r-surface)",
        }}
      >
        {/* The selector's own header band, so the rule down its right edge starts at the card's
            top edge rather than part way down it. */}
        <div
          className="hidden md:flex md:col-start-1 md:row-start-1 items-end border-r"
          style={{ ...RULE, padding: `11px 12px` }}
        >
          <span style={TICK}>COMPARE</span>
        </div>

        <div
          className="col-start-1 row-start-1 flex flex-col border-r md:row-start-2 md:row-span-6 md:border-t"
          style={RULE}
        >
          <Pill name="XRIO" on always />
          {VS.map((c, i) => (
            <Pill
              key={c.name}
              name={c.short}
              on={i === pick}
              onPick={() => {
                setPick(i);
              }}
            />
          ))}
        </div>

        {/* ── THE PROFILE, PART ONE ── the figure, spanning the header band and the first
            three scraper bands. Its own cell rather than a stack inside one, so the rule under
            it falls on a band boundary and carries straight on into the ranking. */}
        <div
          className="col-start-2 row-start-1 flex min-w-0 items-center md:row-span-4"
          style={{ padding: `12px ${PAD}` }}
        >
          <div className="w-full">
            <svg
              viewBox="0 6 340 230"
              className="w-full"
              style={{ display: "block", margin: "0 auto", maxWidth: 340 }}

              aria-label={`Xrio against ${vs.name}, across success, median, p95, retries and cost`}
            >
              {RINGS.map((v) => (
                <polygon
                  key={v}
                  points={ring(v)}
                  fill="none"
                  stroke={v === 100 ? "var(--xrio-border3)" : "var(--xrio-border)"}
                  strokeWidth={1}
                  opacity={k}
                />
              ))}
              {AXES.map((a, i) => {
                const [x, y] = vertex(i, 100);

                return (
                  <line
                    key={a.key}
                    x1={RAD.cx}
                    y1={RAD.cy}
                    x2={x}
                    y2={y}
                    stroke="var(--xrio-border)"
                    strokeWidth={1}
                    opacity={k}
                  />
                );
              })}

              {/* NOTHING IS FILLED. A fill — flat or hatched — is the heaviest mark on a diagram
                  this small, and six of them is a mess no ordering can rescue. Six thin outlines
                  can all be present because weight and opacity do the ordering instead: the
                  unselected sit back at a tenth of the page's ink — present, and no more than
                  that — the selected one comes forward in full, and Xrio is the only coloured
                  line on the grid. Drawn back to front, so the order of the DOM is the order of
                  importance. */}
              {VS.map((r, i) =>
                i === pick ? null : (
                  <polygon
                    key={r.name}
                    points={pts(RAW_VS[i], k)}
                    fill="none"
                    stroke="var(--xrio-fg)"
                    strokeWidth={1}
                    opacity={0.11 * k}
                  />
                ),
              )}
              {/* The selected outline is the one that MORPHS: it is the only shape whose
                  destination changes, so it is drawn from the tweened measurements while the
                  rest come straight from their runs. */}
              <polygon
                points={pts(vals, k)}
                fill="none"
                stroke="var(--xrio-fg)"
                strokeWidth={1.25}
              />
              <polygon
                points={pts(RAW_XRIO, k)}
                fill="none"
                stroke="var(--xrio-accent-fill)"
                strokeWidth={1.5}
                strokeLinejoin="miter"
              />
              {AXES.map((a, i) => {
                const [x, y] = vertex(i, reach(i, RAW_XRIO[i]) * k);

                return (
                  <circle
                    key={a.key}
                    cx={x}
                    cy={y}
                    r={2.2}
                    fill="var(--xrio-accent-fill)"
                    opacity={k}
                  />
                );
              })}

              {/* Axis labels, pushed past the outer ring and anchored by which side of the
                  pentagon they are on — a single text-anchor would hang the left-hand ones over
                  the shape. */}
              {AXES.map((a, i) => {
                const [x, y] = vertex(i, 126);
                const dx = x - RAD.cx;
                const lowerOffset = y > RAD.cy + 30 ? 12 : 4;
                const yOffset = y < RAD.cy - 30 ? -4 : lowerOffset;
                const leftAnchor = dx < -12 ? "end" : "middle";
                const anchor = dx > 12 ? "start" : leftAnchor;

                return (
                  <text
                    key={a.key}
                    x={x}
                    y={y + yOffset}
                    textAnchor={anchor}
                    style={{
                      ...MONO,
                      fill: "var(--xrio-ink-dim)",
                      fontSize: 9.5,
                      letterSpacing: ".1em",
                    }}
                  >
                    {a.key}
                  </text>
                );
              })}
            </svg>
          </div>
        </div>

        {/* ── THE PROFILE, PART TWO ── what a polygon cannot tell you, which is the actual
            numbers. Full width on a phone, where the figure's column has no measure to spare;
            under the figure at md. Its own rules are INSET inside the cell's padding — they are
            content, not grid, and nothing across the card is expected to meet them. */}
        <div
          className="col-start-1 col-span-2 row-start-2 flex min-w-0 flex-col justify-center border-t md:col-start-2 md:col-span-1 md:row-start-5 md:row-span-3"
          /* Tighter top and bottom than PAD. The bands are 1fr, so whichever of the two cells
             in this column wants more height sets the height of every ranking row across the
             card — and a readout breathing on PAD was pushing those rows to 89px for an 8px
             bar. At 14 the FIGURE is the binding constraint again, which is the right one. */
          style={{ ...RULE, padding: `14px ${PAD}` }}
        >
          <div>
            <div className={`${READOUT} border-b`} style={{ ...RULE, paddingBottom: 9 }}>
              {/* Named rather than left blank: the column under it is a list of measures, and a
                  wide empty cell heading a column reads as something missing. */}
              <span style={TICK}>MEASURE</span>
              <span className="flex items-center justify-end gap-1.5" style={TICK}>
                <Swatch color="var(--xrio-accent-fill)" /> XRIO
              </span>
              <span
                className="flex items-center justify-end gap-1.5"
                /* The one thing here that cannot be interpolated, so it fades in on the same
                   progress the numbers are travelling on. */
                style={{ ...TICK, opacity: 0.3 + 0.7 * prog }}
              >
                <Swatch color="var(--xrio-fg)" /> {vs.short}
              </span>
            </div>

            {AXES.map((a, i) => (
              <div
                key={a.key}
                className={`${READOUT} border-t`}
                style={{ ...RULE, borderTopWidth: i ? 1 : 0, padding: "8px 0" }}
              >
                <span
                  style={{
                    ...MONO,
                    color: "var(--xrio-fg2)",
                    fontSize: 11.5,
                    letterSpacing: ".06em",
                  }}
                >
                  {a.key}
                </span>
                <span
                  className="text-right"
                  style={{ ...MONO, color: "var(--xrio-fg)", fontSize: 12.5 }}
                >
                  {a.fmt(RAW_XRIO[i])}
                </span>
                <span
                  className="text-right"
                  style={{ ...MONO, color: "var(--xrio-fg-mid)", fontSize: 12.5 }}
                >
                  {a.fmt(vals[i])}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ── THE RANKING ── one cell per band, third column. */}
        <div
          className={`col-start-1 col-span-2 row-start-3 grid border-t md:col-start-3 md:col-span-1 md:row-start-1 md:items-end md:border-t-0 md:border-l ${COLS}`}
          style={{ ...RULE, columnGap: 16, padding: `11px ${PAD}` }}
        >
          <span className="hidden md:block" />
          <span className="flex items-center gap-5">
            <span className="flex items-center gap-2" style={TICK}>
              <Swatch color="var(--xrio-accent-fill)" /> RETRIEVED
            </span>
            <span className="flex items-center gap-2" style={TICK}>
              <Swatch color="var(--xrio-fg-dim)" /> BLOCKED
            </span>
          </span>
          {["SUCCESS", "MEDIAN", "P95"].map((h) => (
            <span key={h} className="hidden text-right md:block" style={TICK}>
              {h}
            </span>
          ))}
        </div>

        {RUNS.map((r, i) => {
          const lead = i === 0;
          const pct = got(r);

          return (
            <div
              key={r.name}
              className={`col-start-1 col-span-2 grid gap-y-3 border-t md:col-start-3 md:col-span-1 md:items-center md:border-l ${RANK_ROW[i]} ${COLS}`}
              style={{
                ...RULE,
                background: lead
                  ? "color-mix(in srgb, var(--xrio-accent-text) 8%, transparent)"
                  : undefined,
                columnGap: 16,
                padding: `11px ${PAD}`,
              }}
            >
              <span
                style={{
                  ...MONO,
                  color: lead ? "var(--xrio-accent-text)" : "var(--xrio-fg2)",
                  fontSize: 12,
                  letterSpacing: ".04em",
                }}
              >
                {r.name}
              </span>

              {/* The track is the 250. Two fills with 2px of surface between them, so the
                  boundary is a gap rather than a colour change — that is the edge the eye
                  measures the tail from.

                  Grown on the same clock as the radar, not by a CSS transition: a transition is
                  driven by the compositor and does not advance while the document is considered
                  hidden, which leaves the bars at zero rather than at their value. flex-basis
                  with 0 grow, because with grow on, two zero-basis fills would still split the
                  track and there would be nothing to grow FROM. */}
              <span
                className="flex overflow-hidden"
                style={{ gap: 2, height: 8 }}
                aria-hidden="true"
              >
                <span
                  style={{
                    background: "var(--xrio-accent-fill)",
                    borderRadius: 2,
                    flex: `0 1 ${pct * fill(i)}%`,
                  }}
                />
                <span
                  style={{
                    background: "var(--xrio-fg-dim)",
                    borderRadius: 2,
                    flex: `0 1 ${(100 - pct) * fill(i)}%`,
                  }}
                />
              </span>

              {/* md:contents drops this wrapper at desktop so the three figures become grid
                  cells in their own columns; on a phone it keeps them as one line under the
                  track, where there is no room for columns. */}
              <span className="flex gap-4 md:contents">
                <Figure label="GOT" lead={lead}>
                  {pct.toFixed(1)}%
                </Figure>
                <Figure label="MED" lead={lead}>
                  {r.p50.toFixed(1)}s
                </Figure>
                <Figure label="P95" lead={lead}>
                  {r.p95.toFixed(1)}s
                </Figure>
              </span>
            </div>
          );
        })}
      </div>

      <p
        className="mt-3"
        style={{ ...MONO, color: "var(--xrio-ink-dim)", fontSize: 10.5, letterSpacing: ".08em" }}
      >
        v0.9.1 · Tranco top 250 · 10 passes per site · residential exits, rotated per request
      </p>
    </section>
  );
};
