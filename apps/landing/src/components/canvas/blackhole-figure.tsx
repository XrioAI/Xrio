"use client";

import * as React from "react";

import { readBrass } from "@/lib/brass";
import { cn } from "@/lib/utils";

/**
 * Canvas 2D black hole — the same object as the hero's three.js scene
 * (thousands of line arcs on Keplerian orbits around a punched-out mass),
 * reprinted with zero dependencies for mobile. Sparks orbit a tilted disk at
 * ω ∝ r^-3/2, drift slowly inward, stretch into streaks as the orbit
 * tightens, brighten on the approaching side the way a real disk
 * doppler-beams, flare once at the horizon and are gone. The hole itself is
 * never painted: it is the absence of dots, plus one hairline ring marking
 * the horizon.
 *
 * Ported from proxidize/px-scraper's receiver figure — same recipe, retuned
 * to read `--xrio-accent` instead of `--primary` for the live brass color.
 *
 * Under `prefers-reduced-motion` the disk prints once, settled and static:
 * the orbits are removed entirely, not frozen. The loop parks while the tab
 * is hidden.
 */

const TAU = Math.PI * 2;

/** Horizon radius as a fraction of the figure's side. */
const HORIZON = 0.15;

/** Outermost orbit, same units; the disk fills the frame without touching it. */
const OUTER = 0.55;

/** The disk seen at an inclination: orbits project to ellipses this flat. */
const SQUASH = 0.44;

/** The disk's major axis on screen, radians. Tilted to match the hero's steeper angle. */
const TILT = -0.6;

/** Vertical anchor as a fraction of the box height. The tilted ellipse doesn't
    fill its own square bounding box — centering it (0.5) leaves as much dead
    canvas above the disk as below, which read as extra space between the CTA
    row and the figure no matter how tight the margin above it was. Anchoring
    higher pulls the visible disk toward the top of the box instead, which is
    what actually closes that gap. */
const CENTER_Y_FRAC = 0.41;

const N_SPARKS = 1150;

/** Angular speed at the horizon, rad/s; Kepler scales it by (R/r)^1.5. */
const OMEGA_H = 0.8;

/** Inward drift at the horizon, in horizon radii per second. */
const INFALL_H = 0.08;

/** The disk's thickness as a fraction of the horizon radius — a disk with no
    depth reads as a paper ring. */
const FUZZ = 0.04;

/** How long a spark takes to print in, and to die at the horizon. */
const SPAWN_MS = 1000;

const DIE_MS = 1000;

interface Spark {
  /** Orbit radius and angle in the disk's own plane. */
  r: number;
  theta: number;
  /** Height off the disk plane, as a fraction of FUZZ·R. */
  z: number;
  /** Stroke half-width in CSS px. */
  size: number;
  /** Resting alpha, before beaming and shimmer. */
  a: number;
  /** The few embers that ride brighter than the disk around them. */
  glint: boolean;
  phase: number;
  spawnedAt: number;
  /** -1 while alive; the moment it touched the horizon otherwise. */
  dyingAt: number;
}

interface Rig {
  sparks: Spark[];
  cx: number;
  cy: number;
  /** Horizon and outermost orbit radii, CSS px. */
  R: number;
  rOut: number;
  brassCss: string;
}

const easeOutCubic = (p: number) => 1 - (1 - p) ** 3;

/** Inner-heavy radius draw, matching the density falloff of a real disk. */
const orbitRadius = (R: number, rOut: number) =>
  R * 1.06 + Math.random() ** 2.1 * (rOut - R * 1.06);

const createSpark = (R: number, rOut: number, spawnedAt: number): Spark => {
  const r = orbitRadius(R, rOut);
  const theta = Math.random() * TAU;
  // Triangular around the midplane: dense at the equator, thin at the faces.
  const z = Math.random() - Math.random();
  const size = 0.55 + 0.65 * Math.random();
  let a = 0.28 + 0.5 * Math.random() * Math.random();
  const glint = Math.random() < 0.04;

  if (glint) {
    a = 0.75 + 0.2 * Math.random();
  }

  const phase = Math.random() * TAU;
  const dyingAt = -1;

  return { a, dyingAt, glint, phase, r, size, spawnedAt, theta, z };
};

export const BlackholeFigure = ({ className }: { className?: string }) => {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

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
    let disposed = false;
    let lastT = 0;

    /** Disk-plane orbit point to screen, via squash then tilt. Negated before
        rotation to flip the whole figure horizontally and vertically at once
        (a point reflection through center), matching the hero's mirrored
        orientation. */
    const project = (geometry: Rig, r: number, theta: number, out: { x: number; y: number }) => {
      const xd = -r * Math.cos(theta);
      const yd = -r * Math.sin(theta) * SQUASH;
      const cosT = Math.cos(TILT);
      const sinT = Math.sin(TILT);
      out.x = geometry.cx + xd * cosT - yd * sinT;
      out.y = geometry.cy + xd * sinT + yd * cosT;
    };

    const p1 = { x: 0, y: 0 };
    const p2 = { x: 0, y: 0 };

    /**
     * One spark, one stroke. Everything a spark says is said in alpha and
     * length: doppler beaming brightens the approaching limb (θ around 0),
     * the shimmer is involuntary life, and a spark whose orbit has tightened
     * sweeps more arc in the same lookback time, so speed reads as streak
     * without a particle trail in sight.
     */
    const drawSpark = (geometry: Rig, s: Spark, t: number, settled: boolean) => {
      const { R } = geometry;

      // Behind the mass: the far half of the disk (sin θ < 0) vanishes where
      // it passes the horizon's screen disk. The near half crosses in FRONT
      // of the hole, which is what makes it read as a sphere, not a cutout.
      project(geometry, s.r, s.theta, p1);
      // Off-plane fuzz rides the disk normal, which projects to the ellipse's
      // minor axis on screen.
      const fz = s.z * FUZZ * R;
      const fzx = Math.sin(TILT) * fz;
      const fzy = -Math.cos(TILT) * fz;
      p1.x += fzx;
      p1.y += fzy;
      const far = Math.sin(s.theta) < 0;

      if (far && Math.hypot(p1.x - geometry.cx, p1.y - geometry.cy) < R * 1.04) {
        return;
      }

      const omega = OMEGA_H * (R / s.r) ** 1.5;

      let alpha = s.a;
      // Radial falloff: the disk is hottest at its inner edge.
      alpha *= 0.45 + 0.55 * (1 - (s.r - R) / (geometry.rOut - R)) ** 1.4;
      // Brighter in front of the mass (near, unoccluded), dimmer behind it
      // (far side, partially hidden) — the same sin θ split used for
      // occlusion above, not a left/right split, so the two sides of a given
      // half don't read as arbitrarily uneven.
      alpha *= 1 + 0.55 * Math.sin(s.theta);

      if (!settled) {
        alpha *= 1 + 0.1 * Math.sin(t / 900 + s.phase);
        const sp = Math.min((t - s.spawnedAt) / SPAWN_MS, 1);

        if (sp < 0) {
          return;
        }

        alpha *= easeOutCubic(sp);

        if (s.dyingAt >= 0) {
          // The accretion flash: brighter for a beat, then consumed.
          const dp = Math.min((t - s.dyingAt) / DIE_MS, 1);
          alpha *= (1 + 1.1 * Math.sin(dp * Math.PI)) * (1 - dp * dp);
        }
      }

      if (alpha <= 0.01) {
        return;
      }

      // The streak: this spark's own last 100ms of orbit, capped so the
      // innermost never smears into a ring.
      const back = Math.min(omega * 0.1, 0.55);
      project(geometry, s.r, s.theta - back, p2);
      p2.x += fzx;
      p2.y += fzy;

      ctx.globalAlpha = Math.min(alpha, 1);
      ctx.beginPath();
      ctx.moveTo(p2.x, p2.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.lineWidth = s.size * 2;
      ctx.stroke();
    };

    /** The horizon itself: one hairline, the photon ring. */
    const drawRing = (geometry: Rig, t: number, settled: boolean) => {
      ctx.globalAlpha = settled ? 0.35 : 0.32 + 0.08 * Math.sin(t / 700);
      ctx.beginPath();
      ctx.arc(geometry.cx, geometry.cy, geometry.R, 0, TAU);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    };

    const drawStatic = () => {
      if (!rig) {
        return;
      }

      const t = performance.now();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = rig.brassCss;
      ctx.lineCap = "round";

      for (const s of rig.sparks) {
        drawSpark(rig, s, t, true);
      }

      drawRing(rig, t, true);
    };

    const build = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;

      if (w === 0 || h === 0) {
        return;
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const side = Math.min(w, h);
      const R = side * HORIZON;
      const rOut = side * OUTER;
      const brass = readBrass(canvas);

      const now = performance.now();
      const reduced = reduceMq.matches;
      const sparks: Spark[] = [];

      for (let i = 0; i < N_SPARKS; i += 1) {
        const s = createSpark(R, rOut, now);

        // The disk condenses from the horizon outward on arrival: each orbit
        // waits on the ones inside it, with enough jitter that the edge of
        // the condensation is a front, not a line. Skipped when reduced
        // motion or a resize rebuild wants the settled disk immediately.
        if (!reduced) {
          s.spawnedAt = now + ((s.r - R) / (rOut - R)) * 380 * (0.7 + 0.6 * Math.random());
        }

        sparks.push(s);
      }

      rig = {
        R,
        brassCss: `rgb(${brass.r} ${brass.g} ${brass.b})`,
        cx: w / 2,
        cy: h * CENTER_Y_FRAC,
        rOut,
        sparks,
      };

      if (reduced) {
        drawStatic();
      }
    };

    const frame = (t: number) => {
      if (disposed || !rig) {
        return;
      }

      const dt = Math.min((t - (lastT || t)) / 1000, 0.05);
      lastT = t;

      const { sparks, R, rOut } = rig;

      for (const s of sparks) {
        const omega = OMEGA_H * (R / s.r) ** 1.5;
        s.theta = (s.theta + omega * dt) % TAU;
        // Kepler again for the drift: infall accelerates as the orbit decays.
        s.r -= R * INFALL_H * (R / s.r) ** 2 * dt;

        if (s.dyingAt < 0 && s.r <= R * 1.03) {
          s.dyingAt = t;
        }

        if (s.dyingAt >= 0 && t - s.dyingAt >= DIE_MS) {
          // Re-seeded onto the same density curve the disk was born with, so
          // the figure is stationary however long it runs.
          Object.assign(s, createSpark(R, rOut, t));
        }
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = rig.brassCss;
      ctx.lineCap = "round";

      for (const s of sparks) {
        drawSpark(rig, s, t, false);
      }

      drawRing(rig, t, false);
      ctx.globalAlpha = 1;

      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (reduceMq.matches || disposed || !rig) {
        return;
      }

      cancelAnimationFrame(raf);
      lastT = 0;
      raf = requestAnimationFrame(frame);
    };

    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
      } else {
        start();
      }
    };

    const onMotionPref = () => {
      build();
      start();
    };

    const ro = new ResizeObserver(() => {
      build();
    });

    /* The brass is sampled at build time, so a theme flip mid-frame would
       otherwise keep printing the old palette's metal onto the new canvas.
       DesignPanel's applyTheme() sets --xrio-accent as an inline custom
       property on <html> (and flips data-palette/data-scheme alongside it),
       so watching those attributes keeps the figure honest without polling
       styles every frame. */
    const mo = new MutationObserver(() => {
      if (!rig) {
        return;
      }

      const brass = readBrass(canvas);
      rig.brassCss = `rgb(${brass.r} ${brass.g} ${brass.b})`;

      if (reduceMq.matches) {
        drawStatic();
      }
    });

    mo.observe(document.documentElement, {
      attributeFilter: ["style", "data-palette", "data-scheme"],
      attributes: true,
    });

    build();
    ro.observe(wrap);
    start();

    document.addEventListener("visibilitychange", onVisibility);
    reduceMq.addEventListener("change", onMotionPref);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduceMq.removeEventListener("change", onMotionPref);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      aria-hidden="true"
      className={cn("pointer-events-none relative select-none", className)}
    >
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
    </div>
  );
};
