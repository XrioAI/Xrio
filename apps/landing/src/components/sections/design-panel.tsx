"use client";

import { useState, useEffect, useRef } from "react";

import { useBlackhole } from "@/context/blackhole-context";
import { useCorona } from "@/context/corona-context";
import type { CoronaKey } from "@/context/corona-context";
import { usePricingMode } from "@/context/pricing-mode-context";
import type { PricingModeKey } from "@/context/pricing-mode-context";

// ── Palette definitions ──────────────────────────────────────────────────────

type ThemeKey = "vellum" | "cyan" | "mono" | "monoLight" | "p1" | "p5";

/* Which palettes paint on light paper. Drives the light-only token fallbacks below and the
   [data-scheme] attribute that CSS keys its light-theme adaptations on, so those rules no
   longer have to name individual palettes. */
const LIGHT_THEMES: ReadonlySet<ThemeKey> = new Set<ThemeKey>(["vellum", "cyan", "monoLight"]);

/* ── THE PALETTE GRID ──
   Three families on two papers, which is what the set has actually been since Vellum and
   Cyanotype landed: Vellum IS Gilded on paper and Cyanotype IS Haze on ice — same hue, same
   button construction, re-weighted for the ground (see each theme's note below). The panel
   listed all five flat, so the two halves of a family read as unrelated palettes and the one
   axis a visitor actually wants to flip — dark or light — was buried in a five-item list.

   THEMES stays keyed by the original names rather than by family: globals.css addresses
   [data-palette="cyan"], the blackhole rebakes off the applied key, and the light-only token
   fallbacks are written per theme. This is a lookup on top of that, not a rename. */
type Family = "gold" | "blue" | "mono";

type Scheme = "dark" | "light";

const PALETTES: Record<Family, Record<Scheme, ThemeKey>> = {
  blue: { dark: "p1", light: "cyan" },
  gold: { dark: "p5", light: "vellum" },
  mono: { dark: "mono", light: "monoLight" },
};

const FAMILY_LABELS: Record<Family, string> = {
  blue: "Blue",
  gold: "Gold",
  mono: "Mono",
};

interface ThemeDef {
  bg: string;
  bgR: number;
  bgG: number;
  bgB: number;
  fg: [number, number, number];
  accent: string;
  glow: string;
  accent2: string;
  glow2: string;
  accentFg: string;
  /* The fill-only variant of the accent, for palettes where the colour that fills and the colour
     that marks cannot be the same (see --xrio-accent-fill). Defaults to accent. */
  accentFill?: string;
  /* Light themes only. Dark palettes derive these from fg-alpha overlays, which works because a
     translucent light ink over a dark canvas lifts. Over a light canvas the same overlay darkens
     instead, so Vellum supplies real opaque-ish values from the handoff's surface ladder. */
  accentHover?: string;
  surface?: string;
  tint?: string;
  /* The accent re-weighted to survive as running text, for palettes whose accent is a fill
     rather than an ink. Only Cyanotype needs one; everything else falls back to accentFg. */
  accentText?: string;
}

const THEMES: Record<ThemeKey, ThemeDef> = {
  /* Cyanotype is Haze on ice: Haze's own blue, its own button construction, moved onto a cold
     light ground instead of near-black.

     Paper is #E4F1F9 — cold ice, not paper. What made the earlier attempts read as "paper" was
     not lightness but neutrality: #F5F9FC had a blue-minus-red spread of only 7/255, so it was
     effectively white whatever its nominal hue. This has a spread of 21 at 94% lightness, which
     is what makes it read as ice rather than as stock that happens to be cool.

     Buttons follow Haze rather than inventing a scheme. Haze fills with its accent #87d2f2 and
     labels it with its near-black bg — a light chip carrying dark text. Both are kept verbatim:
     accent is #87d2f2 unchanged, and accentFg is the same near-black role (9.34:1 on the fill).
     An earlier pass had this inverted — dark fill, white label — which is why the live button
     read as disabled; a pale blue chip cannot.

     Borderless, like Haze. An earlier pass added an edge because the pale fill is only ~1.5:1
     against the ground; that edge was not Haze's and has been removed.

     accent2 keeps Haze's #9ba9bb for the same role Haze gives it. */
  cyan: {
    accent: "#87d2f2",
    accent2: "#9ba9bb",
    accentFg: "#08272F",
    accentHover: "#63BFE9",
    accentText: "#3C5A68",
    bg: "#EAF2F4",
    bgB: 244,
    bgG: 242,
    bgR: 234,
    fg: [18, 42, 54],
    glow: "rgba(135,210,242,0.20)",
    glow2: "rgba(155,169,187,0.22)",
    surface: "rgba(246,251,252,0.92)",
    tint: "rgba(135,210,242,0.26)",
  },
  mono: {
    accent: "#ffffff",
    accent2: "#e8e8e6",
    accentFg: "#050505",
    bg: "#050505",
    bgB: 5,
    bgG: 5,
    bgR: 5,
    fg: [255, 255, 255],
    glow: "rgba(255,255,255,0.14)",
    glow2: "rgba(232,232,230,0.12)",
  },
  /* Mono on paper, the mirror of the dark Mono below rather than a new palette. The other two
     families had to re-weight their accent when they crossed onto light — Vellum splits the
     brass into a mark and a fill, Cyanotype re-inks its pale blue — because both accents are
     CHROMATIC, and a hue bright enough to read as itself cannot also clear 4.5:1 as text on
     paper. Mono has no hue to preserve, so nothing splits here: #111 is the accent, the ink,
     and the button fill's opposite all at once, at 16.9:1 on this ground. No accentFill and no
     accentText for exactly that reason.

     Ground is #F2F2F2, not white. The surface ladder needs headroom above the page — a raised
     panel must read lighter than its canvas — and from pure white there is none; Vellum solves
     it the same way at #F1F2F3, and surface lifts to 250 from here just as Vellum's lifts to
     248 from 241. Neutral where Vellum is warm and Cyanotype is cold, which is the whole point
     of the family.

     accent2 is the #8a8a8a already in THEME_DOTS for dark Mono. On the light palettes accent2
     is a MATERIAL rather than an ink — Vellum's brass, Cyanotype's grey-blue — so a mid grey is
     the right register, and glow/glow2 are those two at the alphas their Vellum counterparts
     use. accentHover can only go one direction from an ink this dark, so it goes to black. */
  monoLight: {
    accent: "#111111",
    accent2: "#8a8a8a",
    accentFg: "#F2F2F2",
    accentHover: "#000000",
    bg: "#F2F2F2",
    bgB: 242,
    bgG: 242,
    bgR: 242,
    fg: [17, 17, 17],
    glow: "rgba(17,17,17,0.10)",
    glow2: "rgba(138,138,138,0.22)",
    surface: "rgba(250,250,250,0.92)",
    tint: "rgba(138,138,138,0.24)",
  },
  p1: {
    accent: "#87d2f2",
    accent2: "#9ba9bb",
    accentFg: "#071113",
    bg: "#071113",
    bgB: 19,
    bgG: 17,
    bgR: 7,
    fg: [255, 250, 254],
    glow: "rgba(135,210,242,0.17)",
    glow2: "rgba(155,169,187,0.17)",
  },
  p5: {
    accent: "#d3bd89",
    accent2: "#f5f5f0",
    accentFg: "#080808",
    bg: "#080808",
    bgB: 8,
    bgG: 8,
    bgR: 8,
    fg: [255, 255, 255],
    glow: "rgba(211,189,137,0.17)",
    glow2: "rgba(245,245,240,0.14)",
  },
  /* Vellum follows the handoff's two governing rules: one dark gold is the colour that WRITES
     (text, fills, links, focus, identity), and the heritage brass #D3BD89 is material only —
     1.9:1 on light surfaces, so it can tint and wash but must never carry text, icons, or borders.

     ONE HUE, TWO LIGHTNESSES. Both are on 89.4deg, the hue of the brass above, so the yellow is
     that brass saturated rather than a yellow imported from outside the palette:

       accent      #866C0E   the colour that marks — text, hairlines, focus rings, the slider's
                             1px thumb ring: anything whose job is to be legible against paper
       accentFill  #E3B710   the colour that fills — CTA, Run button, slider track and thumb,
                             the glow, and every canvas figure (blackhole, text stream, output
                             particles). One yellow for every area on the page.

     The split is forced, not stylistic. A single accent has to clear 4.5:1 as 10px text on this
     page, and that caps its luminance at Lab L~47 — every yellow held under that cap reads olive
     or brown, which is the whole of why the bronze this replaces looked brown. #866C0E is the
     BRIGHTEST colour on the brass hue that still survives as text (4.50:1 on the page, 4.75 on the
     features surface, 4.54 in the url well), and it is still not a yellow. Freed from having to
     carry text, accentFill goes to Lab L 74 and chroma 70 — against the bronze's 54 — and reads as
     an actual yellow. Its dark label measures 8.52:1. It settled between two cuts: #EDC000 (L 79,
     chroma 81) was too loud, #D8AE1F too muted. Dropping lightness alone kept it electric and
     headed for mustard — the small blue channel is what takes the edge off instead.

     The walk to here: #755718 -> #8B6A00 (measured, passing, still brown) -> #B58C00, which sits
     almost exactly halfway between paper and black and so failed BOTH ways at once (2.8:1 as text,
     3.0:1 under a cream label) -> #C29600, which works as a fill with dark text (5.9:1) but is
     2.5:1 as text. That last pair is the proof the roles had to separate.

     accentFg flips to the theme's own dark ink here. Cream on the yellow is 1.5:1; every other
     palette already uses a dark label on its accent, so this makes Vellum consistent rather than
     special. Requiring the fill to ALSO hold 3:1 against paper was tried and abandoned — it
     admits nothing brighter than #A58A00, which is the olive the split exists to escape. The
     CTA's inset hairline covers that boundary instead. */
  vellum: {
    accent: "#866C0E",
    accent2: "#D3BD89",
    accentFg: "#24201A",
    accentFill: "#E3B710",
    accentHover: "#6B5609",
    bg: "#F1F2F3",
    bgB: 243,
    bgG: 242,
    bgR: 241,
    fg: [36, 32, 26],
    glow: "rgba(227,183,16,0.14)",
    glow2: "rgba(211,189,137,0.35)",
    surface: "rgba(248,249,250,0.90)",
    tint: "rgba(211,189,137,0.22)",
  },
};

// Palette swatch dot colors
const THEME_DOTS: Record<ThemeKey, [string, string]> = {
  cyan: ["#EAF2F4", "#87d2f2"],
  mono: ["#ffffff", "#8a8a8a"],
  monoLight: ["#F2F2F2", "#8a8a8a"],
  p1: ["#87d2f2", "#9ba9bb"],
  p5: ["#d3bd89", "#f5f5f0"],
  vellum: ["#F1F2F3", "#D3BD89"],
};

// ── Font definitions ─────────────────────────────────────────────────────────

type FontKey = "grotesk" | "anta" | "fraunces";

const FONTS: Record<FontKey, { stack: string; weight: string }> = {
  anta: { stack: "var(--font-anta),system-ui,sans-serif", weight: "400" },
  fraunces: { stack: "var(--font-fraunces),Georgia,serif", weight: "600" },
  grotesk: { stack: "var(--font-space-grotesk),system-ui,sans-serif", weight: "700" },
};

const FONT_LABELS: Record<FontKey, string> = {
  anta: "Anta",
  fraunces: "Fraunces",
  grotesk: "Space Grotesk",
};

const PRICING_MODE_LABELS: Record<PricingModeKey, string> = {
  credits: "Credits",
  dollars: "Dollars",
};

const CORONA_LABELS: Record<CoronaKey, string> = {
  full: "Full",
  minimal: "Minimal",
  none: "None",
};

const FONT_PREVIEW_STYLES: Record<FontKey, React.CSSProperties> = {
  anta: { fontFamily: "'Anta',sans-serif", fontSize: 11, fontWeight: 400 },
  fraunces: { fontFamily: "var(--font-fraunces),Georgia,serif", fontSize: 11, fontWeight: 600 },
  grotesk: { fontFamily: "'Space Grotesk',sans-serif", fontSize: 11, fontWeight: 700 },
};

// ── applyTheme ───────────────────────────────────────────────────────────────

const applyTheme = (key: ThemeKey) => {
  const t = THEMES[key];
  const r = document.documentElement;
  const [fr, fg, fb] = t.fg;

  r.dataset.palette = key;
  /* Light-theme CSS adaptations key on this rather than on individual palette names, so adding
     another light palette is a one-line change to LIGHT_THEMES instead of an edit to every rule. */
  r.dataset.scheme = LIGHT_THEMES.has(key) ? "light" : "dark";
  r.style.setProperty("--xrio-bg", t.bg);
  r.style.setProperty("--xrio-bg-r", String(t.bgR));
  r.style.setProperty("--xrio-bg-g", String(t.bgG));
  r.style.setProperty("--xrio-bg-b", String(t.bgB));
  r.style.setProperty("--xrio-accent", t.accent);
  r.style.setProperty("--xrio-accent2", t.accent2);
  r.style.setProperty("--xrio-glow", t.glow);
  r.style.setProperty("--xrio-glow2", t.glow2);

  // Derived fg tokens
  r.style.setProperty("--xrio-fg", `rgb(${fr},${fg},${fb})`);
  r.style.setProperty("--xrio-fg2", `rgba(${fr},${fg},${fb},0.80)`);
  r.style.setProperty("--xrio-fg3", `rgba(${fr},${fg},${fb},0.22)`);
  r.style.setProperty("--xrio-fg4", `rgba(${fr},${fg},${fb},0.08)`);
  r.style.setProperty("--xrio-fg-hi", `rgba(${fr},${fg},${fb},0.90)`);
  r.style.setProperty("--xrio-fg-mid", `rgba(${fr},${fg},${fb},0.50)`);
  r.style.setProperty("--xrio-fg-dim", `rgba(${fr},${fg},${fb},0.35)`);
  r.style.setProperty("--xrio-fg-lo", `rgba(${fr},${fg},${fb},0.20)`);
  r.style.setProperty("--xrio-border", `rgba(${fr},${fg},${fb},0.07)`);
  r.style.setProperty("--xrio-border2", `rgba(${fr},${fg},${fb},0.13)`);
  r.style.setProperty("--xrio-border3", `rgba(${fr},${fg},${fb},0.16)`);
  r.style.setProperty("--xrio-border4", `rgba(${fr},${fg},${fb},0.32)`);
  /* Surfaces: a raised panel must read lighter than its canvas. On dark palettes the fg-alpha
     wash does that; on Vellum it would push panels darker than the page, inverting the depth
     model, so the theme's own value wins when present. */
  r.style.setProperty("--xrio-surface", t.surface ?? `rgba(${fr},${fg},${fb},0.03)`);
  r.style.setProperty("--xrio-tint", t.tint ?? `rgba(${fr},${fg},${fb},0.14)`);
  r.style.setProperty("--xrio-accent-fg", t.accentFg);
  r.style.setProperty("--xrio-accent-fill", t.accentFill ?? t.accent);
  /* Filled bronze controls darken on hover, never lighten and never via alpha — an alpha hover
     over a light parent bleaches the fill below AA under its own label. Dark palettes have no
     separate hover value, so they fall back to the accent itself (unchanged behavior). */
  r.style.setProperty("--xrio-accent-hover", t.accentHover ?? t.accent);
  /* Cyanotype's accent is a pale button fill that measures 1.6:1 as prose on its own ground, so
     running copy in "the accent" needs a separately-weighted ink there. Every other palette's
     accent is already an ink, hence the fallback to the accent itself — falling back to accentFg
     would paint a near-black label colour as body text on a near-black page. See the PRICING
     blocks in globals.css for what consumes this. */
  r.style.setProperty("--xrio-accent-text", t.accentText ?? t.accent);

  r.style.setProperty("--xrio-bg", t.bg);
  document.body.style.background = t.bg;
  document.body.style.color = `rgb(${fr},${fg},${fb})`;
};

// ── Component ────────────────────────────────────────────────────────────────

export const DesignPanel = () => {
  const [open, setOpen] = useState(false);
  const [family, setFamily] = useState<Family>("gold");
  const [scheme, setScheme] = useState<Scheme>("dark");
  const [activeFont, setActiveFont] = useState<FontKey>("grotesk");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const { shift, setShift, anchorY, setAnchorY, opacity, setOpacity, scale, setScale } =
    useBlackhole();

  const {
    gpuX,
    setGpuX,
    gpuY,
    setGpuY,
    gpuSize,
    setGpuSize,
    gpuPitch,
    setGpuPitch,
    gpuYaw,
    setGpuYaw,
    gpuRoll,
    setGpuRoll,
  } = useBlackhole();

  const { corona, setCorona } = useCorona();
  const { mode: pricingMode, setMode: setPricingMode } = usePricingMode();
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on outside click or Escape; move focus in on open, back to the
  // trigger on close, since this is a disclosure widget, not a static panel.
  useEffect((): ReturnType<React.EffectCallback> => {
    if (!open) {
      return;
    }

    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && panelRef.current && !panelRef.current.contains(e.target)) {
        setOpen(false);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };

    const trigger = triggerRef.current;

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();

    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [open]);

  /* One entry point for both controls: a family chip holds the scheme, the scheme switch holds
     the family. Either way the applied key is the grid cell they intersect at. */
  const handlePalette = (f: Family, s: Scheme) => {
    applyTheme(PALETTES[f][s]);
    setFamily(f);
    setScheme(s);
  };

  /* DISPLAY ONLY. Running text is Space Grotesk on every setting — this switch picks the
     headline face, not the page's typeface. It used to drive --xrio-body-font too, which
     meant choosing Anta or Fraunces reset the body copy as well, and neither is a reading
     face: Anta is single-weight 400 display geometry and Fraunces is a display serif. The
     token split was already there (body reads --xrio-body-font, every heading reads
     --xrio-display-font) — only this function crossed it. */
  const handleFont = (key: FontKey) => {
    const f = FONTS[key];
    const r = document.documentElement;
    r.style.setProperty("--xrio-display-font", f.stack);
    r.style.setProperty("--xrio-display-weight", f.weight);
    setActiveFont(key);
  };

  const familyKeys: Family[] = ["gold", "blue", "mono"];
  const fontKeys: FontKey[] = ["grotesk", "anta", "fraunces"];
  const coronaKeys: CoronaKey[] = ["none", "minimal", "full"];
  const pricingModeKeys: PricingModeKey[] = ["dollars", "credits"];

  return (
    <>
      {/* Tab label — always visible, click opens panel */}
      <button
        type="button"
        ref={triggerRef}
        aria-label="Open theme panel"
        aria-expanded={open}
        aria-controls="tp2-panel"
        onClick={() => {
          setOpen((o) => !o);
        }}
        style={{
          backdropFilter: "blur(12px)",
          background: "var(--xrio-frost)",
          border: "1px solid var(--xrio-border2)",
          borderRadius: "var(--xrio-r-control) 0 0 var(--xrio-r-control)",
          borderRight: "none",
          color: "var(--xrio-fg-mid)",
          cursor: "pointer",
          fontFamily: "var(--xrio-mono)",
          fontSize: 9,
          letterSpacing: "0.18em",
          lineHeight: 1,
          padding: "10px 10px",
          position: "fixed",
          right: 0,
          textTransform: "uppercase",
          top: "50%",
          transform: "translateY(-50%)",
          writingMode: "vertical-rl",
          zIndex: 601,
        }}
      >
        Theme
      </button>

      {/* Panel */}
      <div
        id="tp2-panel"
        ref={panelRef}
        className={open ? "open" : ""}
        aria-label="Theme settings"
        tabIndex={-1}
      >
        {/* Palette */}
        <div className="tp-section">
          <div className="tp-label-row">
            <span className="tp-label" id="tp-palette-label">
              Palette
            </span>
            {/* The scheme switch selects a DIMENSION of the palette rather than a palette, so it
                sits on the label's row instead of among the chips. */}
            <fieldset className="tp-scheme" aria-label="Color scheme">
              {(["dark", "light"] as const).map((s) => (
                <button
                  type="button"
                  key={s}
                  className={scheme === s ? "active" : ""}
                  aria-pressed={scheme === s}
                  onClick={() => {
                    handlePalette(family, s);
                  }}
                >
                  {s}
                </button>
              ))}
            </fieldset>
          </div>
          <div className="tp-themes">
            {familyKeys.map((key) => (
              <button
                type="button"
                key={key}
                className={`tp-theme-btn${family === key ? " active" : ""}`}
                /* Chrome follows the SCHEME, not the applied theme: all three chips select the
                   same paper, and a chip previews what it switches to. Dots resolve through the
                   grid for the same reason, so Gold shows brass-on-black in dark and
                   brass-on-cream in light. See the [data-theme-kind] rules in globals.css. */
                data-theme-kind={scheme}
                onClick={() => {
                  handlePalette(key, scheme);
                }}
              >
                <span className="tp2-dots">
                  <span style={{ background: THEME_DOTS[PALETTES[key][scheme]][0] }} />
                  <span style={{ background: THEME_DOTS[PALETTES[key][scheme]][1] }} />
                </span>
                {FAMILY_LABELS[key]}
              </button>
            ))}
          </div>
        </div>

        {/* Font */}
        <div className="tp-section" style={{ paddingTop: 20 }}>
          <span className="tp-label">Font</span>
          <div className="tp-themes">
            {fontKeys.map((key) => (
              <button
                type="button"
                key={key}
                className={`tp-theme-btn${activeFont === key ? " active" : ""}`}
                onClick={() => {
                  handleFont(key);
                }}
              >
                <span style={FONT_PREVIEW_STYLES[key]}>Aa</span>
                {FONT_LABELS[key]}
              </button>
            ))}
          </div>
        </div>

        {/* Pricing model — swaps the whole plans block between two competing
            structures. Content variant, not a visual one, so it sits outside
            Advanced where the render tweaks live. */}
        <div className="tp-section" style={{ paddingTop: 20 }}>
          <span className="tp-label">Pricing</span>
          <div className="tp-themes">
            {pricingModeKeys.map((key) => (
              <button
                type="button"
                key={key}
                className={`tp-theme-btn${pricingMode === key ? " active" : ""}`}
                onClick={() => {
                  setPricingMode(key);
                }}
              >
                {PRICING_MODE_LABELS[key]}
              </button>
            ))}
          </div>
        </div>

        {/* Advanced (Blackhole controls) */}
        <div className="tp-section" style={{ paddingTop: 20 }}>
          <button
            type="button"
            className="tp-advanced-toggle"
            onClick={() => {
              setAdvancedOpen((o) => !o);
            }}
            aria-expanded={advancedOpen}
          >
            <span>Advanced</span>
            <span className={`tp-advanced-arrow${advancedOpen ? " open" : ""}`}>▾</span>
          </button>
          {advancedOpen && (
            <div className="tp-advanced-body">
              <span className="tp-label">Blackhole</span>
              <div className="tp-slider-row">
                <div className="tp-slider-head">
                  <span>Position</span>
                  <span>{shift}</span>
                </div>
                <input
                  type="range"
                  className="tp-slider"
                  min={-100}
                  max={100}
                  step={1}
                  value={shift}
                  onChange={(e) => {
                    setShift(Number(e.target.value));
                  }}
                />
              </div>
              <div className="tp-slider-row">
                <div className="tp-slider-head">
                  <span>Anchor Y</span>
                  <span>{anchorY.toFixed(3)}</span>
                </div>
                <input
                  type="range"
                  className="tp-slider"
                  min={0.2}
                  max={0.85}
                  step={0.005}
                  value={anchorY}
                  onChange={(e) => {
                    setAnchorY(Number(e.target.value));
                  }}
                />
              </div>
              <div className="tp-slider-row">
                <div className="tp-slider-head">
                  <span>Opacity</span>
                  <span>{opacity.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  className="tp-slider"
                  min={0}
                  max={1}
                  step={0.01}
                  value={opacity}
                  onChange={(e) => {
                    setOpacity(Number(e.target.value));
                  }}
                />
              </div>
              <div className="tp-slider-row">
                <div className="tp-slider-head">
                  <span>Scale</span>
                  <span>{scale.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  className="tp-slider"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={scale}
                  onChange={(e) => {
                    setScale(Number(e.target.value));
                  }}
                />
              </div>

              {/* The four above drive the three.js BlackholeCanvas. These drive the WebGPU hero,
                  which is a different camera — separate controls rather than shared ones, so
                  tuning either leaves the other where it was. */}
              <span className="tp-label" style={{ paddingTop: 16 }}>
                Hero (GPU)
              </span>
              <div className="tp-slider-row">
                <div className="tp-slider-head">
                  <span>X</span>
                  <span>{gpuX.toFixed(0)}%</span>
                </div>
                <input
                  type="range"
                  className="tp-slider"
                  min={40}
                  max={120}
                  step={0.5}
                  value={gpuX}
                  onChange={(e) => {
                    setGpuX(Number(e.target.value));
                  }}
                />
              </div>
              <div className="tp-slider-row">
                <div className="tp-slider-head">
                  <span>Y</span>
                  <span>{gpuY.toFixed(0)}%</span>
                </div>
                <input
                  type="range"
                  className="tp-slider"
                  min={0}
                  max={100}
                  step={0.5}
                  value={gpuY}
                  onChange={(e) => {
                    setGpuY(Number(e.target.value));
                  }}
                />
              </div>
              <div className="tp-slider-row">
                <div className="tp-slider-head">
                  <span>Size</span>
                  <span>{gpuSize.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  className="tp-slider"
                  min={0.4}
                  max={2.5}
                  step={0.02}
                  value={gpuSize}
                  onChange={(e) => {
                    setGpuSize(Number(e.target.value));
                  }}
                />
              </div>
              {/* One per camera axis. X and Y move the camera, so they re-light the disk and
                  force a re-bake; Z only spins the picture and leaves the void where it is. */}
              <div className="tp-slider-row">
                <div className="tp-slider-head">
                  <span>Rot X (tilt)</span>
                  <span>{gpuPitch.toFixed(0)}&deg;</span>
                </div>
                <input
                  type="range"
                  className="tp-slider"
                  min={-75}
                  max={75}
                  step={1}
                  value={gpuPitch}
                  onChange={(e) => {
                    setGpuPitch(Number(e.target.value));
                  }}
                />
              </div>
              <div className="tp-slider-row">
                <div className="tp-slider-head">
                  <span>Rot Y (orbit)</span>
                  <span>{gpuYaw.toFixed(0)}&deg;</span>
                </div>
                <input
                  type="range"
                  className="tp-slider"
                  min={-180}
                  max={180}
                  step={1}
                  value={gpuYaw}
                  onChange={(e) => {
                    setGpuYaw(Number(e.target.value));
                  }}
                />
              </div>
              <div className="tp-slider-row">
                <div className="tp-slider-head">
                  <span>Rot Z (roll)</span>
                  <span>{gpuRoll.toFixed(0)}&deg;</span>
                </div>
                <input
                  type="range"
                  className="tp-slider"
                  min={-180}
                  max={180}
                  step={1}
                  value={gpuRoll}
                  onChange={(e) => {
                    setGpuRoll(Number(e.target.value));
                  }}
                />
              </div>

              <span className="tp-label" style={{ paddingTop: 16 }}>
                Corona
              </span>
              <div className="tp-themes">
                {coronaKeys.map((key) => (
                  <button
                    type="button"
                    key={key}
                    className={`tp-theme-btn${corona === key ? " active" : ""}`}
                    onClick={() => {
                      setCorona(key);
                    }}
                  >
                    {CORONA_LABELS[key]}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};
