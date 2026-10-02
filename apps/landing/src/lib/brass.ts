/**
 * The committed brass, read from the theme at runtime so the canvas figure
 * never invents a colour: DesignPanel's `applyTheme` sets these per-palette as
 * inline custom properties on `<html>`, so reading live keeps the figure in sync
 * with whichever palette is active. The fallback is the default Void accent, for
 * the one frame before styles resolve.
 *
 * --xrio-accent-fill, not --xrio-accent. On the dark palettes fill chains back to
 * the accent and nothing changes, but Vellum's accent is now a dark mark colour
 * that only has to survive as 10px text, and a figure built from it came out
 * olive. The fill is the CTA's yellow, so every canvas figure is the same yellow
 * as the button, with no per-figure compensation: a --xrio-accent-figure token
 * was tried on the assumption that the closing halftone's scan gradient darkened
 * its ink, but that gradient is a separate 1px overlay — the dots draw at the
 * source colour, so pre-lightening only made the figure brighter than the CTA.
 */
export const readBrass = (el: HTMLElement) => {
  const cs = getComputedStyle(el);

  const raw =
    cs.getPropertyValue("--xrio-accent-fill").trim() ||
    cs.getPropertyValue("--xrio-accent").trim() ||
    "#d3bd89";

  const hex = raw.startsWith("#") ? raw.slice(1) : null;

  if (hex?.length === 6) {
    return {
      b: Number.parseInt(hex.slice(4, 6), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      r: Number.parseInt(hex.slice(0, 2), 16),
    };
  }

  const m = /(?<r>\d+)[,\s]+(?<g>\d+)[,\s]+(?<b>\d+)/u.exec(raw);

  if (m?.groups) {
    return { b: Number(m.groups.b), g: Number(m.groups.g), r: Number(m.groups.r) };
  }

  return { b: 0x89, g: 0xbd, r: 0xd3 };
};
