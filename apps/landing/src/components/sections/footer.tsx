"use client";

const LINKS = ["Docs", "Changelog", "Acceptable use", "X", "Contact"] as const;

export const Footer = () => (
  <footer className="flex flex-col gap-6" style={{ padding: "32px clamp(24px, 6vw, 72px)" }}>
    <div className="flex flex-col md:flex-row items-center md:justify-between gap-4 md:gap-0">
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

      <span
        className="xrio-ink-link-dim"
        style={{ fontFamily: "var(--xrio-mono)", fontSize: 11.5 }}
      >
        © 2026 Xrio
      </span>
    </div>

    {/* The statements every Xrio surface has to carry — see the copy guidelines. */}
    <p
      className="text-center md:text-left"
      style={{ color: "var(--xrio-ink-dim)", fontSize: 11.5, lineHeight: 1.7 }}
    >
      Public pages only. No logins, no account data. Respect site terms, robots.txt and rate limits.
      Use of Xrio must follow our acceptable use policy and the law.
    </p>
  </footer>
);
