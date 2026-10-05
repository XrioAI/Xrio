"use client";

import { useEffect, useRef } from "react";

import { Terminal } from "./agent-hookup";
import type { Cmd } from "./agent-hookup";
import { AGENT_LOGOS } from "./agent-logos";
import { GauntletRail } from "./gauntlet";
import { FormatMorph } from "./output-formats";
import { PatchMarquee } from "./patch-count";

declare module "react" {
  interface CSSProperties {
    "--cell-pad"?: string;
    "--belt-row"?: string;
  }
}

/* One block, eight features, on shared hairlines. Three rows, and two of them put a stack of
   two cells beside one tall one — which is where the asymmetry comes from, not from cells of
   random size.

   ONE PICTURE PER ROW. Two live things in a row fight each other and the row stops reading as
   two features. The belt, the patch column, the format glyph and the command card each get a
   row to themselves; the marks beside them are 40px line glyphs, deliberately quiet, in the
   same stroked hand as the rest of the page.

   And nothing is invented: a cell either runs a composition this page already owns, or it is
   text with a mark. */

/* One label, one command, per row. The MCP/CLI toggle belongs in the agent band, where the
   card has a header to hold it; here it was a control tucked inside a list. */
const MCP: Cmd[] = [{ line: "npx -y xrio-cli@latest mcp add", tab: "MCP" }];

const SKILL: Cmd[] = [{ line: "curl -s xrio.com/agent/SKILL.md", tab: "Skill" }];

/* The belt sets the tallest row in the block and the closing row matches it, so the grid
   opens and closes on the same measure. The two live in separate flex bands, so no selector
   can tie one's height to the other's — the belt is measured and its height written onto the
   closing band as --row. This is the value before hydration and whenever the copy has not
   moved; it is a starting point, not the contract. */
/* 326 of cell + the band's own 1px rule */
const BELT_ROW = 327;

const PAD = "clamp(22px, 2.6vw, 30px)";

const TINT = "color-mix(in srgb, var(--xrio-accent-text) 8%, transparent)";

const RULE = { borderColor: "var(--xrio-border)" };

/* 1.2 rather than the page's hairline: these render at 34px off a 40 viewBox, and a 1px
   stroke scaled down that far goes to three quarters of a pixel and greys out. */
const S = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeWidth: 1.2,
};

/* The marks are the accent. Four of them, one per text cell, and nothing else in the
   block is coloured — so they read as a set rather than as decoration. */
const ICON = { color: "var(--xrio-accent-text)" };

const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 40 40" width={34} height={34} style={ICON} aria-hidden="true">
    {children}
  </svg>
);

/* Semantic — a page with one line lifted out of it. */
const Extract = (
  <Icon>
    <path {...S} d="M10 7h13l7 7v19H10z" />
    <path {...S} d="M23 7v7h7" />
    <path {...S} d="M14 21h12M14 26h8" />
    <path {...S} strokeWidth={2.4} d="M14 21h12" stroke="var(--xrio-fg)" />
  </Icon>
);

/* Logs — a run of records, longest first. */
const Trace = (
  <Icon>
    <path {...S} strokeWidth={2} d="M8 11h24M8 17h17M8 23h21M8 29h13" />
  </Icon>
);

const Magnifier = (
  <Icon>
    <circle {...S} cx="18" cy="18" r="9.5" />
    <path {...S} d="M25 25 32.5 32.5" />
  </Icon>
);

const Profile = (
  <Icon>
    <circle {...S} cx="20" cy="15" r="6.5" />
    <path {...S} d="M8 34a12 12 0 0 1 24 0" />
  </Icon>
);

const Cell = ({
  className = "",
  align = "left",
  columns,
  icon,
  title,
  body,
  tint = false,
  fill = false,
  children,
}: {
  className?: string;
  align?: "left" | "right";
  /* A second column down the right of the cell — the agents this plugs into. */
  columns?: React.ReactElement;
  icon?: React.ReactElement;
  title: string;
  body?: string;
  tint?: boolean;
  /* Let the body take the cell's slack instead of leaving it under the content. md and up
     only: stacked on a phone the cell has no height to give, and a basis-0 child of an
     auto-height column resolves to nothing. */
  fill?: boolean;
  children?: React.ReactNode;
}) => {
  /* The title is its own line rather than a bold run inside the sentence. Set inline it was
     the same size as the copy and read as emphasis; on its own it reads as a name.

     The mark sits BESIDE the text, not over it. Above the title it cost every cell 50px of
     height for a 34px glyph, which is what made the middle of the block tall and loose. */
  const words = (
    <>
      <h3
        style={{
          color: tint ? "var(--xrio-accent-text)" : "var(--xrio-fg)",
          fontSize: 17.5,
          fontWeight: 600,
          letterSpacing: "-.022em",
          lineHeight: 1.3,
        }}
      >
        {title}
      </h3>
      {Boolean(body) && (
        <p
          style={{
            color: "var(--xrio-fg2)",
            fontSize: 13.5,
            lineHeight: 1.7,
            /* None in the two-column cell: there the paragraph is a distributed block in
               its own right and the column sets the gap. The one-picture cells keep the
               caption tight under the title. */
            marginTop: columns === undefined ? 10 : 0,
          }}
        >
          {body}
        </p>
      )}
    </>
  );

  const copy = (
    <div style={align === "right" ? { textAlign: "right" } : undefined}>
      {icon === undefined ? (
        words
      ) : (
        <div className="flex items-center gap-4">
          <div className="shrink-0">{icon}</div>
          <div className="min-w-0">{words}</div>
        </div>
      )}
    </div>
  );

  return (
    <div
      className={`flex flex-col ${className}`}
      style={{
        ...RULE,
        "--cell-pad": PAD,
        background: tint ? TINT : undefined,
        padding: PAD,
      }}
    >
      {columns === undefined ? (
        <>
          {copy}
          {Boolean(children) && (
            <div
              className={fill ? "md:flex md:min-h-0 md:flex-1 md:basis-0 md:flex-col" : undefined}
              style={{ marginTop: 26 }}
            >
              {children}
            </div>
          )}
        </>
      ) : (
        /* Two equal columns, so the gutter falls on the cell's centre — which is where the
           rule between the locale cell and the patch column lands in the band above. An uneven split
           gives the commands more measure but puts this division out of the grid. */
        <div className="grid flex-1 gap-10 md:grid-cols-2 md:gap-12">
          {/* Three blocks — title, subtext, bars — spread down the column by
              justify-between, so the two gaps are equal and the bars land on the bottom
              edge. `words` rather than `copy`: the fragment puts the heading and the
              paragraph in the column as separate items instead of one welded unit.
              gap-y-6 is only a floor for the widths where the copy wraps far enough to
              eat the slack. */}
          <div className="flex min-w-0 flex-col justify-between gap-y-6">
            {words}
            {children}
          </div>
          <div className="min-w-0">{columns}</div>
        </div>
      )}
    </div>
  );
};

/* Marks only, three across. Set in the copy's ink rather than each brand's own colour: six
   brand colours inside one cell would be the loudest thing in the section, and this cell is
   already the only coloured one.

   The name under each was doing nothing a logo does not already do, and it forced the marks
   down to 20px to make room for it. Without them they can be read at a glance. */
const AGENTS = (
  <ul className="grid h-full grid-cols-3 content-center justify-items-center gap-y-11">
    {AGENT_LOGOS.map(({ name, d }) => (
      <li key={name}>
        <svg viewBox="0 0 24 24" width={34} height={34} fill="var(--xrio-fg2)" aria-label={name}>
          <title>{name}</title>
          <path d={d} />
        </svg>
      </li>
    ))}
  </ul>
);

export const FeatureGrid = () => {
  const beltRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLDivElement>(null);

  useEffect((): ReturnType<React.EffectCallback> => {
    const belt = beltRef.current;
    const close = closeRef.current;

    if (!belt || !close) {
      return;
    }

    /* +1 for the closing band's own top rule: the floor is set on the band, the match is
       wanted on the cells inside it. */
    const ro = new ResizeObserver(() => {
      close.style.setProperty("--row", `${belt.getBoundingClientRect().height + 1}px`);
    });

    ro.observe(belt);

    return () => {
      ro.disconnect();
    };
  }, []);

  return (
    <div style={{ padding: "clamp(48px, 8vw, 96px) clamp(24px, 6vw, 72px)" }}>
      <div
        className="overflow-hidden"
        style={{
          background: "var(--xrio-surface)",
          border: "1px solid var(--xrio-border3)",
          borderRadius: "var(--xrio-r-surface)",
        }}
      >
        {/* Band 1 — the belt over a block of four, with the patch column running the full
            height of both beside them. It is the only vertical thing in the section, so it
            gets the one column that is taller than it is wide. */}
        <div className="flex flex-col md:flex-row">
          <div className="md:w-2/3 flex flex-col">
            <div ref={beltRef} className="flex flex-col">
              <Cell
                title="Pages that need a real browser."
                body="Modern, JavaScript-heavy sites render in a full Chromium, so your agent reads the page a visitor would see."
              >
                <GauntletRail />
              </Cell>
            </div>

            <div className="grid border-t md:grid-cols-2 md:auto-rows-fr" style={RULE}>
              <Cell
                icon={Magnifier}
                title="Search built in."
                body="Give it a query instead of a URL. Xrio runs the search and returns the matching links."
              />
              <Cell
                className="border-t md:border-t-0 md:border-l"
                icon={Profile}
                title="Locale-matched browsers."
                body="Each browser profile is fully configured — fonts, WebGL, canvas, audio, voices — and matched to the locale of your proxy."
              />
              <Cell
                className="border-t"
                icon={Extract}
                title="Semantic scraping."
                body="Ask a page a question and get a structured answer back, instead of raw HTML to parse."
              />
              <Cell
                className="border-t md:border-l"
                icon={Trace}
                title="Logs and traces."
                body="Every request is logged — proxy, session, and what came back — and can be replayed."
              />
            </div>
          </div>

          <Cell
            className="md:w-1/3 border-t md:border-t-0 md:border-l"
            fill
            align="right"
            title="C++ patches to Chromium."
            body="Applied in the engine itself, so every setting a page reads is consistent and correctly configured."
          >
            <PatchMarquee fill align="right" />
          </Cell>
        </div>

        {/* Band 2 — the format cell is one search cell wide, so its right edge lands on the
            rule between search and the locale cell above it. Its pills are flush on the bottom border,
            divided like everything else here. */}
        <div
          ref={closeRef}
          className="flex flex-col border-t md:min-h-[var(--row,var(--belt-row))] md:flex-row"
          style={{ ...RULE, "--belt-row": `${BELT_ROW}px` }}
        >
          <Cell
            className="md:w-1/3"
            fill
            title="Any format."
            body="HTML, markdown or JSON, converted on the way out."
          >
            <FormatMorph flush height="100%" />
          </Cell>

          <Cell
            className="md:w-2/3 border-t md:border-t-0 md:border-l"
            tint
            title="Any agent, no account."
            body="Connect through an MCP server or a one-file skill. Either way your agent gets a real browser, with no account needed."
            columns={AGENTS}
          >
            <div className="flex flex-col gap-3">
              <Terminal cmds={MCP} variant="line" />
              <Terminal cmds={SKILL} variant="line" />
            </div>
          </Cell>
        </div>
      </div>
    </div>
  );
};
