"use client";

import * as React from "react";

import { readBrass } from "@/lib/brass";
import { cn } from "@/lib/utils";

/**
 * The closing mark, captured — ported from proxidize/px-scraper's sign-in aside
 * (`components/auth/macaw-figure.tsx`, on its feat/workos-auth branch, not yet on main):
 * the same mark's alpha channel sampled into a halftone of brass dots, with a scan
 * hairline sweeping down once to print the bird in.
 *
 * Trimmed for KISS rather than ported whole: the source figure also blinks the eye on a
 * timer and rolls an idle ruffle wave through the feathers. Neither survives here — both
 * are ambient life a fixed sign-in aside can afford and a mark at the bottom of a long
 * scroll can't justify. What's kept, alongside the halftone sampling and the sweep: the
 * cursor spring (dots repel from the pointer and spring back home) and the click-to-reburst
 * — the one joke this figure gets to make, replaying the whole print-in. Cost-wise this is
 * a home-pull spring plus one distance check per dot per frame, same order of cost as the
 * shimmer it sits beside; at ~1k dots on the largest render size that's nothing at 60fps.
 *
 * The first sweep is armed by IntersectionObserver, not mount: this section is the last
 * thing on the page, so firing on mount would mean it plays out unseen above the fold
 * before anyone scrolls down. After that it repeats on its own timer — a bare hairline
 * pass over dots that are already fully printed, not a re-fade — every REPEAT_MS, so the
 * mark doesn't go dead still once the arrival is over.
 *
 * Canvas 2D, no dependencies, same size class as this site's other ported figures
 * (BlackholeFigure). Under `prefers-reduced-motion` the mark prints once, settled and
 * static, ticks already closed — the sweep (first pass and every repeat) is removed
 * entirely, not frozen.
 */

const MARK_SRC = "/logo-macaw-mark.png";

/** CSS px between dot centres. Finer than the source's aside figure (5px) since this
    mark's smallest render size (72px) is also smaller. */
const PITCH = 4;

/** Sampled alpha below this is background, not bird. */
const ALPHA_FLOOR = 0.16;

const SWEEP_MS = 1200;

const SPAWN_MS = 340;

/** How often the idle hairline passes once the mark has printed. */
const REPEAT_MS = 8000;

/** How long a click's scatter takes to fade before the reprint sweep restarts. */
const BURST_MS = 320;

interface Dot {
  /** Home position — where the sampled mark actually is. */
  hx: number;
  hy: number;
  /** Current position, displaced by the cursor spring or a burst impulse. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  a: number;
  phase: number;
  glint: boolean;
  spawnedAt: number;
}

interface Rig {
  dots: Dot[];
  /** Whether the mark has fully printed at least once — once true, a sweep is purely the
      decorative hairline; dots stay at full settled alpha throughout it. */
  printed: boolean;
  /** Start time of the sweep currently animating, or null when none is active. */
  sweepAt: number | null;
  /** When the next idle sweep should start (only consulted once printed). */
  nextSweepAt: number;
  /** Start time of an active click-scatter, or null when none is active. */
  burstAt: number | null;
  /** Pointer position in the canvas's own CSS px space, or null off the figure. */
  mouse: { x: number; y: number } | null;
  fx: number;
  fy: number;
  fw: number;
  fh: number;
  brassCss: string;
}

const easeInOutCubic = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

const easeOutCubic = (p: number) => 1 - (1 - p) ** 3;

/** Sample the mark into a dot grid for a figure of the given CSS box. Drawing the image
    at one pixel per grid cell makes the browser do the area-averaging, so a cell's alpha
    is already the mean of what it covers. */
const sampleDots = (
  img: HTMLImageElement,
  fw: number,
  fh: number,
  fx: number,
  fy: number,
): Dot[] => {
  const cols = Math.max(1, Math.round(fw / PITCH));
  const rows = Math.max(1, Math.round(fh / PITCH));
  const off = document.createElement("canvas");
  off.width = cols;
  off.height = rows;
  const octx = off.getContext("2d", { willReadFrequently: true });

  if (!octx) {
    return [];
  }

  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(img, 0, 0, cols, rows);
  const { data } = octx.getImageData(0, 0, cols, rows);

  const dots: Dot[] = [];
  const maxR = PITCH * 0.42;

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cell = data[(row * cols + col) * 4 + 3] / 255;

      if (cell < ALPHA_FLOOR) {
        continue;
      }

      const u = (col + 0.5) / cols;
      const v = (row + 0.5) / rows;
      const jitter = Math.random();
      const hx = fx + u * fw;
      const hy = fy + v * fh;
      dots.push({
        a: (0.62 + 0.38 * cell) * (0.8 + 0.2 * jitter),
        glint: Math.random() < 0.03,
        hx,
        hy,
        phase: Math.random() * Math.PI * 2,
        r: maxR * (0.55 + 0.45 * cell) * (0.85 + 0.15 * jitter),
        spawnedAt: -1,
        vx: 0,
        vy: 0,
        x: hx,
        y: hy,
      });
    }
  }

  return dots;
};

const drawDot = (ctx: CanvasRenderingContext2D, d: Dot, rig: Rig, t: number, dt: number) => {
  const { burstAt, mouse } = rig;
  const bursting = burstAt !== null;
  const burstP = burstAt === null ? 0 : (t - burstAt) / BURST_MS;

  if (d.spawnedAt < 0) {
    return;
  }

  // Home-pull spring plus damping; the cursor adds a short-range repel on top. Springs
  // first, forces after, so the home pull is what makes every disturbance temporary.
  //
  // Damping (not the spring constant) is what was raised here: how far a dot gets
  // pushed is purely a function of the 110 spring constant against the repel force
  // below, and that was already fine. Overdamping the return — 50 against a critical
  // damping of ~21 — leaves that push distance untouched but stretches the glide home
  // from ~0.6s to ~2s, with no bounce (still monotonic, just slower).
  let ax = -110 * (d.x - d.hx) - 50 * d.vx;
  let ay = -110 * (d.y - d.hy) - 50 * d.vy;

  if (mouse && !bursting) {
    const mdx = d.x - mouse.x;
    const mdy = d.y - mouse.y;
    const md = Math.hypot(mdx, mdy);

    if (md < 120 && md > 0.001) {
      const f = 3200 * (1 - md / 120) ** 2;
      ax += (mdx / md) * f;
      ay += (mdy / md) * f;
    }
  }

  d.vx += ax * dt;
  d.vy += ay * dt;
  d.x += d.vx * dt;
  d.y += d.vy * dt;

  const sp = Math.min((t - d.spawnedAt) / SPAWN_MS, 1);
  const se = easeOutCubic(sp);
  // Displacement reads as caught light: a disturbed dot brightens.
  const disp = Math.hypot(d.x - d.hx, d.y - d.hy);
  const boost = Math.min(disp / 10, 1) * 0.3;

  const shimmer = d.glint
    ? 0.5 * Math.sin(t / 2100 + d.phase)
    : 0.09 * Math.sin(t / 1400 + d.phase);

  let alpha = d.a * (1 + shimmer) * se + boost;

  if (bursting) {
    alpha *= 1 - easeOutCubic(burstP);
  }

  if (alpha <= 0.01) {
    return;
  }

  const r = d.r * (0.6 + 0.4 * se);

  if (r <= 0.05) {
    return;
  }

  ctx.globalAlpha = Math.min(alpha, 1);
  ctx.beginPath();
  ctx.arc(d.x, d.y + (1 - se) * 9, r, 0, Math.PI * 2);
  ctx.fill();
};

const drawScan = (ctx: CanvasRenderingContext2D, rig: Rig, t: number) => {
  const { fx, fy, fw, fh } = rig;

  if (rig.sweepAt !== null) {
    const p = Math.min((t - rig.sweepAt) / SWEEP_MS, 1);
    const scanY = fy - 12 + easeInOutCubic(p) * (fh + 24);
    // On the first sweep this rode in at a flat 0.9 the whole way and the abrupt pop at
    // both ends was masked by the dots themselves fading in alongside it. On a later
    // idle pass the dots are already fully printed — the line is the only thing moving,
    // so that same hard on/off reads as a glitch rather than a sweep. Ramping opacity
    // over the first and last stretch of the travel (in lockstep with the same
    // easeInOutCubic the position already uses) fixes both: the first sweep gains a
    // matching fade with no visible cost, and the later passes stop popping. This was
    // first tried at 12% (~140ms either side of a 1200ms sweep) and confirmed too quick
    // to read as a fade at all once the dots weren't fading in alongside it — 30% is
    // long enough to see happening.
    const FADE = 0.3;

    const fadeMul = easeInOutCubic(Math.min(p / FADE, (1 - p) / FADE, 1));

    const grad = ctx.createLinearGradient(fx - 20, 0, fx + fw + 20, 0);
    grad.addColorStop(0, "rgba(0 0 0 / 0)");
    grad.addColorStop(0.5, rig.brassCss);
    grad.addColorStop(1, "rgba(0 0 0 / 0)");
    ctx.fillStyle = grad;
    ctx.globalAlpha = 0.9 * fadeMul;
    ctx.fillRect(fx - 20, scanY, fw + 40, 1);
    ctx.globalAlpha = 1;
  }
};

const advanceSweep = (rig: Rig, t: number, sweepAt: number) => {
  if (rig.printed) {
    if (t - sweepAt > SWEEP_MS) {
      rig.sweepAt = null;
    }

    return false;
  }

  const p = (t - sweepAt) / SWEEP_MS;
  const scanY = rig.fy - 12 + easeInOutCubic(Math.min(p, 1)) * (rig.fh + 24);

  for (const d of rig.dots) {
    if (d.spawnedAt < 0 && d.hy <= scanY) {
      d.spawnedAt = t;
    }
  }

  if (p >= 1 && t - sweepAt > SWEEP_MS + SPAWN_MS) {
    rig.printed = true;
    rig.sweepAt = null;

    return true;
  }

  return false;
};

const advancePrint = (rig: Rig, t: number): boolean | undefined => {
  if (rig.sweepAt !== null) {
    return advanceSweep(rig, t, rig.sweepAt) ? true : undefined;
  }

  if (rig.burstAt !== null) {
    if (t - rig.burstAt <= BURST_MS) {
      return undefined;
    }

    // Snap home and hide, then replay the print after the burst.
    for (const d of rig.dots) {
      d.x = d.hx;
      d.y = d.hy;
      d.vx = 0;
      d.vy = 0;
      d.spawnedAt = -1;
    }

    rig.burstAt = null;
    rig.printed = false;
    rig.sweepAt = t;

    return false;
  }

  if (rig.printed && t >= rig.nextSweepAt) {
    // Keep the interval measured between sweep starts.
    rig.sweepAt = t;
    rig.nextSweepAt = t + REPEAT_MS;
  }

  return undefined;
};

const drawStatic = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, rig: Rig | null) => {
  if (!rig) {
    return;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = rig.brassCss;

  for (const d of rig.dots) {
    ctx.globalAlpha = d.a;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
};

export const MacawHalftone = ({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) => {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [captured, setCaptured] = React.useState(false);
  // Survives a rebuild (resize, theme swap): once the mark has printed, a rebuild draws
  // it settled instead of replaying the arrival.
  const didCaptureRef = React.useRef(false);
  const armedRef = React.useRef(false);

  React.useEffect((): ReturnType<React.EffectCallback> => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;

    if (!wrap || !canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");

    if (!ctx) {
      return;
    }

    const reduceMq = window.matchMedia("(prefers-reduced-motion: reduce)");

    let raf = 0;
    let rig: Rig | null = null;
    const img = new Image();
    let disposed = false;
    let lastT = 0;

    const build = () => {
      if (!img.complete || img.naturalWidth === 0) {
        return;
      }

      const w = wrap.clientWidth;
      const h = wrap.clientHeight;

      if (w === 0 || h === 0) {
        return;
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const inset = 8;
      const boxSide = Math.min(w, h) - inset * 2;
      // Contain-fit, not stretch: the source mark is 240x209, not square, so sampling it
      // into an unconditional side*side grid (as if fw===fh) squashed it to fit — the same
      // distortion .xrio-logo avoids elsewhere by masking with mask-size: contain. Fit the
      // longer edge to boxSide and derive the other from the image's own aspect ratio.
      const imgAR = img.naturalWidth / img.naturalHeight;
      const fw = imgAR >= 1 ? boxSide : boxSide * imgAR;
      const fh = imgAR >= 1 ? boxSide / imgAR : boxSide;
      const fx = (w - fw) / 2;
      const fy = (h - fh) / 2;

      const now = performance.now();
      const reduced = reduceMq.matches;
      const settled = reduced || didCaptureRef.current;
      const dots = sampleDots(img, fw, fh, fx, fy);

      if (settled) {
        for (const d of dots) {
          d.spawnedAt = now - SPAWN_MS;
        }
      }

      const brass = readBrass(canvas);
      rig = {
        brassCss: `rgb(${brass.r} ${brass.g} ${brass.b})`,
        burstAt: null,
        dots,
        fh,
        fw,
        fx,
        fy,
        mouse: null,
        nextSweepAt: settled ? now + REPEAT_MS : Infinity,
        printed: settled,
        sweepAt: null,
      };

      if (settled) {
        setCaptured(true);
      }

      if (reduced) {
        drawStatic(ctx, canvas, rig);
      }
    };

    const frame = (t: number) => {
      if (disposed || !rig) {
        return;
      }

      const dt = Math.min((t - (lastT || t)) / 1000, 0.032);
      lastT = t;
      const { dots } = rig;

      const capturedNow = advancePrint(rig, t);

      if (capturedNow !== undefined) {
        setCaptured(capturedNow);

        if (capturedNow) {
          didCaptureRef.current = true;
        }
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = rig.brassCss;

      for (const d of dots) {
        drawDot(ctx, d, rig, t, dt);
      }

      ctx.globalAlpha = 1;

      drawScan(ctx, rig, t);

      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (reduceMq.matches || disposed || !rig) {
        return;
      }

      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    };

    const onMotionPref = () => {
      build();
      start();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!rig) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      rig.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const onPointerLeave = () => {
      if (rig) {
        rig.mouse = null;
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      // Only a fully idle mark can be scattered — mid-sweep (first print or a later idle
      // pass) or mid-burst, a click has nothing new to do. Skipped entirely under reduced
      // motion: there is no scatter to replay into, only the static print.
      if (
        !rig ||
        !rig.printed ||
        rig.sweepAt !== null ||
        rig.burstAt !== null ||
        reduceMq.matches
      ) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      for (const d of rig.dots) {
        const dx = d.x - cx;
        const dy = d.y - cy;
        const dd = Math.hypot(dx, dy) || 1;
        const s = 520 * (1 - Math.min(dd / 280, 1)) + 140 * Math.random();
        d.vx += (dx / dd) * s;
        d.vy += (dy / dd) * s;
      }

      rig.burstAt = performance.now();
      setCaptured(false);
    };

    const ro = new ResizeObserver(() => {
      build();
    });

    // Same rationale as BlackholeFigure: the brass is sampled at build time, so a theme
    // flip needs to re-sample and, if settled-static (reduced motion), redraw once.
    const mo = new MutationObserver(() => {
      if (!rig) {
        return;
      }

      const brass = readBrass(canvas);
      rig.brassCss = `rgb(${brass.r} ${brass.g} ${brass.b})`;

      if (reduceMq.matches) {
        drawStatic(ctx, canvas, rig);
      }
    });

    mo.observe(document.documentElement, {
      attributeFilter: ["style", "data-palette", "data-scheme"],
      attributes: true,
    });

    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) {
          cancelAnimationFrame(raf);

          return;
        }

        if (!armedRef.current) {
          armedRef.current = true;

          if (rig && !rig.printed && rig.sweepAt === null) {
            rig.sweepAt = performance.now();
            rig.nextSweepAt = rig.sweepAt + REPEAT_MS;
          }
        }

        start();
      },
      { threshold: 0.2 },
    );

    const onImageLoad = () => {
      if (disposed) {
        return;
      }

      build();
      ro.observe(wrap);
      io.observe(wrap);
    };

    img.addEventListener("load", onImageLoad);
    // If the mark fails to load, the section's copy and CTA remain visible.

    img.src = MARK_SRC;

    wrap.addEventListener("pointermove", onPointerMove);
    wrap.addEventListener("pointerleave", onPointerLeave);
    wrap.addEventListener("pointerdown", onPointerDown);
    reduceMq.addEventListener("change", onMotionPref);

    return () => {
      img.removeEventListener("load", onImageLoad);
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      mo.disconnect();
      wrap.removeEventListener("pointermove", onPointerMove);
      wrap.removeEventListener("pointerleave", onPointerLeave);
      wrap.removeEventListener("pointerdown", onPointerDown);
      reduceMq.removeEventListener("change", onMotionPref);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      aria-hidden="true"
      className={cn("relative aspect-square select-none", className)}
      style={style}
    >
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
      <span
        className="xrio-ticks"
        style={{ opacity: captured ? 1 : 0, transition: "opacity 500ms" }}
      >
        <i />
        <i />
        <i />
        <i />
      </span>
    </div>
  );
};
