"use client";

import { Menu, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const NAV_LINKS = ["Docs", "Examples", "Changelog"] as const;

export const Nav = () => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Same disclosure contract as the theme panel: outside click / Escape close it,
  // and focus moves in on open, back to the toggle on close.
  useEffect((): ReturnType<React.EffectCallback> => {
    if (!mobileOpen) {
      return;
    }

    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && menuRef.current && !menuRef.current.contains(e.target)) {
        setMobileOpen(false);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileOpen(false);
      }
    };

    const trigger = toggleRef.current;

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKeyDown);
    menuRef.current?.focus();

    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [mobileOpen]);

  return (
    <nav
      className="fixed inset-x-0 top-0 z-[200] flex h-[var(--xrio-nav-h)] items-center px-6 md:px-[72px]"
      style={{
        backdropFilter: "blur(4px)",
        /* MINIMAL, not frosted. --xrio-frost is a tinted glass slab: it lifts the bar off the
           page with its own grey and smears the disk across the whole bar at 12px. The plate it
           was matched to is gone, so the nav is the only pane left and has nothing to agree
           with — it is just the page, held still, with a hairline under it. The page's own
           colour at 64% and a 4px blur: enough to keep type legible over the disk, not enough
           to read as a second surface. No inset shading either; that cue existed to give the
           slab thickness. */
        background: "rgba(var(--xrio-bg-r),var(--xrio-bg-g),var(--xrio-bg-b),0.64)",
        borderBottom: "1px solid var(--xrio-border)",
      }}
    >
      {/* Logo */}
      <a
        href="#hero"
        aria-label="xrio"
        className="mr-auto flex items-center gap-[10px]"
        style={{ color: "var(--xrio-fg)" }}
      >
        <span
          aria-hidden="true"
          className="xrio-logo"
          style={{ flexShrink: 0, height: 32, width: 32 }}
        />
        {/* Not a text node — see .xrio-wordmark. Both halves of the lockup are masks now, so they
            take their colour from the same currentColor and cannot drift apart. */}
        <span aria-hidden="true" className="xrio-wordmark" />
      </a>

      {/* Links — hidden on mobile, replaced by the menu button below */}
      <div className="hidden md:flex items-center gap-8">
        {NAV_LINKS.map((label) => (
          <span
            key={label}
            aria-disabled="true"
            className="cs-link xrio-ink-link text-[13px] transition-colors"
          >
            {label}
          </span>
        ))}

        <div
          style={{
            background: "var(--xrio-border2)",
            height: 16,
            margin: "0 2px",
            width: 1,
          }}
        />

        <span className="xrio-badge-soon text-[13px] font-medium rounded-sm px-[14px] py-[6px]">
          Coming Soon
        </span>
      </div>

      {/* Mobile: menu toggle + CTA */}
      <div className="flex md:hidden items-center gap-3">
        <button
          type="button"
          ref={toggleRef}
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          aria-controls="nav-mobile-menu"
          onClick={() => {
            setMobileOpen((o) => !o);
          }}
          style={{
            alignItems: "center",
            background: "none",
            border: "none",
            color: "var(--xrio-fg2)",
            cursor: "pointer",
            display: "flex",
            height: 32,
            justifyContent: "center",
            width: 32,
          }}
        >
          {mobileOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <span className="xrio-badge-soon text-[12px] font-medium rounded-sm px-3 py-[5px]">
          Coming Soon
        </span>
      </div>

      {mobileOpen && (
        <div
          id="nav-mobile-menu"
          ref={menuRef}
          tabIndex={-1}
          className="md:hidden flex flex-col"
          style={{
            backdropFilter: "blur(6px)",
            /* The dropped menu is near-opaque where the bar is not: it has to hold a column of
               links over whatever is scrolling behind it. */
            background: "rgba(var(--xrio-bg-r),var(--xrio-bg-g),var(--xrio-bg-b),0.96)",
            borderTop: "1px solid var(--xrio-border2)",
            left: 0,
            padding: "8px 24px 16px",
            position: "absolute",
            right: 0,
            top: "100%",
          }}
        >
          {NAV_LINKS.map((label) => (
            <span
              key={label}
              aria-disabled="true"
              className="cs-link xrio-ink-link text-[14px] transition-colors"
              style={{ padding: "12px 0" }}
            >
              {label}
            </span>
          ))}
        </div>
      )}
    </nav>
  );
};
