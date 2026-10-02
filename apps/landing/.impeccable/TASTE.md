# Xrio Sites — design brief for impeccable

Marketing site for a scraping/extraction API. One long single-page scroll.
Audience is developers; the site should read like good developer tooling, not
like a SaaS template.

## Direction

Deep-space retrofuturism. Dark, quiet, and technical by default. The mood is an
instrument panel or an observatory readout — not a dashboard, not a startup
landing page. Restraint is the point: large empty areas are intentional, and
density is reserved for the places that earn it (terminal demo, credit table).

Scale contrast is the primary compositional tool. Very large display type
against very small mono labels, with little in between. Where a hierarchy step
feels missing, prefer changing size or color-weight over adding a new tier.

## Type

- `--font-space-grotesk` — display / headings (700)
- `--font-ibm-plex-mono` — labels, units, code, all micro-copy (10–11px)
- `--font-anta`, `--font-fraunces` — alternate display faces, panel-selectable

Mono at small sizes carries the technical register. Numbers use
`font-variant-numeric: tabular-nums` and negative letter-spacing (-.03em) at
display sizes.

## Palettes

Three, switchable at runtime from the design panel. Every color is a
`--xrio-*` CSS custom property written by `applyTheme()` in DesignPanel.tsx.

| key      | label     | bg        | ink       | accent    |
| -------- | --------- | --------- | --------- | --------- |
| `mono`   | Mono      | `#050505` | white     | `#ffffff` |
| `vellum` | Vellum    | `#F4EFE5` | `#24201A` | `#755718` |
| `cyan`   | Cyanotype | `#EAF2F4` | `#122A36` | `#87d2f2` |

Mono is the canonical default. The two light themes are equal citizens, not
afterthoughts — check both before calling anything done.

## Hard rules

1. **Never hardcode a color.** Always a `--xrio-*` token. Channel vars only
   exist for bg (`--xrio-bg-r/g/b`); there is no `--xrio-fg-r/g/b`.
2. **Keep the opacity ladder intact.** `fg` / `fg2` / `fg-hi` / `fg-mid` /
   `fg-dim` / `fg-lo` are distinct hierarchy steps. Do not collapse or delete
   steps to fix a contrast issue — fix the one token in the one place.
3. **Scope fixes narrowly.** A problem in one section gets fixed in that
   section. Do not apply blanket `[data-scheme="light"]` rules across the site.
4. **`--radius-sm` is deliberately 6px**, not Tailwind's stock 4px
   (`calc(var(--radius) * 0.6)`). Leave it.
5. **Inline `style` beats a class.** Many figures set `fontSize`/`fontWeight`
   inline; a class alone will silently only apply `color`.

## Known, deliberate exceptions — do not "fix" these

- **Cyanotype's credit figures measure ~1.48:1** against their surface. The
  accent `#87d2f2` is a button _fill_ color, and using it for the numbers was
  an explicit design decision to match the CTA. Flagging it is correct;
  changing it is not.
- **Vellum's `accent2` (`#D3BD89`) is material-only** — 1.9:1 on light
  surfaces. It may tint, wash, or fill, but must never carry text, icons, or
  borders.
- **Cyanotype routes running copy** to `--xrio-accent-muted-fg` (`#3C5A68`)
  via `.pricing-accent-text`, because the pale fill accent can't carry text.
- **Dark palettes' `--xrio-fg-dim` sits at ~3.16:1** — pre-existing, known,
  and intentionally untouched.
- **Pricing figures render as em dashes.** `RATES_TBD` in Pricing.tsx gates
  every rate until pricing is decided. The dashes are quieted on purpose
  (weight 400, `--xrio-fg-dim`, ~62% size). Not a missing-content bug.
- **`.credit-row` uses `align-items: flex-start`, not `baseline`.** Baseline
  matched baselines but left the tall figure's ink 5.55px above the title's.
  Optical alignment (ink tops) beats baseline alignment here. The
  `margin-top: -2.2px` on the unit is a measured half-leading correction.

## Copy tone

Plain, declarative, specific. Address the reader's problem, not the product's
cleverness. Never write in the machine's point of view — describe what the page
being scraped is like, not what the scraper does. No exclamation marks, no
"effortlessly", no "unleash", no em-dash-joined hype clauses.

## Verification

Anything visual must be checked in all three palettes and at mobile width.
`puppeteer` and `lighthouse` are available as devDependencies for measurement
— prefer measuring to eyeballing when the question is geometric.
