"use client";

import { useRef, useEffect, useState } from "react";

import { hexToRgb } from "@/lib/utils";

const PILLS = ["json", "markdown", "xml", "yaml", "plain"] as const;

type Fmt = (typeof PILLS)[number];

/* One glyph per format. They are NOT sized by hand: a colon, a brace pair and a hash carry
   wildly different amounts of ink for the same em, which is what made the set look random —
   yaml a pair of boulders, json a modest squiggle. Each one is measured and then fitted to the
   same optical box below, so what stays constant is the shape on screen, not the point size. */
const GLYPH: Record<Fmt, string> = {
  json: "{ }",
  markdown: "#",
  plain: "Aa",
  xml: "<>",
  yaml: ":",
};

const displayFont = (): string =>
  getComputedStyle(document.documentElement).getPropertyValue("--xrio-display-font").trim() ||
  "'Space Grotesk', sans-serif";

/* Face only — the size comes from the fit. */
const FMT_FACE: Record<Fmt, (px: number) => string> = {
  json: (px) => `bold ${px}px ${displayFont()}`,
  markdown: (px) => `300 ${px}px ${displayFont()}`,
  plain: (px) => `bold ${px}px ${displayFont()}`,
  xml: (px) => `bold ${px}px 'IBM Plex Mono', monospace`,
  yaml: (px) => `bold ${px}px 'IBM Plex Mono', monospace`,
};

/* The box every glyph is fitted into, as a fraction of the field. The field is wide and
   short, so height is what binds — at 0.58 the glyph sat marooned in the middle of it. */
const FIT_H = 0.7;

const FIT_W = 0.56;

const sampleGlyph = (
  text: string,
  face: (px: number) => string,
  W: number,
  H: number,
  count: number,
): { tx: number; ty: number }[] => {
  const off = document.createElement("canvas");
  off.width = Math.round(W);
  off.height = Math.round(H);
  const c = off.getContext("2d");

  if (!c) {
    return Array.from({ length: count }, () => ({ tx: W / 2, ty: H / 2 }));
  }

  c.fillStyle = "#fff";
  c.textAlign = "left";
  c.textBaseline = "alphabetic";

  /* Measure the ink at a reference size, scale so it fills the fit box, then centre on the
     ink — not on the baseline and advance width, which sit wherever the face's metrics put
     them and would leave each glyph off-centre by a different amount. */
  const REF = 100;
  c.font = face(REF);
  const r = c.measureText(text);
  const refW = r.actualBoundingBoxLeft + r.actualBoundingBoxRight;
  const refH = r.actualBoundingBoxAscent + r.actualBoundingBoxDescent;

  const px = refW > 0 && refH > 0 ? REF * Math.min((W * FIT_W) / refW, (H * FIT_H) / refH) : REF;

  c.font = face(px);
  const m = c.measureText(text);
  c.fillText(
    text,
    W / 2 + (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2,
    H / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2,
  );

  const { data } = c.getImageData(0, 0, off.width, off.height);
  const pool: { tx: number; ty: number }[] = [];

  for (let y = 0; y < off.height; y += 1) {
    for (let x = 0; x < off.width; x += 1) {
      if (data[(y * off.width + x) * 4 + 3] > 80) {
        pool.push({ tx: x, ty: y });
      }
    }
  }

  if (!pool.length) {
    return Array.from({ length: count }, () => ({ tx: W / 2, ty: H / 2 }));
  }

  pool.sort((a, b) => a.ty - b.ty || a.tx - b.tx);
  const stride = pool.length / count;

  return Array.from({ length: count }, (_, i) => {
    const base = Math.floor(i * stride);
    const range = Math.floor(stride * 0.8);
    const p = pool[Math.min(pool.length - 1, base + Math.floor(Math.random() * range))];

    return { tx: p.tx, ty: p.ty };
  });
};

type CanvasHandle = HTMLCanvasElement & { _startCycle?: () => void };

/* canvas reads displayFmt every frame; setActive lets the timer update React state */
const ParticleCanvas = ({
  displayFmtRef,
  setActive,
  canvasRef,
  height = 380,
}: {
  height?: number | string;
  displayFmtRef: React.RefObject<Fmt>;
  setActive: (f: Fmt) => void;
  canvasRef: React.RefObject<CanvasHandle | null>;
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect((): ReturnType<React.EffectCallback> => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;

    if (!canvas || !wrap) {
      return;
    }

    const ctx = canvas.getContext("2d");

    if (!ctx) {
      return;
    }

    const N = 600;
    const RAMP_MS = 850;

    let H = 0;
    let W = 0;
    let dpr = 1;
    let fmtRaf = 0;
    let lastTs = 0;

    let currentFmt: Fmt = "json";
    let transitionStart = 0;

    interface Pt {
      x: number;
      y: number;
      ox: number;
      oy: number;
      tx: number;
      ty: number;
      r: number;
      op: number;
      tint: number;
    }

    let pts: Pt[] = [];

    const seed = () => {
      pts = Array.from({ length: N }, () => {
        const roll = Math.random();
        let tint = 0;

        if (roll < 0.06) {
          tint = 1;
        } else if (roll < 0.08) {
          tint = 2;
        }

        const x = Math.random() * W;
        const y = Math.random() * H;

        return {
          op: 0.35 + Math.random() * 0.45,
          ox: x,
          oy: y,
          r: 0.6 + Math.random() * 0.6,
          tint,
          tx: W / 2,
          ty: H / 2,
          x,
          y,
        };
      });
    };

    const applyTargets = (targets: { tx: number; ty: number }[]) => {
      const shuffled = targets.toSorted(() => Math.random() - 0.5);

      for (const [i, p] of pts.entries()) {
        p.ox = p.x;
        p.oy = p.y;
        p.tx = shuffled[i].tx;
        p.ty = shuffled[i].ty;
      }
    };

    const applyFmt = (key: Fmt) => {
      currentFmt = key;
      transitionStart = lastTs || performance.now();
      applyTargets(sampleGlyph(GLYPH[key], FMT_FACE[key], W, H, N));
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1);
      W = wrap.offsetWidth;
      H = wrap.offsetHeight || 380;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (!pts.length) {
        seed();
      }

      /* wrap can report 0 width for a frame before layout settles (seen on
         narrow viewports); sampleGlyph's getImageData throws on a 0-width
         canvas, so skip this pass and let the next resize event retry. */
      if (W > 0 && H > 0) {
        applyFmt(currentFmt);
      }
    };

    const moveParticle = (p: Pt, elapsed: number) => {
      /* per-particle stagger so the move doesn't read as one robotic lockstep */
      const localT = Math.min(1, Math.max(0, (elapsed - p.op * 120) / RAMP_MS));
      /* single continuous ease: medium start, fast middle, long slow tail — no seam/stutter */
      let eased = 0;

      if (localT >= 1) {
        eased = 1;
      } else if (localT > 0) {
        const ta = localT ** 1.8;
        const tb = (1 - localT) ** 3.5;
        eased = ta / (ta + tb);
      }

      p.x = p.ox + (p.tx - p.ox) * eased;
      p.y = p.oy + (p.ty - p.oy) * eased;
    };

    const frame = (ts: number) => {
      lastTs = ts;
      const cs = getComputedStyle(document.documentElement);
      const bgR = cs.getPropertyValue("--xrio-bg-r").trim() || "0";
      const bgG = cs.getPropertyValue("--xrio-bg-g").trim() || "0";
      const bgB = cs.getPropertyValue("--xrio-bg-b").trim() || "0";
      /* Cleared, not filled. Painting the page background made the canvas a dark rectangle
         the moment it sat on anything other than the page — a cell, a card. Transparent means
         it always takes whatever is behind it. The bg values below are still read: they pick
         the particle colour, which does follow the palette. */
      ctx.clearRect(0, 0, W, H);
      const accRgb = hexToRgb(cs.getPropertyValue("--xrio-accent-fill").trim() || "#3B82F6");
      const acc2Rgb = hexToRgb(cs.getPropertyValue("--xrio-accent2").trim() || "#F59E0B");

      const bgLuma = 0.2126 * Number(bgR) + 0.7152 * Number(bgG) + 0.0722 * Number(bgB);

      const isLight = bgLuma > 127;
      /* Dominant particle colour: the inverted background, on every palette.

         This used to be inverted-bg on dark themes but a palette token on light ones, and that
         asymmetry is what made the field look absent on Vellum and Cyanotype. The numbers: a
         particle draws at alpha 0.35..0.80, which for inverted-bg on near-black composites to
         2.9:1..10.9:1 — clearly visible. The same particle in accent2 on a light ground reaches
         only 1.2:1..1.8:1, about a seventh of the contrast, because a pale dot subtracts far
         less from paper than a light dot adds to black. No alpha boost rescues that; the ceiling
         is the token. Inverting the background instead gives light themes 2.3:1..9.8:1, which
         lines up with the dark themes almost exactly.

         Dark themes compute identically to before — for them this line is unchanged. */
      const fgRgb = `${255 - Number(bgR)},${255 - Number(bgG)},${255 - Number(bgB)}`;
      /* The 6% rare tint stays the accent everywhere: it is the sparkle that punctuates the
         field, and it keeps the flip — dominant is the neutral ink, accent is the rare one. */
      const rareRgb = accRgb;
      /* With the dominant now inverted-bg the contrast is carried by the colour, so this is only
         a small size lift: dpr is capped at 1 across every canvas in the app (a deliberate cost
         choice — see StarfieldCanvas/DataStream/Blackhole), which leaves the smallest particles
         sub-pixel at r=0.6 and prone to dissolving on a light ground where there is no bloom to
         catch the eye. 1.2x puts the floor just above a whole pixel. Alpha is left alone.
         Dark themes keep 1/1 and are unchanged. */
      const opBoost = 1;
      const rBoost = isLight ? 1.2 : 1;

      const elapsed = ts - transitionStart;

      for (const p of pts) {
        moveParticle(p, elapsed);

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * rBoost, 0, Math.PI * 2);
        const rgb = [fgRgb, rareRgb, acc2Rgb][p.tint];
        ctx.fillStyle = `rgba(${rgb},${Math.min(1, p.op * opBoost).toFixed(2)})`;
        ctx.fill();
      }

      const nextFmt = displayFmtRef.current;

      if (nextFmt !== currentFmt) {
        applyFmt(nextFmt);
      }

      fmtRaf = requestAnimationFrame(frame);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          lastTs = 0;
          fmtRaf = requestAnimationFrame(frame);
        } else {
          cancelAnimationFrame(fmtRaf);
        }
      },
      { threshold: 0.01 },
    );

    observer.observe(wrap);

    const onResize = () => {
      cancelAnimationFrame(fmtRaf);
      resize();
    };

    window.addEventListener("resize", onResize);
    /* resize() already applies currentFmt ("json") once it has real
       dimensions — a second unconditional applyFmt("json") here just
       redid the same sampleGlyph work a moment later. */
    resize();

    const FMT_KEYS = [...PILLS];

    /* single timer — always cycles from displayFmtRef.current (so hover/click are already baked in) */
    let cycleTimer: ReturnType<typeof setInterval> | undefined;

    const startCycle = () => {
      clearInterval(cycleTimer);
      cycleTimer = setInterval(() => {
        const next = FMT_KEYS[(FMT_KEYS.indexOf(displayFmtRef.current) + 1) % FMT_KEYS.length];
        displayFmtRef.current = next;
        setActive(next);
      }, 5000);
    };

    startCycle();

    /* expose startCycle so hover/click can reset the 5s timer */
    canvas._startCycle = startCycle;

    return () => {
      cancelAnimationFrame(fmtRaf);
      clearInterval(cycleTimer);
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [canvasRef, displayFmtRef, setActive]);

  return (
    <div ref={wrapRef} className="relative w-full overflow-hidden" style={{ height }}>
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 w-full h-full" />
      {/* fmt-label overlay — bottom right, like the HTML */}
      <span
        aria-hidden="true"
        style={{
          bottom: 18,
          color: "var(--xrio-fg-lo)",
          fontFamily: "var(--xrio-mono)",
          fontSize: 9,
          letterSpacing: ".2em",
          pointerEvents: "none",
          position: "absolute",
          right: 0,
          textTransform: "uppercase",
        }}
        id="fmt-label"
      />
    </div>
  );
};

/* The morphing glyph and its pills. One component, because the two share a ref and handing
   refs around in an object is what react-hooks/refs exists to stop.

   `flush` pushes the pill row out through the host cell's padding and onto its bottom edge, so
   the formats read as another row of the grid's rails rather than as five chips floating inside
   a cell. The host sets --cell-pad; nothing else here needs to know the number. */
export const FormatMorph = ({
  height,
  flush = false,
}: {
  height?: number | string;
  flush?: boolean;
}) => {
  const [activeFmt, setActiveFmt] = useState<Fmt>("json");
  const displayFmt = useRef<Fmt>("json");
  const canvasRef = useRef<CanvasHandle>(null);

  const pick = (fmt: Fmt) => {
    displayFmt.current = fmt;
    setActiveFmt(fmt);
    /* reset the 5s cycle from this format */
    canvasRef.current?._startCycle?.();
  };

  return (
    <div className="flex h-full flex-col">
      {/* A real height on a phone, the cell's slack at md+. The cell has no height of its own
          below md, so flex-1 alone resolved to nothing and the renderer painted its last known
          size straight over the cell underneath.

          NO FLOOR AT md+. A min-height here is a height the cell may not have to give: when it
          exceeds the slack the overflow lands on the pill row, which is pinned to the bottom
          edge and gets clipped by the block. Let flex-1 take whatever is left, whatever that is. */}
      <div
        className={flush ? "h-[200px] md:h-auto md:flex-1 md:min-h-0" : undefined}
        /* 26 to match the gap the host cell puts above it — the pill row sits flush on the
           cell's bottom edge, so nothing else was holding the field off its rule. */
        style={flush ? { marginBottom: 26 } : undefined}
      >
        <ParticleCanvas
          displayFmtRef={displayFmt}
          setActive={setActiveFmt}
          canvasRef={canvasRef}
          height={height}
        />
      </div>

      {flush ? (
        <div
          className="mt-auto grid grid-cols-5"
          style={{
            borderTop: "1px solid var(--xrio-border)",
            marginBottom: "calc(-1 * var(--cell-pad))",
            marginLeft: "calc(-1 * var(--cell-pad))",
            marginRight: "calc(-1 * var(--cell-pad))",
          }}
        >
          {PILLS.map((fmt, i) => (
            <button
              key={fmt}
              type="button"
              onMouseEnter={() => {
                pick(fmt);
              }}
              onClick={() => {
                pick(fmt);
              }}
              style={{
                background: activeFmt === fmt ? "var(--xrio-well)" : "transparent",
                borderLeft: i === 0 ? "none" : "1px solid var(--xrio-border)",
                color: activeFmt === fmt ? "var(--xrio-fg)" : "var(--xrio-ink-dim)",
                cursor: "pointer",
                fontFamily: "var(--xrio-mono)",
                fontSize: 10,
                letterSpacing: ".1em",
                padding: "13px 2px",
                textTransform: "uppercase",
              }}
            >
              {fmt}
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2 justify-center">
          {PILLS.map((fmt) => (
            <button
              key={fmt}
              type="button"
              onMouseEnter={() => {
                pick(fmt);
              }}
              onClick={() => {
                pick(fmt);
              }}
              className="text-[11px] px-[14px] py-[6px] rounded-sm transition-all"
              style={{
                background: activeFmt === fmt ? "var(--xrio-fg4)" : "transparent",
                border: `1px solid ${activeFmt === fmt ? "var(--xrio-accent)" : "var(--xrio-border2)"}`,
                color: activeFmt === fmt ? "var(--xrio-fg)" : "var(--xrio-fg2)",
                fontFamily: "var(--xrio-mono)",
              }}
            >
              {fmt === "plain" ? "Plain text" : fmt.toUpperCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
