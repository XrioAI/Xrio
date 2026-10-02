"use client";

const LINKS = ["Pricing", "Docs", "Changelog", "X", "Contact"] as const;

export const Footer = () => (
  <footer
    className="flex flex-col md:flex-row items-center md:justify-between gap-4 md:gap-0"
    style={{ padding: "32px clamp(24px, 6vw, 72px)" }}
  >
    <span className="xrio-ink-link-dim" style={{ fontFamily: "var(--xrio-mono)", fontSize: 12 }}>
      xrio
    </span>

    <div className="flex flex-wrap justify-center gap-x-6 gap-y-2">
      {LINKS.map((l) => (
        <span
          key={l}
          aria-disabled="true"
          className="xrio-ink-link-dim cs-link"
          style={{ fontSize: 11.5, transition: "color .15s" }}
        >
          {l}
        </span>
      ))}
    </div>

    <span className="xrio-ink-link-dim" style={{ fontFamily: "var(--xrio-mono)", fontSize: 11.5 }}>
      © 2026 Xrio
    </span>
  </footer>
);
