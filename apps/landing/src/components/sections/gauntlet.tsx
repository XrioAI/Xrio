"use client";

import { useEffect, useRef, useState } from "react";

/* The blade is fixed and the systems come to it. There is no run and no reset — the belt
   carries the same six past the probe forever, and a gate re-forms only after it has left
   the left edge, well outside the box.

   MOTION IS NOT LINEAR. Speed peaks at the instant of contact and bottoms out midway between
   gates, so each one is flung into the blade and the wreckage coasts away after it. That is
   the whole rhythm of the section; a constant belt reads as a conveyor.

   THE CUT IS CONTINUOUS, NOT A TWO-STATE TOGGLE. Every piece's separation, tumble and fade is
   a function of how far past the blade it has travelled, so the halves keep coming apart as
   they drift instead of snapping to one pose and sitting there. */

const NAMES = ["Cloudflare", "Akamai", "DataDome", "PerimeterX", "Kasada", "Incapsula"];

/* Two breaks, alternating. Both are the same cut — straight across the middle, two chunks and
   the sliver between them — they just fall differently. The first throws the halves apart and
   spins them away from each other. The second knocks the whole gate sideways, so both halves
   cartwheel the same way and slide further down the rail before they settle.

   Alternating by gate index, so a gate keeps its break for the whole lap. */
interface Piece {
  y: number;
  // where the piece sits before the cut
  h: number;
  dx: number;
  dy: number;
  // where it ends up once fully thrown
  rot: number;
  origin: string;
  fade: number;
}

interface Preset {
  cutY: number;
  // how far down the rail the pieces take to come fully apart
  spread: number;
  pieces: [Piece, Piece, Piece];
  /* [angle in degrees, speed]. Screen coordinates, so negative angles throw upward. */
  sparks: [number, number][];
}

const PRESETS: [Preset, Preset] = [
  {
    cutY: 29,
    pieces: [
      { dx: 4, dy: -26, fade: 0.45, h: 20, origin: "bottom center", rot: -44, y: 8 },
      { dx: 20, dy: -11, fade: 0.9, h: 3, origin: "center", rot: 190, y: 28 },
      { dx: -4, dy: 24, fade: 0.45, h: 21, origin: "top center", rot: 38, y: 31 },
    ],
    sparks: [
      [-152, 1],
      [-108, 0.72],
      [124, 0.86],
      [158, 0.64],
      [-172, 0.5],
    ],
    spread: 46,
  },
  {
    cutY: 29,
    pieces: [
      { dx: -14, dy: -16, fade: 0.45, h: 20, origin: "center", rot: 68, y: 8 },
      { dx: -22, dy: 4, fade: 0.9, h: 3, origin: "center", rot: -250, y: 28 },
      { dx: 11, dy: 28, fade: 0.45, h: 21, origin: "top center", rot: 82, y: 31 },
    ],
    sparks: [
      [-138, 0.9],
      [-166, 0.7],
      [142, 0.95],
      [170, 0.6],
      [-100, 0.5],
    ],
    spread: 58,
  },
];

/* Per-gate variation on the tumble, as a multiplier. Fixed rather than random: a random tilt
   would differ between the server's render and the client's and tear the hydration. */
const SWING = [1, 1.24, 0.8, 1.3, 0.74, 1.12];

const RAD = Math.PI / 180;

// % of the rail between gates
const SPACING = 22;

// 132 — the belt's period
const WORLD = SPACING * NAMES.length;

// where the belt starts, off the left of the rail
const LEFT_EDGE = -16;

/* PROBE_X is LEFT_EDGE plus a WHOLE number of spacings, which is what puts a gate exactly on
   the blade at the same moment the speed curve peaks. Any other offset and the punch lands
   between strikes. */
// 50
const PROBE_X = LEFT_EDGE + 3 * SPACING;

// ms per gate
const PERIOD = 1000;

// t wraps here, seamlessly: the belt has repeated
const LOOP = PERIOD * NAMES.length;

const TICK = 32;

/* Speed as 1 + A·cos(2πu): fastest at contact (u = 0), slowest halfway between. A stays under
   1 so the integral below never runs backwards. */
const A = 0.78;

const eased = (u: number) => u + (A / (2 * Math.PI)) * Math.sin(2 * Math.PI * u);

const mod = (n: number, m: number) => ((n % m) + m) % m;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/* The rail on its own, so the feature grid can carry the same moving belt without a second
   copy of the clock. Everything that animates lives here; the band below is only a heading
   and this. */
export const GauntletRail = () => {
  const [t, setT] = useState(0);
  const railRef = useRef<HTMLDivElement>(null);

  useEffect((): ReturnType<React.EffectCallback> => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const rail = railRef.current;

    if (!rail) {
      return;
    }

    let id: ReturnType<typeof setInterval> | undefined;

    const observer = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && id === undefined) {
          id = setInterval(() => {
            setT((p) => (p + TICK) % LOOP);
          }, TICK);
        } else if (!e.isIntersecting && id !== undefined) {
          clearInterval(id);
          id = undefined;
        }
      },
      { threshold: 0.2 },
    );

    observer.observe(rail);

    return () => {
      observer.disconnect();

      if (id !== undefined) {
        clearInterval(id);
      }
    };
  }, []);

  const p = t / PERIOD;
  const u = p - Math.floor(p);
  const off = (Math.floor(p) + eased(u)) * SPACING;
  /* The blade flares on contact and the flare decays over the first sixth of the interval. */
  const strike = Math.max(0, 1 - u / 0.16);
  const atBlade = NAMES[mod(Math.floor(p) + 3, NAMES.length)];

  return (
    <>
      <div
        ref={railRef}
        className="gauntlet-rail relative mt-20 h-[104px] overflow-hidden"
        aria-hidden="true"
      >
        {/* The rail, severed at the blade: everything behind it has already been opened. */}
        <div
          className="absolute"
          style={{
            background: "var(--xrio-border3)",
            height: 1,
            left: `${PROBE_X}%`,
            right: 0,
            top: 30,
          }}
        />
        <div
          className="absolute left-0"
          style={{ background: "var(--xrio-fg-mid)", height: 1, top: 30, width: `${PROBE_X}%` }}
        />

        {NAMES.map((name, i) => {
          const P = PRESETS[i % 2];
          const x = LEFT_EDGE + mod(i * SPACING - off, WORLD);
          const past = PROBE_X - x;
          const cut = past > 0;
          /* Separation runs over roughly two gates, on a power curve so the break is instant
             and the drift afterwards is slow. */
          const k = cut ? clamp01(past / P.spread) ** 0.55 : 0;
          /* White-hot at the moment of the cut, cooling as the pieces travel. */
          const heat = cut ? Math.max(0, 1 - past / 9) : 0;
          const swing = SWING[i];

          /* Heat is a COLOUR, not an opacity multiplier. Folding it into opacity halved every
             piece the moment the flash ended, which left the whole cut side of the rail — the
             field of wreckage that is the point of the section — effectively empty. */
          const ink = cut
            ? `color-mix(in srgb, var(--xrio-fg) ${Math.round(heat * 100)}%, var(--xrio-fg-mid))`
            : "var(--xrio-border4)";

          return (
            <span key={name}>
              {P.pieces.map((pc, j) => (
                <span
                  key={j}
                  className="absolute"
                  style={{
                    background: ink,
                    height: pc.h,
                    left: `${x}%`,
                    marginLeft: -1,
                    opacity: cut ? 1 - k * pc.fade : 1,
                    top: pc.y,
                    transform: `translate(${pc.dx * k}px, ${pc.dy * k}px) rotate(${pc.rot * swing * k}deg)`,
                    transformOrigin: pc.origin,
                    /* 2px, not the page's 1px hairline. These are objects being destroyed,
                       not rules, and at 1px the tumble is invisible — a rotated hairline is
                       a hairline. */
                    width: 2,
                  }}
                />
              ))}

              {/* Sparks live for about a sixth of a gate interval, so only the piece actually
                  at the blade is ever throwing any — they are mounted and dropped rather than
                  kept at zero opacity for the other five. */}
              {cut &&
                past < 16 &&
                P.sparks.map(([deg, speed], j) => {
                  const life = clamp01(past / 16);
                  const dist = 30 * speed * life ** 0.55;

                  return (
                    <span
                      key={j}
                      className="absolute"
                      style={{
                        background: "var(--xrio-fg)",
                        borderRadius: "50%",
                        height: 2,
                        left: `${x}%`,
                        marginLeft: -1,
                        opacity: (1 - life) ** 1.6,
                        top: P.cutY,
                        transform: `translate(${Math.cos(deg * RAD) * dist}px, ${Math.sin(deg * RAD) * dist}px)`,
                        width: 2,
                      }}
                    />
                  );
                })}

              <span
                className="absolute hidden sm:block whitespace-nowrap"
                style={{
                  color: cut ? "var(--xrio-fg)" : "var(--xrio-ink-dim)",
                  fontFamily: "var(--xrio-mono)",
                  fontSize: 10,
                  left: `${x}%`,
                  letterSpacing: ".08em",
                  opacity: 1 - k * 0.75,
                  top: 68,
                  transform: "translateX(-50%)",
                }}
              >
                {name}
              </span>
            </span>
          );
        })}

        {/* The blade. It does not move, so contact has to be legible in the mark itself: a
            vertical stroke that flares on the strike, over a dot that swells with it. */}
        <span
          className="absolute"
          style={{
            /* accent-TEXT, not accent-fill. This stroke is a mark measured against the page,
               and on Vellum accent-fill is the bright yellow that only works with dark type
               sitting on it — as a 1px line on paper it disappears. The dot below keeps
               accent-fill because it is a fill with mass. See the two tokens in globals.css. */
            background: "var(--xrio-accent-text)",
            height: 52,
            left: `${PROBE_X}%`,
            marginLeft: -0.5,
            opacity: 0.12 + 0.88 * strike,
            top: 4,
            width: 1,
          }}
        />
        <span
          className="absolute"
          style={{
            background: "var(--xrio-accent-fill)",
            borderRadius: "50%",
            boxShadow: `0 0 0 ${4 + 7 * strike}px var(--xrio-glow)`,
            height: 8,
            left: `${PROBE_X}%`,
            marginLeft: -4,
            marginTop: -4,
            top: 30,
            transform: `scale(${1 + 0.5 * strike})`,
            width: 8,
          }}
        />
      </div>
      {/* Below sm the travelling names are too tight to read, so one fixed label under the
          blade names whatever is being cut instead. One element, not six. */}
      <p
        className="sm:hidden mt-3 text-center"
        style={{ color: "var(--xrio-fg2)", fontFamily: "var(--xrio-mono)", fontSize: 11 }}
      >
        {atBlade}
      </p>
    </>
  );
};
