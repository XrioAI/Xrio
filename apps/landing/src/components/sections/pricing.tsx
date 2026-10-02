"use client";

import { useSyncExternalStore, useEffect, useRef, useState, useMemo } from "react";

import { StarfieldCanvas } from "@/components/canvas/starfield-canvas";
import { usePricingMode } from "@/context/pricing-mode-context";

/* ── PRICING MODEL ──
   Three request tiers, priced per 1,000 requests. Every plan exposes all three
   tiers — the plan only changes the rate. Commitment tiers discount off PAYG. */

declare module "react" {
  interface CSSProperties {
    "--pricing-slider-pct"?: string;
    "--credit-rows"?: number;
  }
}

const subscribeToReducedMotion = (notify: () => void) => {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", notify);

  return () => {
    media.removeEventListener("change", notify);
  };
};

const useReducedMotion = () =>
  useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

type TierKey = "html" | "rendered" | "proxy";

/* The three tiers are a *difficulty* ladder, not a format ladder — output is
   always shaped to whatever the client asked for, on every tier. What changes is
   how much machinery the page forces us to run to reach the content.

   Sub-lines are written about the reader's PAGE, not about our scraper. "Server
   returns the content directly" put the reader inside our fetch loop and made
   them translate back to their own sites; "The content is in the page's HTML" is
   a property of the thing they already know. Grammatical subject is the page in
   all three, so scanning down the row compares like with like. */
const TIERS: { key: TierKey; name: string; sub: string }[] = [
  { key: "html", name: "HTML", sub: "The content is in the page's HTML." },
  {
    key: "rendered",
    name: "Browser Rendered",
    sub: "The page builds its content with JavaScript.",
  },
  {
    key: "proxy",
    name: "Browser Rendered + Proxy",
    sub: "The page also blocks non-residential traffic.",
  },
];

/* Rate per 1,000 requests, by plan. */
const PAYG_RATES: Record<TierKey, number> = { html: 0.6, proxy: 5.2, rendered: 2.4 };

/* Commitment tiers: monthly spend → discount off PAYG rates. */
const COMMITMENTS = [
  { commit: 0, discount: 0, label: "Pay as you go" },
  { commit: 100, discount: 0.18, label: "$100" },
  { commit: 250, discount: 0.28, label: "$250" },
  { commit: 500, discount: 0.38, label: "$500" },
  { commit: 1000, discount: 0.46, label: "$1,000" },
  { commit: 2500, discount: 0.54, label: "$2,500" },
];

const TRIAL_DOLLARS = 5;

/* ── PLACEHOLDER RATES ──
   Nothing on this page has been priced yet. Every figure below — tier rates,
   commitment discounts, credit allowances, plan prices, per-action credit costs,
   the trial amount — was invented to build the layout, and showing invented
   numbers on a pricing page reads as a commitment to them.

   So all of them render as an em dash while this is true. The underlying data
   stays intact and structural: the sliders still need distinct steps to move
   between, the plan ladder still orders low → high, and the derived discount math
   still runs. Flip this to false and the real numbers appear with no other edit.

   Em dash rather than "coming soon" per cell, because the surrounding words —
   "per page", "credits / month", "/ 1K" — already say what the missing thing is;
   the cell only needs to say it is not decided. "0" was rejected as it reads as a
   free-tier claim rather than a blank. */
const RATES_TBD = true;

/* Em dash for a to-be-decided figure. Takes the formatted string so each caller
   keeps its own formatting for when the numbers land. */
const tbd = (formatted: string): string => (RATES_TBD ? "\u2014" : formatted);

/* Appended to .pricing-figure while rates are withheld. An em dash at display
   weight is a solid bar, louder than the numeral it stands in for, so .is-tbd
   dials it back to a quiet mark — see globals.css. */
const TBD_FIGURE_CLASS = RATES_TBD ? " is-tbd" : "";

/* ── ALTERNATIVE MODEL: CREDITS ──
   One currency instead of three rates. A plan buys a monthly credit allowance,
   and each request tier draws a different number of credits — so the same
   difficulty ladder survives, expressed as a cost multiplier rather than a
   price. Toggled from the design panel; see PricingModeContext. */

/* Credits drawn per request, by tier. HTML anchors the scale at 1. */
const TIER_CREDITS: Record<TierKey, number> = { html: 1, proxy: 9, rendered: 4 };

/* No plan names. The allowance is the identity — "150K credits / month" says
   everything "Growth" was standing in for, and a tier name only adds a label the
   reader has to map back to a number. */
interface CreditPlan {
  credits: number;
  price: number;
  blurb: string;
  /* Retainer plans get a soft cap: overage keeps running at the plan's rate
     instead of hard-stopping, which PAYG has no need to state. */
  overage: string | null;
  features: string[];
}

const CREDIT_PLANS: CreditPlan[] = [
  {
    blurb: "Top up whenever. Nothing to cancel.",
    credits: 0,
    features: ["No monthly minimum", "2 concurrent requests", "Community support"],
    overage: null,
    price: 0,
  },
  {
    blurb: "A steady pipeline or a few scheduled jobs.",
    credits: 25_000,
    features: ["10 concurrent requests", "30-day request logs", "Email support"],
    overage: "$1.40 / 1K credits",
    price: 29,
  },
  {
    blurb: "Production scraping across many sites.",
    credits: 150_000,
    features: ["50 concurrent requests", "90-day request logs", "Priority support"],
    overage: "$1.10 / 1K credits",
    price: 149,
  },
  {
    blurb: "High-volume, latency-sensitive workloads.",
    credits: 500_000,
    features: ["200 concurrent requests", "1-year request logs", "Priority support"],
    overage: "$0.90 / 1K credits",
    price: 449,
  },
  {
    blurb: "Dedicated proxy pools and an uptime SLA.",
    credits: 1_000_000,
    features: ["500 concurrent requests", "Custom retention", "Shared Slack channel"],
    overage: "$0.75 / 1K credits",
    price: 799,
  },
];

/* PAYG credit price anchors the ladder — every plan's effective rate is
   measured against it to derive the discount shown on the slider. */
const PAYG_CREDIT_PRICE = 1.8 / 1000;

/* What else draws credits beyond a plain page fetch. Mirrors Firecrawl's
   "API credits" table: the unit differs per action, so each row states its own. */
const CREDIT_COSTS: { label: string; cost: string; unit: string; note: string }[] = [
  /* Same framing as TIERS, and phrased about the reader's page for the same
     reason — output is always formatted to the client's schema, so the note can
     only be about difficulty. Kept terser than TIERS: these are table cells. */
  { cost: "1", label: "HTML fetch", note: "Content is in the page's HTML", unit: "per page" },
  {
    cost: "4",
    label: "Browser rendered",
    note: "Page builds content with JavaScript",
    unit: "per page",
  },
  {
    cost: "9",
    label: "Rendered + proxy",
    note: "Page blocks non-residential traffic",
    unit: "per page",
  },
  { cost: "2", label: "Search", note: "SERP scrape, deduplicated", unit: "per 10 results" },
  /* Screenshot replaced an "Interact" row that billed "per browser minute". Two
     reasons: it was the only time-metered unit in a table that otherwise counts
     things, so the reader had to switch mental models for one row; and at 113px of
     ink it was nearly twice the next-longest unit, which is what made the gap
     before the titles read as uneven. */
  { cost: "3", label: "Screenshot", note: "Full-page capture after render", unit: "per page" },
  {
    cost: "2",
    label: "Structured parse",
    note: "Schema extraction on top of a fetch",
    unit: "per page",
  },
];

/* Effective $/1K credits for a retainer plan, used to quote a discount against
   PAYG. PAYG itself is the baseline, so it discounts to zero. */
const creditRate = (plan: CreditPlan): number => {
  if (plan.credits <= 0) {
    return PAYG_CREDIT_PRICE;
  }

  return plan.price / plan.credits;
};

const creditDiscount = (plan: CreditPlan): number => {
  if (plan.credits <= 0) {
    return 0;
  }

  return 1 - creditRate(plan) / PAYG_CREDIT_PRICE;
};

/* ── SITE DIFFICULTY LOOKUP (mocked) ──
   Stands in for the real classifier: a domain maps to the cheapest tier that
   returns that site clean. Swap this table for the API call when it exists. */
const DIFFICULTY: Record<TierKey, string> = {
  html: "Easy",
  proxy: "Hard",
  rendered: "Medium",
};

const KNOWN_SITES: { domain: string; tier: TierKey }[] = [
  { domain: "news.ycombinator.com", tier: "html" },
  { domain: "en.wikipedia.org", tier: "html" },
  { domain: "github.com", tier: "html" },
  { domain: "producthunt.com", tier: "rendered" },
  { domain: "airbnb.com", tier: "rendered" },
  { domain: "linkedin.com", tier: "rendered" },
  { domain: "amazon.com", tier: "proxy" },
  { domain: "walmart.com", tier: "proxy" },
  { domain: "ticketmaster.com", tier: "proxy" },
];

/* Tolerates bare domains, full URLs, www., and trailing paths. */
const lookupSite = (input: string): { domain: string; tier: TierKey } | null => {
  const [cleaned] = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .replace(/^www\./u, "")
    .split(/[/?#]/u);

  if (!cleaned) {
    return null;
  }

  return KNOWN_SITES.find((s) => s.domain === cleaned) ?? null;
};

const rateFor = (tier: TierKey, discount: number): number => PAYG_RATES[tier] * (1 - discount);

/* Requests a given dollar amount buys on one tier, at that tier's rate. */
const requestsFor = (dollars: number, tier: TierKey, discount: number): number =>
  (dollars / rateFor(tier, discount)) * 1000;

const fmtMoney = (v: number): string =>
  v.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

const fmtCount = (v: number): string => {
  if (v >= 1_000_000) {
    return `${(v / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
  }

  if (v >= 1000) {
    return `${Math.round(v / 1000).toLocaleString("en-US")}K`;
  }

  return Math.round(v).toLocaleString("en-US");
};

const useInView = <T extends HTMLElement>() => {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  const reducedMotion = useReducedMotion();

  useEffect((): ReturnType<React.EffectCallback> => {
    const el = ref.current;

    if (!el) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0.35 },
    );

    observer.observe(el);

    return () => {
      observer.disconnect();
    };
  }, []);

  return { inView: inView || reducedMotion, ref };
};

/* Rates animate between commitment steps rather than snapping, so dragging the
   slider reads as one continuous price curve. */
const useTween = (target: number, duration = 220) => {
  const [value, setValue] = useState(target);
  const reducedMotion = useReducedMotion();
  const fromRef = useRef(target);

  useEffect((): ReturnType<React.EffectCallback> => {
    const from = fromRef.current;

    if (from === target || reducedMotion) {
      fromRef.current = target;

      const frame = requestAnimationFrame(() => {
        setValue(target);
      });

      return () => {
        cancelAnimationFrame(frame);
      };
    }

    let raf = 0;
    const t0 = performance.now();

    const tick = (ts: number) => {
      const p = Math.min(1, (ts - t0) / duration);
      const eased = 1 - (1 - p) ** 3;
      const v = from + (target - from) * eased;
      fromRef.current = v;
      setValue(v);

      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
    };
  }, [target, duration, reducedMotion]);

  return reducedMotion ? target : value;
};

/* Text counterpart to useTween: resolves left-to-right, scrambling the glyphs
   that haven't landed yet. Fills the transition with motion instead of the gap a
   crossfade leaves, and suits the mono type better. */
const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$%#*/+=<>";

const useScramble = (text: string, duration = 190) => {
  const [display, setDisplay] = useState(text);
  const reducedMotion = useReducedMotion();
  const prev = useRef(text);

  useEffect((): ReturnType<React.EffectCallback> => {
    if (prev.current === text || reducedMotion) {
      prev.current = text;

      const frame = requestAnimationFrame(() => {
        setDisplay(text);
      });

      return () => {
        cancelAnimationFrame(frame);
      };
    }

    prev.current = text;

    let raf = 0;
    const t0 = performance.now();
    const chars = Array.from(segmenter.segment(text), ({ segment }) => segment);

    const tick = (ts: number) => {
      const p = Math.min(1, (ts - t0) / duration);
      /* Linear: an ease-out holds scrambled glyphs late and reads as lag. */
      const settled = Math.floor(chars.length * p);
      setDisplay(
        chars
          .map((c, i) => {
            if (i < settled || c === " ") {
              return c;
            }

            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join(""),
      );

      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        setDisplay(text);
      }
    };

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
    };
  }, [text, duration, reducedMotion]);

  return reducedMotion ? text : display;
};

/* Wrapper so a scrambling string can drop into markup like any other node.
   tabular-nums keeps width stable while digits churn. */
const Scramble = ({
  text,
  className,
  style,
}: {
  text: string;
  className?: string;
  style?: React.CSSProperties;
}) => {
  const out = useScramble(text);

  return (
    <span className={className} style={{ fontVariantNumeric: "tabular-nums", ...style }}>
      {out}
    </span>
  );
};

const MONO = "var(--xrio-mono)";

const DISPLAY = "var(--xrio-display-font, var(--font-space-grotesk), system-ui, sans-serif)";

/* ── 2. RATE CELL — lives inside the slider block ── */
const RateCell = ({
  tier,
  discount,
  commit,
}: {
  tier: (typeof TIERS)[number];
  discount: number;
  commit: number;
}) => {
  const rate = useTween(rateFor(tier.key, discount));
  const included = commit > 0 ? requestsFor(commit, tier.key, discount) : 0;

  const allowance = RATES_TBD
    ? "Allowance to be confirmed"
    : `≈ ${fmtCount(included)} requests included`;

  return (
    <div
      className="p-[22px_20px] md:p-[26px_24px] flex flex-col pricing-tier"
      style={{ background: "transparent", position: "relative" }}
    >
      {/* The tier name is what the reader is actually choosing between, so it
          titles the cell: display face, sentence case, full-strength ink. It was
          10px dim uppercase mono — the smallest, faintest text in the cell —
          which made the thing being chosen read as a caption on the price. */}
      <h3
        style={{
          color: "var(--xrio-fg)",
          fontFamily: DISPLAY,
          fontSize: 15,
          fontWeight: 600,
          letterSpacing: "-.01em",
          lineHeight: 1.3,
        }}
      >
        {tier.name}
      </h3>

      {/* Description sits with its title, above the price, and at body size —
          it qualifies the name, not the number. */}
      <p
        className="mt-[6px] mb-4"
        style={{ color: "var(--xrio-fg2)", fontSize: 13, lineHeight: 1.5 }}
      >
        {tier.sub}
      </p>

      <div className="flex items-baseline gap-[6px]">
        <span
          className={`pricing-figure${TBD_FIGURE_CLASS}`}
          style={{
            fontFamily: DISPLAY,
            fontSize: "clamp(26px, 3vw, 34px)",
            fontVariantNumeric: "tabular-nums",
            fontWeight: 700,
            letterSpacing: "-.03em",
          }}
        >
          {tbd(`$${fmtMoney(rate)}`)}
        </span>
        <span className="pricing-unit" style={{ fontFamily: MONO, fontSize: 11 }}>
          / 1K
        </span>
      </div>

      {/* Scrambles in step with the rate above it. mt-auto pins it to the cell
          floor; the pt guarantees a gap if a description wraps long enough to
          squeeze the column. */}
      <p className="mt-auto pt-4">
        <Scramble
          text={commit > 0 ? allowance : "No minimum, no contract"}
          className={commit > 0 ? "pricing-unit" : "pricing-dim"}
          style={{ fontFamily: MONO, fontSize: 10.5 }}
        />
      </p>
    </div>
  );
};

/* ── 2. PLANS — slider and tier rates share one bordered block, so dragging
   visibly drives the numbers directly beneath it. ── */
const PlansBlock = () => {
  const { ref, inView } = useInView<HTMLDivElement>();
  const [index, setIndex] = useState(0);

  const active = COMMITMENTS[index];
  const pct = (index / (COMMITMENTS.length - 1)) * 100;

  const savingsCopy = useMemo(() => {
    if (active.commit === 0) {
      return "Switch to a monthly commitment any time — new rates apply instantly.";
    }

    /* The discount is a claim about our rates, so it is withheld with them. The
       commitment amounts themselves stay: those are spend levels the customer
       chooses, not prices we are quoting, and they label the slider's steps. */
    if (RATES_TBD) {
      return "Volume discount to be announced.";
    }

    return `−${Math.round(active.discount * 100)}% off pay-as-you-go on every tier.`;
  }, [active]);

  return (
    <div
      ref={ref}
      className="mb-5 relative xrio-ticks-host"
      style={{
        background: "var(--xrio-surface)",
        border: "1px solid var(--xrio-border3)",
        borderRadius: "var(--xrio-r-surface)",
        opacity: inView ? 1 : 0,
        transform: inView ? "none" : "translateY(8px)",
        transition: "opacity .5s ease, transform .5s ease",
      }}
    >
      <span className="xrio-ticks" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      {/* Slider half */}
      <div className="p-[26px_24px] md:p-[32px_38px]">
        {/* flex-col by default: whether savingsCopy fits on the label's row
            depends on its own length ("Switch to a monthly commitment..." vs
            "Volume discount to be announced."), so a wrapping flex-row here
            silently swaps between one row and two as the slider moves —
            that row-count flip is what reads as the block snapping taller or
            shorter. Stacking unconditionally on mobile removes the flip. */}
        <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4 mb-4">
          <div className="flex items-baseline gap-[10px]">
            {/* Scrambles to the new value, mirroring the numeric tween on the
                rates below rather than crossfading. */}
            <Scramble
              text={active.commit === 0 ? "Pay as you go" : active.label}
              style={{
                color: "var(--xrio-fg)",
                fontFamily: DISPLAY,
                fontSize: "clamp(24px, 3vw, 32px)",
                fontWeight: 700,
                letterSpacing: "-.03em",
              }}
            />
            <Scramble
              text={active.commit === 0 ? "no commitment" : "/ month minimum"}
              className="pricing-unit"
              style={{ fontFamily: MONO, fontSize: 11.5 }}
            />
          </div>

          {/* min-h reserves 2 lines' worth on mobile: the PAYG copy ("Switch to
              a monthly commitment...") wraps to 2 lines while the commitment
              copy ("Volume discount to be announced.") is 1 — without the
              reservation the row itself grows/shrinks by that second line as
              the slider crosses the PAYG boundary. Released at sm+, where the
              row is wide enough that both variants sit on one line anyway. */}
          <Scramble
            text={savingsCopy}
            className={`${active.discount > 0 ? "pricing-accent-text" : "pricing-dim"} min-h-[35px] sm:min-h-0`}
            style={{ fontFamily: MONO, fontSize: 11.5 }}
          />
        </div>

        <input
          type="range"
          min={0}
          max={COMMITMENTS.length - 1}
          step={1}
          value={index}
          onChange={(e) => {
            setIndex(Number(e.target.value));
          }}
          aria-label="Monthly commitment"
          aria-valuetext={active.commit === 0 ? "Pay as you go" : `${active.label} per month`}
          className="pricing-slider"
          style={{ "--pricing-slider-pct": `${pct}%` }}
        />

        <div className="flex justify-between mt-3">
          {COMMITMENTS.map((c, i) => (
            <button
              key={c.commit}
              type="button"
              onClick={() => {
                setIndex(i);
              }}
              aria-pressed={i === index}
              className={`pricing-step ${i === index ? "pricing-accent-text" : "pricing-dim"}`}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: MONO,
                fontSize: 10.5,
                fontVariantNumeric: "tabular-nums",
                padding: "2px 0",
              }}
            >
              {c.commit === 0 ? "PAYG" : c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Rate half — same block, divided by a rule */}
      <div
        className="grid grid-cols-1 md:grid-cols-3 pricing-grid mx-[24px] md:mx-[38px] mt-6 mb-[26px] md:mb-[32px]"
        style={{ border: "1px solid var(--xrio-border3)", borderRadius: "var(--xrio-r-surface)" }}
      >
        {TIERS.map((tier) => (
          <RateCell key={tier.key} tier={tier} discount={active.discount} commit={active.commit} />
        ))}
      </div>
    </div>
  );
};

/* ── 2b. CREDITS VARIANT ──
   Slider picks a plan rather than a spend level. No per-tier columns here: the
   credit cost of each page type is a property of the currency, not of the plan,
   so it lives once in CreditCostsBlock instead of being restated per plan. */
const creditPlanLabel = (plan: CreditPlan, index: number) => {
  if (plan.credits === 0) {
    return "PAYG";
  }

  return RATES_TBD ? `TIER ${index}` : fmtCount(plan.credits);
};

const CreditsPlansBlock = () => {
  const { ref, inView } = useInView<HTMLDivElement>();
  const [index, setIndex] = useState(1);

  const plan = CREDIT_PLANS[index];
  const pct = (index / (CREDIT_PLANS.length - 1)) * 100;
  const isPayg = plan.credits === 0;

  const discount = creditDiscount(plan);

  const savingsCopy = useMemo(() => {
    if (isPayg) {
      return "Credits never expire.";
    }

    if (RATES_TBD) {
      return "Volume discount to be announced.";
    }

    return `−${Math.round(discount * 100)}% per credit vs pay as you go.`;
  }, [isPayg, discount]);

  /* The allowance leads, since it's what the plan *is* now that nothing is
     named. PAYG has no allowance to show, so its rate takes the slot — same
     grammar (quantity, then unit), different quantity. */
  const headline = tbd(isPayg ? "$1.80" : fmtCount(plan.credits));
  const headlineUnit = isPayg ? "/ 1K credits" : "credits / month";

  /* Secondary line: the price. PAYG has already stated its price above, so it
     says how billing works instead of repeating the figure. */
  const monthlyPrice = RATES_TBD ? "pricing to be announced" : `$${plan.price} / month`;
  const priceLine = isPayg ? "billed as you use it" : monthlyPrice;

  const paidOverage = RATES_TBD
    ? "Past the allowance, credits keep flowing — no hard stop."
    : `Past the allowance, credits keep flowing at ${plan.overage} — no hard stop.`;

  return (
    <div
      ref={ref}
      className="mb-5 relative xrio-ticks-host"
      style={{
        background: "var(--xrio-surface)",
        border: "1px solid var(--xrio-border3)",
        borderRadius: "var(--xrio-r-surface)",
        opacity: inView ? 1 : 0,
        transform: inView ? "none" : "translateY(8px)",
        transition: "opacity .5s ease, transform .5s ease",
      }}
    >
      <span className="xrio-ticks" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <div className="p-[26px_24px] md:p-[32px_38px]">
        {/* flex-col by default — see the identical note in PlansBlock above:
            whether savingsCopy fits beside the headline depends on its own
            length, so a wrapping flex-row flips row count as the slider moves. */}
        <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4 mb-1">
          {/* The allowance is the headline — display weight, accent ink, at the
              size the per-tier rates carried in the dollars variant. */}
          {/* The .pricing-* classes only bite on light palettes; the inline color
              is the dark-palette value and stays the default. Class and inline
              color can't both set `color` — inline always wins — so anything a
              class overrides must leave it out here. */}
          <div className="flex items-baseline gap-[9px]">
            <Scramble
              text={headline}
              className={`pricing-figure pricing-headline-figure${TBD_FIGURE_CLASS}`}
              style={{
                fontFamily: DISPLAY,
                fontSize: "clamp(32px, 4.2vw, 46px)",
                fontWeight: 700,
                letterSpacing: "-.03em",
              }}
            />
            <Scramble
              text={headlineUnit}
              className="pricing-unit"
              style={{ fontFamily: MONO, fontSize: 13 }}
            />
          </div>

          <Scramble
            text={savingsCopy}
            className={discount > 0 ? "pricing-accent-text" : "pricing-dim"}
            style={{ fontFamily: MONO, fontSize: 11.5 }}
          />
        </div>

        <div className="mb-5">
          <Scramble
            text={priceLine}
            style={{ color: "var(--xrio-fg2)", fontFamily: MONO, fontSize: 12.5 }}
          />
        </div>

        <input
          type="range"
          min={0}
          max={CREDIT_PLANS.length - 1}
          step={1}
          value={index}
          onChange={(e) => {
            setIndex(Number(e.target.value));
          }}
          aria-label="Monthly credit allowance"
          aria-valuetext={
            isPayg
              ? `Pay as you go, ${tbd("$1.80")} per 1,000 credits`
              : `${plan.credits.toLocaleString("en-US")} credits per month, ${tbd(`$${plan.price} per month`)}`
          }
          className="pricing-slider"
          style={{ "--pricing-slider-pct": `${pct}%` }}
        />

        <div className="flex justify-between mt-3">
          {CREDIT_PLANS.map((p, i) => (
            <button
              key={p.credits}
              type="button"
              onClick={() => {
                setIndex(i);
              }}
              aria-pressed={i === index}
              className={`pricing-step ${i === index ? "pricing-accent-text" : "pricing-dim"}`}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: MONO,
                fontSize: 10.5,
                fontVariantNumeric: "tabular-nums",
                padding: "2px 0",
              }}
            >
              {creditPlanLabel(p, i)}
            </button>
          ))}
        </div>

        {/* Plan blurb, features, and overage — the per-plan detail that a
            dollars commitment level doesn't have. */}
        <div
          className="mt-7 pt-6 flex flex-col md:flex-row md:items-start gap-5 md:gap-10"
          style={{ borderTop: "1px solid var(--xrio-border)" }}
        >
          <p
            style={{
              color: "var(--xrio-fg2)",
              flexShrink: 0,
              fontSize: 13,
              lineHeight: 1.65,
              maxWidth: 300,
            }}
          >
            {plan.blurb}
          </p>

          {/* flex-col on mobile: every plan lists exactly 3 features, so
              stacking one per row is a fixed 3-line height regardless of how
              those 3 phrases wrap-pack into rows — a wrapping flex-row packs
              2-per-row for short phrases and 3 rows for long ones, and that
              row-count difference is what snapped the block's height per plan. */}
          <ul
            className="flex flex-col sm:flex-row sm:flex-wrap gap-x-6 gap-y-2 flex-1"
            style={{ listStyle: "none", margin: 0, padding: 0 }}
          >
            {plan.features.map((f) => (
              <li key={f} className="flex items-baseline gap-2">
                <span className="pricing-accent-text" style={{ fontFamily: MONO, fontSize: 10 }}>
                  +
                </span>
                <span style={{ color: "var(--xrio-fg2)", fontSize: 12.5 }}>{f}</span>
              </li>
            ))}
          </ul>

          {/* One label across every step — the plan is chosen by the slider, so a
              per-plan verb only churns text that says the same thing. */}
          {/* Not a live link: every primary CTA on the site is a disabled
              "Coming Soon" affordance (see Hero/nav's .xrio-cta-primary) while
              pre-launch — this one keeps its plan-specific label instead of
              generic "Coming Soon" text, but must stay inert like its peers. */}
          <span className="pricing-submit xrio-cta-primary flex-shrink-0 block text-center">
            Get started
          </span>
        </div>

        {/* Always mounted, even for PAYG (which has no overage rate to quote) —
            this note was previously only rendered when plan.overage was set,
            so PAYG's card was a whole paragraph shorter than every other
            plan's, and the slider's block visibly grew or shrank by that
            paragraph's height as it crossed the PAYG boundary. */}
        <p className="mt-4 pricing-dim" style={{ fontFamily: MONO, fontSize: 10.5 }}>
          {plan.overage === null
            ? "No allowance to run past — every credit is billed as you go."
            : paidOverage}
        </p>
      </div>
    </div>
  );
};

/* ── 2c. WHAT CREDITS BUY ──
   Credits are only legible once the draw-down rate is spelled out, so this
   table is load-bearing for the model rather than decorative. Rows carry their
   own unit because the unit genuinely differs — per page, per 10 results, per
   browser minute. */
const CreditCostsBlock = () => {
  const { ref, inView } = useInView<HTMLDivElement>();

  return (
    <>
      <h3
        className="mt-16 mb-6"
        style={{
          color: "var(--xrio-fg)",
          fontFamily: DISPLAY,
          fontSize: "clamp(22px, 2.8vw, 30px)",
          fontWeight: 700,
          letterSpacing: "-.025em",
          lineHeight: 1.15,
        }}
      >
        What a credit gets you.
      </h3>

      <div
        ref={ref}
        className="relative xrio-ticks-host"
        style={{
          background: "var(--xrio-surface)",
          border: "1px solid var(--xrio-border3)",
          borderRadius: "var(--xrio-r-surface)",
          opacity: inView ? 1 : 0,
          transform: inView ? "none" : "translateY(8px)",
          transition: "opacity .5s ease, transform .5s ease",
        }}
      >
        <span className="xrio-ticks" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        {/* Column-major: the six entries fill the left column top-to-bottom, then
            the right. grid-auto-flow: column does the reordering in CSS, so the DOM
            order stays the reading order for screen readers and for the one-column
            mobile layout. The row count has to be explicit for column flow to know
            where to break, and it is derived rather than hard-coded so a seventh
            entry re-balances instead of spilling into a third column. */}
        <div
          className="credit-table"
          style={{
            "--credit-rows": Math.ceil(CREDIT_COSTS.length / 2),
          }}
        >
          {CREDIT_COSTS.map((row) => (
            <div key={row.label} className="credit-row">
              {/* Figure and unit stack, both flush left. Inline-and-baseline put
                  the unit on the 22px figure's baseline, which dropped it below
                  the title's line and left it hanging between the title and its
                  note — belonging to neither. Stacked, the unit gets the column's
                  full width, so "per browser minute" reads as one line instead of
                  wrapping mid-phrase. */}
              <div className="credit-row-cost">
                <span
                  className={`pricing-figure${TBD_FIGURE_CLASS}`}
                  style={{
                    fontFamily: DISPLAY,
                    fontSize: 22,
                    fontVariantNumeric: "tabular-nums",
                    fontWeight: 700,
                    letterSpacing: "-.03em",
                    lineHeight: 1,
                  }}
                >
                  {tbd(row.cost)}
                </span>
                <span className="pricing-unit" style={{ fontFamily: MONO, fontSize: 10.5 }}>
                  {row.unit}
                </span>
              </div>
              <div className="credit-row-label">
                <span style={{ color: "var(--xrio-fg)", fontSize: 13, fontWeight: 600 }}>
                  {row.label}
                </span>
                <span style={{ color: "var(--xrio-fg2)", fontSize: 12 }}>{row.note}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Footer strip drops to the page background while the rows keep the
            raised surface, so it reads as a note attached to the table rather
            than a seventh row. Colors live in .credit-note because the light
            palettes need to override the accent — see globals.css. */}
        <p
          className="credit-note p-[16px_24px] md:p-[16px_28px]"
          style={{
            borderTop: "1px solid var(--xrio-border3)",
            fontFamily: MONO,
            fontSize: 10.5,
          }}
        >
          Failed requests aren&apos;t charged. Retries on our side are free.
        </p>
      </div>
    </>
  );
};

/* ── 3. TRY IT — the three entry points share one block: free credit, a
   per-site quote, and the full calculator. Uniform column shell so no one of
   the three reads as the primary path. ── */
const TryColumn = ({
  heading,
  body,
  children,
  isLast,
}: {
  heading: string;
  body: React.ReactNode;
  children: React.ReactNode;
  isLast: boolean;
}) => (
  <div
    className="p-[26px_24px] md:p-[30px_28px] flex flex-col try-column"
    style={{ borderRight: isLast ? "none" : "1px solid var(--xrio-border3)" }}
  >
    <h4
      className="mb-2"
      style={{
        color: "var(--xrio-fg)",
        fontFamily: DISPLAY,
        fontSize: "clamp(18px, 2vw, 22px)",
        fontWeight: 700,
        letterSpacing: "-.025em",
        lineHeight: 1.25,
      }}
    >
      {heading}
    </h4>
    <div className="mb-6" style={{ color: "var(--xrio-fg2)", fontSize: 13, lineHeight: 1.65 }}>
      {body}
    </div>
    <div className="mt-auto">{children}</div>
  </div>
);

/* Mocked classifier UI: the verdict derives straight from the input, so it
   resolves as you type — there's nothing to submit. Suggestions use a custom
   list rather than <datalist>, whose native popup can't be styled. */
const SiteChecker = () => {
  const [url, setUrl] = useState("");
  /* Credits mode answers in the currency the section above uses: the credit cost
     of one scrape, not the tier that produced it. */
  const { mode } = usePricingMode();
  const credits = mode === "credits";

  const typed = url.trim().length > 0;
  const hit = typed ? lookupSite(url) : null;
  const tierMeta = hit ? TIERS.find((t) => t.key === hit.tier) : null;
  const difficulty = hit ? DIFFICULTY[hit.tier] : null;

  /* Suggest on substring match, but not once the query already resolves —
     otherwise the list covers the answer it just produced. */
  const creditCost = hit ? TIER_CREDITS[hit.tier] : 0;
  const creditUnit = creditCost === 1 ? "credit" : "credits";

  return (
    <div className="flex flex-col sm:flex-row gap-3 sm:items-start">
      <div className="relative sm:flex-1">
        <input
          type="text"
          inputMode="url"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
          }}
          list="site-suggestions"
          placeholder="Enter URL"
          aria-label="Website domain"
          autoComplete="off"
          className="pricing-input w-full"
        />

        <datalist id="site-suggestions">
          {KNOWN_SITES.map((site) => (
            <option key={site.domain} value={site.domain}>
              {site.domain}
            </option>
          ))}
        </datalist>
      </div>

      {/* Result slot. Every state carries the same border and min-height so the
          column never changes height as the verdict resolves. */}
      {!typed && (
        <p
          className="site-slot sm:flex-1 pricing-dim"
          style={{
            border: "1px dashed var(--xrio-border)",
            fontFamily: MONO,
            fontSize: 11.5,
          }}
        >
          {credits ? "Get credits per scrape" : "Get tier and pricing"}
        </p>
      )}

      {typed && !hit && (
        <p
          className="site-slot sm:flex-1 pricing-unit"
          style={{
            border: "1px dashed var(--xrio-border3)",
            fontFamily: MONO,
            fontSize: 11.5,
          }}
        >
          Not in our index yet
        </p>
      )}

      {hit && tierMeta && difficulty !== null && (
        <div
          className="site-verdict site-slot sm:flex-1 flex items-center gap-3"
          style={{ border: "1px solid var(--xrio-accent)" }}
        >
          <span
            style={{
              background: "var(--xrio-accent-fill)",
              color: "var(--xrio-accent-fg, #080808)",
              flexShrink: 0,
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: ".08em",
              padding: "3px 7px",
              textTransform: "uppercase",
            }}
          >
            {difficulty}
          </span>
          <span
            style={{ color: "var(--xrio-fg)", fontSize: 12.5, fontWeight: 600, lineHeight: 1.35 }}
          >
            {credits && !RATES_TBD ? `${creditCost} ${creditUnit} / scrape` : tierMeta.name}
          </span>
        </div>
      )}
    </div>
  );
};

/* Free credits granted on signup in the credits model — the counterpart to the
   $5 of trial credit in the dollars model. */
const TRIAL_CREDITS = 3000;

const TryItBlock = () => {
  /* The trial has to be denominated in whatever currency the section above is
     using, or the two halves contradict each other. */
  const { mode } = usePricingMode();
  const credits = mode === "credits";

  const claimText = credits
    ? `Claim ${fmtCount(TRIAL_CREDITS)} credits`
    : `Claim $${TRIAL_DOLLARS} credit`;

  return (
    <>
      <h3
        className="mt-16 mb-6"
        style={{
          color: "var(--xrio-fg)",
          fontFamily: DISPLAY,
          fontSize: "clamp(22px, 2.8vw, 30px)",
          fontWeight: 700,
          letterSpacing: "-.025em",
          lineHeight: 1.15,
        }}
      >
        See what it costs for your workload.
      </h3>

      <div
        className="relative xrio-ticks-host"
        style={{
          background: "var(--xrio-surface)",
          border: "1px solid var(--xrio-border3)",
          borderRadius: "var(--xrio-r-surface)",
        }}
      >
        <span className="xrio-ticks" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        {/* Row 1 — the trial, full width.

            Bottom-aligned: the copy wraps to two lines while the figure is one
            tall glyph, so hanging both from the top left the copy's second line
            dangling below everything. Sitting them on a common bottom edge puts
            the figure's baseline and the copy's LAST line on one line, which is
            the edge the eye actually follows across the row. */}
        <div className="flex flex-col md:flex-row md:items-end gap-7 md:gap-12 p-[26px_24px] md:p-[32px_30px]">
          <div className="flex-shrink-0">
            <div className="flex items-baseline gap-[10px]">
              <span
                className={`pricing-figure pricing-trial-figure${TBD_FIGURE_CLASS}`}
                style={{
                  fontFamily: DISPLAY,
                  fontSize: "clamp(34px, 4.4vw, 46px)",
                  fontVariantNumeric: "tabular-nums",
                  fontWeight: 700,
                  letterSpacing: "-.03em",
                  lineHeight: 1,
                }}
              >
                {tbd(credits ? fmtCount(TRIAL_CREDITS) : `$${TRIAL_DOLLARS}`)}
              </span>
              <span className="pricing-unit" style={{ fontFamily: MONO, fontSize: 12.5 }}>
                {credits ? "free credits" : "to start"}
              </span>
            </div>
          </div>

          <div className="flex-1">
            <p style={{ color: "var(--xrio-fg2)", fontSize: 13, lineHeight: 1.65, maxWidth: 420 }}>
              {credits
                ? "No card required. Spend them on any tier — same draw-down rates as a paid plan."
                : "No card required. Spend it across any tier — drawn down at the same rates you'd pay after."}
            </p>
          </div>

          <span className="xrio-cta-primary pricing-submit flex-shrink-0 block text-center">
            {RATES_TBD ? "Start free" : claimText}
          </span>
        </div>

        {/* Row 2 — 55/45 in the checker's favour; it holds an input and a result,
            where the calculator is only a hand-off link. minmax(0,·) is load-
            bearing: bare fr tracks won't shrink below their content's min width,
            and the checker's input + result box push a plain 11fr_9fr past 3:1. */}
        <div
          className="grid grid-cols-1 md:grid-cols-[minmax(0,11fr)_minmax(0,9fr)] try-grid"
          style={{ borderTop: "1px solid var(--xrio-border3)" }}
        >
          <TryColumn
            heading="Check a site before you run it."
            isLast={false}
            body={
              credits
                ? "Enter a domain and we'll tell you what one scrape costs — whether it needs a browser, a proxy, or neither."
                : "Enter a domain and we'll tell you which tier it lands in — whether it needs a browser, a proxy, or neither."
            }
          >
            <SiteChecker />
          </TryColumn>

          <TryColumn
            heading="Model your whole workload."
            isLast
            body={
              credits
                ? "Mix tiers, set volumes, and see which plan's allowance covers it."
                : "Mix tiers, set volumes, and compare commitment levels side by side."
            }
          >
            <span
              aria-disabled="true"
              className="pricing-submit pricing-submit-ghost cs-link block text-center"
            >
              Open the calculator →
            </span>
          </TryColumn>
        </div>
      </div>
    </>
  );
};

export const Pricing = () => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const { mode } = usePricingMode();

  return (
    <div className="relative" ref={sectionRef}>
      <StarfieldCanvas sectionRef={sectionRef} />
      <div
        className="relative z-[2]"
        style={{ padding: "clamp(48px, 8vw, 96px) clamp(24px, 6vw, 72px)" }}
      >
        <h2
          className="mb-12"
          style={{
            fontFamily: DISPLAY,
            fontSize: "clamp(28px, 4vw, 44px)",
            fontWeight: 700,
            letterSpacing: "-.03em",
            lineHeight: 1.1,
            maxWidth: 640,
          }}
        >
          Simple pricing, no surprises.
        </h2>

        {/* Keyed so switching models remounts rather than reconciling — the two
            blocks share slider markup, and a reused input would carry the old
            model's index across. */}
        {mode === "credits" ? (
          <div key="credits">
            <CreditsPlansBlock />
            <CreditCostsBlock />
          </div>
        ) : (
          <div key="dollars">
            <PlansBlock />
          </div>
        )}

        <TryItBlock />
      </div>
    </div>
  );
};
