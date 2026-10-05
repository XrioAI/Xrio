"use client";

import { MacawHalftone } from "@/components/canvas/macaw-halftone";

export const ClosingCTA = () => (
  <section
    className="flex justify-center items-center text-center"
    style={{ padding: "clamp(64px, 10vw, 120px) clamp(20px, 4vw, 48px)" }}
  >
    <div className="flex flex-col items-center" style={{ gap: 0, maxWidth: 540 }}>
      <h2
        className="mb-5"
        style={{
          fontFamily: "var(--xrio-display-font, var(--font-space-grotesk), system-ui, sans-serif)",
          fontSize: "clamp(32px, 5.5vw, 62px)",
          fontWeight: 700,
          letterSpacing: "-.034em",
          lineHeight: 1.05,
        }}
      >
        Public web data,
        <br />
        in one command.
      </h2>

      {/* Logo mark */}
      <div className="mt-4 mb-8">
        <MacawHalftone
          style={{ height: "clamp(160px, 26vw, 300px)", width: "clamp(160px, 26vw, 300px)" }}
        />
      </div>

      <div className="flex items-center gap-6 flex-wrap justify-center">
        <span className="xrio-badge-soon text-[13px] font-medium px-5 py-[10px] rounded-sm">
          Coming Soon
        </span>
        <span aria-disabled="true" className="cs-link xrio-ink-link text-[13px] transition-colors">
          Read the docs →
        </span>
      </div>
    </div>
  </section>
);
