"use client";

import { useEffect, useRef, useState } from "react";

/* The probe is fixed and the pages come to it. There is no run and no reset — the belt
   carries six gates past the probe forever, and a gate re-forms only after it has left the
   left edge, well outside the box.

   THE BELT STOPS AT EVERY GATE. Each interval is a short dwell with a gate on the probe, then
   a move that pulls away quickly and settles slowly onto the next gate. A constant belt reads
   as a conveyor.

   EVERY GATE CARRIES LOOT. A handful of sparkles float around each gate on the way in, and
   while the belt dwells they drift off it one after another and are collected by the dot. The
   gate itself stays whole. */

/* Public pages the belt visits. Each gate takes a new one every time it laps, out of sight
   past the right edge. Bare domains, eleven characters at most: a gate interval is ~90px at
   tablet width and anything longer runs into its neighbour. A multiple of GATES long so the
   clock below wraps seamlessly. */
const PAGES = [
  "arxiv.org",
  "python.org",
  "mozilla.org",
  "github.com",
  "go.dev",
  "crates.io",
  "pypi.org",
  "w3.org",
  "kernel.org",
  "debian.org",
  "example.com",
  "npmjs.com",
  "osm.org",
  "gnu.org",
  "ietf.org",
  "nodejs.org",
  "sqlite.org",
  "lwn.net",
];

const GATES = 6;

/* The sparkles each gate carries: [resting x px, resting y px, x drifts per LOOP, y drifts per
   LOOP, pull-in delay]. Each one rests at a spot around the gate and wanders a few px off it,
   slowly, on two different whole-number cycles — whole so the drift lands back where it
   started when the clock wraps, different so the path never closes into an orbit. The delays
   stagger collection so the sparkles drift into the dot one by one instead of as a lump. */
const SPARKLES: [number, number, number, number, number][] = [
  [-9, -14, 9, 7, 0],
  [11, -6, 7, 10, 0.3],
  [-12, 6, 10, 8, 0.1],
  [8, 15, 7, 9, 0.4],
  [13, -17, 8, 10, 0.2],
  [-7, 18, 10, 7, 0.5],
];

// px — how far a sparkle wanders from its resting spot
const DRIFT_X = 2.5;

const DRIFT_Y = 3.5;

// share of the pull each sparkle spends in flight
const FLIGHT = 0.5;

// px — the lift a sparkle takes on its way to the dot, so it drifts up and over, not straight
const ARC = 7;

const smooth = (n: number) => n * n * (3 - 2 * n);

// the rail's centre line, which the gates and the dot sit on
const RAIL_Y = 30;

// % of the rail between gates
const SPACING = 22;

// 132 — the belt's period
const WORLD = SPACING * GATES;

// where the belt starts, off the left of the rail
const LEFT_EDGE = -16;

/* PROBE_X is LEFT_EDGE plus a WHOLE number of spacings, which is what puts a gate exactly on
   the probe at the same moment the speed curve peaks. Any other offset and the punch lands
   between strikes. */
// 50
const PROBE_X = LEFT_EDGE + 3 * SPACING;

/* ms per gate: the belt rests on the gate for DWELL, collecting, then takes MOVE to reach the
   next one. Collection starts COLLECT_LEAD before the gate lands, while it is still gliding
   in, and runs COLLECT into the dwell, leaving a beat of stillness after the last one lands. */
const DWELL = 700;

const COLLECT = 560;

const COLLECT_LEAD = 350;

const MOVE = 1000;

const PERIOD = DWELL + MOVE;

// t wraps here, seamlessly: every gate has shown every page and the belt has repeated
const LOOP = PERIOD * PAGES.length;

const TICK = 32;

/* A sine ease-in-out run on a skewed clock: u^SKEW spends less of the move on the way up to
   speed and more on the way down, so each gate leaves the dwell briskly and glides to rest on
   the probe instead of slamming into it. Zero speed at both ends, so no jolt either way. */
const SKEW = 0.6;

const eased = (u: number) => (1 - Math.cos(Math.PI * u ** SKEW)) / 2;

const mod = (n: number, m: number) => ((n % m) + m) % m;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/* The page gate i is carrying at belt offset `off`: one more lap, six pages further on. */
const pageAt = (i: number, off: number) =>
  PAGES[mod(i - GATES * Math.floor((i * SPACING - off) / WORLD), PAGES.length)];

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

  const gate = Math.floor(t / PERIOD);
  // ms into this gate's interval
  const since = t - gate * PERIOD;
  const off = (gate + eased(clamp01((since - DWELL) / MOVE))) * SPACING;
  /* The probe flares on arrival and the flare decays over the first part of the dwell. */
  const strike = Math.max(0, 1 - since / 260);
  // the gate sitting on the probe this interval
  const docked = mod(gate + 3, GATES);
  const atProbe = pageAt(docked, gate * SPACING);

  return (
    <>
      <div
        ref={railRef}
        className="gauntlet-rail relative mt-20 h-[104px] overflow-hidden"
        aria-hidden="true"
      >
        {/* The rail, lit behind the probe: everything there has already been collected. */}
        <div
          className="absolute"
          style={{
            background: "var(--xrio-border3)",
            height: 1,
            left: `${PROBE_X}%`,
            right: 0,
            top: RAIL_Y,
          }}
        />
        <div
          className="absolute left-0"
          style={{ background: "var(--xrio-fg-mid)", height: 1, top: RAIL_Y, width: `${PROBE_X}%` }}
        />

        {Array.from({ length: GATES }, (_, i) => {
          const x = LEFT_EDGE + mod(i * SPACING - off, WORLD);
          const past = PROBE_X - x;
          const collected = past >= 0;
          /* 0 until the gate docks, 1 once its last sparkle has landed. */
          let pull = collected ? 1 : 0;

          /* ms since this gate landed on the probe — negative for the one gliding in next. */
          let landed: number | undefined;

          if (i === docked) {
            landed = since;
          } else if (i === mod(docked + 1, GATES)) {
            landed = since - PERIOD;
          }

          if (landed !== undefined) {
            pull = clamp01((landed + COLLECT_LEAD) / (COLLECT_LEAD + COLLECT));
          }

          /* Bright at the moment of contact, settling to the collected ink as the gate travels. */
          const heat = collected ? Math.max(0, 1 - past / 12) : 0;

          /* Heat is a COLOUR, not an opacity multiplier, so the collected side of the rail
             stays as solid as the side still coming in once the flash is over. */
          const ink = collected
            ? `color-mix(in srgb, var(--xrio-accent-text) ${Math.round(heat * 100)}%, var(--xrio-fg-mid))`
            : "var(--xrio-border4)";

          return (
            <span key={i}>
              {/* 2px, not the page's 1px hairline: a gate is an object, not a rule. */}
              <span
                className="absolute"
                style={{
                  background: ink,
                  height: 44,
                  left: `${x}%`,
                  marginLeft: -1,
                  top: 8,
                  width: 2,
                }}
              />

              {pull < 1 &&
                SPARKLES.map(([restX, restY, cyclesX, cyclesY, delay], j) => {
                  /* Each sparkle leaves on its own slice of the pull and eases in and out of
                     its flight, so it lifts off gently and settles into the dot. */
                  const k = smooth(clamp01((pull - delay) / FLIGHT));

                  if (k >= 1) {
                    return null;
                  }

                  const phase = (2 * Math.PI * t) / LOOP;
                  const stay = 1 - k;
                  const dx = (restX + Math.sin(cyclesX * phase + j) * DRIFT_X) * stay;

                  const dy =
                    (restY + Math.cos(cyclesY * phase + j) * DRIFT_Y) * stay -
                    ARC * Math.sin(Math.PI * k);

                  const tilt = 45 + 25 * Math.sin(cyclesY * phase + j);

                  return (
                    <span
                      key={j}
                      className="absolute"
                      style={{
                        background: j % 3 === 0 ? "var(--xrio-fg)" : "var(--xrio-accent-fill)",
                        height: 3,
                        left: `${x + (PROBE_X - x) * k}%`,
                        marginLeft: -1.5,
                        marginTop: -1.5,
                        opacity: 0.85 * Math.min(1, (1 - k) * 4),
                        top: RAIL_Y,
                        /* Diamonds, rocking slowly as they float: the twinkle is the rotation. */
                        transform: `translate(${dx}px, ${dy}px) rotate(${tilt}deg) scale(${1.2 - 0.6 * k})`,
                        width: 3,
                      }}
                    />
                  );
                })}

              <span
                className="absolute hidden sm:block whitespace-nowrap"
                style={{
                  color: collected ? "var(--xrio-fg)" : "var(--xrio-ink-dim)",
                  fontFamily: "var(--xrio-mono)",
                  fontSize: 10,
                  left: `${x}%`,
                  letterSpacing: ".08em",
                  opacity: collected ? 1 - clamp01(past / 40) * 0.5 : 1,
                  top: 68,
                  transform: "translateX(-50%)",
                }}
              >
                {pageAt(i, off)}
              </span>
            </span>
          );
        })}

        {/* The probe. It does not move, so contact has to be legible in the mark itself: a
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
            top: RAIL_Y,
            transform: `scale(${1 + 0.5 * strike})`,
            width: 8,
          }}
        />
      </div>
      {/* Below sm the travelling pages are too tight to read, so one fixed label under the
          probe names whatever is being collected instead. One element, not six. */}
      <p
        className="sm:hidden mt-3 text-center"
        style={{ color: "var(--xrio-fg2)", fontFamily: "var(--xrio-mono)", fontSize: 11 }}
      >
        {atProbe}
      </p>
    </>
  );
};
