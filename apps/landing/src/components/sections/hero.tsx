"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const BlackholeGpu = dynamic(
  async () => {
    const { BlackholeGpuCanvas } = await import("@/components/canvas/blackhole-gpu-canvas");

    return BlackholeGpuCanvas;
  },
  { ssr: false },
);

const BlackholeThree = dynamic(
  async () => {
    const { BlackholeCanvas } = await import("@/components/canvas/blackhole-canvas");

    return BlackholeCanvas;
  },
  { ssr: false },
);

const GitHubMark = () => (
  <svg viewBox="0 0 24 24" width={15} height={15} fill="currentColor" aria-hidden="true">
    <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 2.9-.39c.98 0 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A10.52 10.52 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
  </svg>
);

export const Hero = () => {
  /* ?hero=three selects the three.js canvas; anything else (incl. absent) keeps the GPU default.
     Read after mount so SSR and first client render agree — both canvases are ssr:false and paint
     nothing on the server anyway, so the swap costs the same as mounting once. */
  const [hero, setHero] = useState<"gpu" | "three">("gpu");
  useEffect((): ReturnType<React.EffectCallback> => {
    if (new URLSearchParams(window.location.search).get("hero") === "three") {
      const frame = requestAnimationFrame(() => {
        setHero("three");
      });

      return () => {
        cancelAnimationFrame(frame);
      };
    }
  }, []);
  const BlackholeCanvas = hero === "three" ? BlackholeThree : BlackholeGpu;

  return (
    <section
      id="hero"
      className="relative overflow-hidden md:h-screen md:min-h-[680px]"
      style={{
        background: "var(--xrio-bg, #000)",
        paddingTop: "var(--xrio-nav-h)",
      }}
    >
      {/* Left readability veil — only needed once the disk sits behind the text again at md+ */}
      <div
        aria-hidden="true"
        className="hidden md:block absolute inset-0 z-[1] pointer-events-none"
        style={{
          background:
            "linear-gradient(to right, rgba(var(--xrio-bg-r),var(--xrio-bg-g),var(--xrio-bg-b),0.88) 0%, rgba(var(--xrio-bg-r),var(--xrio-bg-g),var(--xrio-bg-b),0.60) 28%, rgba(var(--xrio-bg-r),var(--xrio-bg-g),var(--xrio-bg-b),0.16) 48%, rgba(var(--xrio-bg-r),var(--xrio-bg-g),var(--xrio-bg-b),0.00) 62%)",
        }}
      />

      {/* CONTENT BAND — the copy is centred in the strip the hero actually composes in, which is
          NOT the whole hero: the docked plate's top edge cuts it off (see page.tsx), so the band
          runs from this section's --xrio-nav-h of nav padding down to that edge.

          calc(100% - var(--xrio-dock)), not a percentage. This parent is h-full of (heroH - nav),
          so subtracting the dock lands the band's bottom exactly on the plate's top edge at EVERY
          viewport height — which a fraction cannot do, because the ideal fraction is itself a
          function of height: (heroH - dock - 72)/(heroH - 72) is 0.80 at 700, 0.76 at 900 and 0.70
          at 1080. It was 87% (whole-hero centring, from before the plate existed) and then 75%
          (correct at 900 only, ~16px high at 700 and ~23px low at 1080). The calc is correct at
          all three because it is the same expression the plate positions itself with.

          The old tuning here aimed the H1 at the disk's bright inner arc (measured down the void's
          centre column at 1440x900: arc y 300-415, peak 368, flat background from 436). Those
          numbers are stale — anchorY moved with this change and now tracks the same band, so the
          disk is centred in the band rather than the copy being aimed at the disk. Re-measure the
          column if you ever decouple them.

          Centring in a band shorter than the hero also keeps the old guarantee for free: the copy
          cannot grow tall enough to reach the plate. */}
      {/* pointer-events-none, with the copy block below re-enabling itself. This container is
          md:h-full, so it is a full-hero, full-width box at z-[2] — and the docked plate now sits
          BELOW it in the stacking order (see page.tsx: the plate's wrapper dropped to z-[1] so the
          starfield can pass behind this copy instead of over it). Without this, the container
          would swallow every click over the plate's top band, including the url field. */}
      <div
        className="relative z-[2] pt-8 md:h-full md:pt-0 pointer-events-none"
        style={{ paddingLeft: "clamp(24px, 6vw, 72px)", paddingRight: "clamp(24px, 6vw, 72px)" }}
      >
        <div className="md:h-full md:flex md:items-center">
          <div className="max-w-[420px] flex flex-col gap-0 pointer-events-auto">
            <p
              className="mb-7"
              style={{
                /* --xrio-ink-dim, not fg-mid: at 10px this is the smallest type on the page, and
                   fg-mid lands at 3.1:1 on the light palettes' paper. See DIM INK in globals.css. */
                color: "var(--xrio-ink-dim)",
                fontFamily: "var(--xrio-mono)",
                fontSize: 10,
                letterSpacing: ".24em",
                textTransform: "uppercase",
              }}
            >
              MCP &nbsp;·&nbsp; open source &nbsp;·&nbsp; agent-native
            </p>

            <h1
              className="mb-[22px]"
              style={{
                fontFamily:
                  "var(--xrio-display-font, var(--font-space-grotesk), system-ui, sans-serif)",
                fontSize: "clamp(44px, 7.5vw, 88px)",
                fontWeight: 700,
                letterSpacing: "-.034em",
                lineHeight: 1,
              }}
            >
              Scraping,
              <br />
              built for
              <br />
              <span className="xrio-hero-anything">agents.</span>
            </h1>

            <p
              className="mb-9"
              style={{
                color: "var(--xrio-fg2)",
                fontSize: 14.5,
                fontWeight: 400,
                lineHeight: 1.72,
                maxWidth: 360,
              }}
            >
              One line and your agent is pulling structured data off any site — through Cloudflare,
              Akamai and DataDome, no key and no quota. And it&apos;s all open source: read the
              patches, audit the evasion, run it on your own hardware.
            </p>

            {/* mb-10 is for MOBILE only — BlackholeFigure below sits on it (its -mt-8 eats 32 of
                the 40). On desktop it is 40px of invisible block inside a box that gets centred,
                so geometric centring put the last visible thing 40px above where it looked
                centred: 95px of air above the eyebrow against 146 below the CTA. md:mb-0 makes
                the box end where the copy ends, so centring the box centres what you can see. */}
            <div className="flex flex-wrap items-center gap-x-[22px] gap-y-3 mb-10 md:mb-0">
              {/* colours live in CSS (.xrio-cta-primary) rather than inline so palette rules can
                  reach them — an inline style cannot be overridden without !important */}
              <span className="xrio-cta-primary text-[13px] font-medium px-5 py-[10px] rounded-sm">
                Coming Soon
              </span>
              <span
                aria-disabled="true"
                className="cs-link xrio-ink-link text-[13px] transition-colors"
              >
                Read the docs →
              </span>
              <span
                aria-disabled="true"
                className="cs-link xrio-ink-link text-[13px] transition-colors inline-flex items-center gap-[7px]"
              >
                <GitHubMark />
                GitHub
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ONE canvas for both layouts, moved by CSS rather than mounted twice — a second instance
          would build a second WebGPU device for a surface that is never visible.

          Below md it is a square figure in flow, in the slot and at the size BlackholeFigure held
          (the copy's mb-10 above is sized for the -mt-8 here). At md+ it goes full-bleed behind
          the copy at z-0; the copy block is z-[2], so DOM order does not matter to the stacking.
          The renderer swaps its own framing at the same 767px breakpoint — see MOBILE_LAYOUT. */}
      <div className="relative mx-auto -mt-8 mb-4 size-[min(88vw,400px)] pointer-events-none md:absolute md:inset-0 md:m-0 md:size-auto md:z-0">
        <BlackholeCanvas />
      </div>
    </section>
  );
};
