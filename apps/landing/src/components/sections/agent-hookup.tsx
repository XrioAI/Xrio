"use client";

import { useEffect, useRef, useState } from "react";

/* Two ways in, side by side. The left one is the line a person pastes to hook their agent up.
   The right one is addressed to the agent itself — it fetches its own instructions and goes,
   and because there is no key to hand out, that is the whole onboarding.

   The commands are set in the recessed well the dashboard's url field uses, with the prompt in
   the theme's ink rule, so a command here reads the same as a command anywhere else on the page. */

export interface Cmd {
  tab: string;
  line: string;
}

const CONNECT: Cmd[] = [
  { line: "npx -y xrio-cli@latest mcp add", tab: "MCP" },
  { line: "npx -y xrio-cli@latest init", tab: "CLI" },
];

const ONBOARD: Cmd[] = [{ line: "curl -s xrio.com/agent/SKILL.md", tab: "cURL" }];

const CopyGlyph = ({ done }: { done: boolean }) =>
  done ? (
    <svg viewBox="0 0 16 16" width={13} height={13} aria-hidden="true">
      <path
        d="M3 8.6 6.2 12 13 4.6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" width={13} height={13} aria-hidden="true">
      <rect
        x="5.5"
        y="5.5"
        width="8"
        height="8"
        rx="1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
      />
      <path
        d="M10.5 3.5H3.9A1.4 1.4 0 0 0 2.5 4.9v6.6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinecap="round"
      />
    </svg>
  );

/* Two shapes for the same thing.

   "card" is the bordered block the agent band uses, where it is the only object in its half
   and can afford a frame. "line" is a single row — label, command, copy, one hairline under —
   for the feature grid, where two cards stacked made four rectangles in a cell that already
   sits inside a grid of rectangles. */
export const Terminal = ({
  cmds,
  variant = "card",
}: {
  cmds: Cmd[];
  variant?: "card" | "line";
}) => {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(0);

  const { line } = cmds[active];

  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(line);
    } catch {
      setCopied(false);

      return;
    }

    setCopied(true);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setCopied(false);
    }, 1400);
  };

  const tabs = (
    <div
      className={
        variant === "line" ? "flex shrink-0 items-center gap-2.5" : "flex items-center gap-1"
      }
    >
      {cmds.map(({ tab }, i) => (
        <button
          key={tab}
          type="button"
          onClick={() => {
            setActive(i);
          }}
          disabled={cmds.length === 1}
          style={{
            background:
              variant === "card" && i === active && cmds.length > 1
                ? "var(--xrio-well)"
                : "transparent",
            borderRadius: variant === "line" ? undefined : "calc(var(--xrio-r-control) - 4px)",
            color: i === active ? "var(--xrio-fg)" : "var(--xrio-ink-dim)",
            cursor: cmds.length === 1 ? "default" : "pointer",
            fontFamily: "var(--xrio-mono)",
            fontSize: 10.5,
            letterSpacing: ".1em",
            padding: variant === "line" ? 0 : "4px 9px",
            textTransform: "uppercase",
          }}
        >
          {tab}
        </button>
      ))}
    </div>
  );

  const copyButton = (
    <button
      type="button"
      onClick={() => {
        void copy();
      }}
      aria-label="Copy command"
      className="shrink-0"
      style={{
        borderRadius: variant === "line" ? undefined : "calc(var(--xrio-r-control) - 4px)",
        color: copied ? "var(--xrio-accent-text)" : "var(--xrio-ink-dim)",
        cursor: "pointer",
        padding: variant === "line" ? "2px 0 2px 8px" : "5px 7px",
      }}
    >
      <CopyGlyph done={copied} />
    </button>
  );

  const command = (
    <div
      className="flex min-w-0 flex-1 items-baseline gap-2 overflow-x-auto"
      style={{
        color: "var(--xrio-fg2)",
        fontFamily: "var(--xrio-mono)",
        fontSize: variant === "line" ? 11.5 : 12.5,
        lineHeight: 1.5,
      }}
    >
      <span className="xrio-prompt shrink-0">$</span>
      <code className="whitespace-pre">{line}</code>
    </div>
  );

  if (variant === "line") {
    return (
      <div
        className="flex flex-col gap-1.5 md:flex-row md:items-center md:gap-4"
        style={{ borderTop: "1px solid var(--xrio-border)", padding: "18px 0" }}
      >
        {/* A fixed track at md+, so both commands start on the same column whatever their
            label. Below md the label goes above instead: in a phone-width cell the track was
            eating a fifth of the measure and both commands ran off the end. */}
        <div className="shrink-0 md:w-14">{tabs}</div>
        <div className="flex min-w-0 flex-1 items-center">
          {command}
          {copyButton}
        </div>
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden"
      style={{
        background: "var(--xrio-surface)",
        border: "1px solid var(--xrio-border3)",
        borderRadius: "var(--xrio-r-control)",
      }}
    >
      <div
        className="flex items-center justify-between gap-3"
        style={{ borderBottom: "1px solid var(--xrio-border)", padding: "7px 8px 7px 10px" }}
      >
        {tabs}
        {copyButton}
      </div>

      <div style={{ background: "var(--xrio-well)", padding: "16px 14px" }}>{command}</div>
    </div>
  );
};

const Half = ({
  lead,
  rest,
  cmds,
  link,
  className,
}: {
  lead: string;
  rest: string;
  cmds: Cmd[];
  link: string;
  className: string;
}) => (
  <div className={className} style={{ borderColor: "var(--xrio-border)" }}>
    <p style={{ fontSize: 15.5, letterSpacing: "-.01em", lineHeight: 1.6, maxWidth: 400 }}>
      <span style={{ color: "var(--xrio-fg)", fontWeight: 600 }}>{lead}</span>{" "}
      <span style={{ color: "var(--xrio-fg2)" }}>{rest}</span>
    </p>

    <div className="mt-7">
      <Terminal cmds={cmds} />
    </div>

    <p
      className="mt-6"
      style={{ color: "var(--xrio-accent-text)", fontSize: 13.5, letterSpacing: "-.01em" }}
    >
      {link}
      <span style={{ marginLeft: 6 }}>&rarr;</span>
    </p>
  </div>
);

export const AgentHookup = () => (
  <div style={{ padding: "clamp(48px, 8vw, 96px) clamp(24px, 6vw, 72px)" }}>
    <h2 className="xrio-h2 text-center mx-auto" style={{ maxWidth: 620 }}>
      Connect any agent in one line.
    </h2>
    <p
      className="mt-6 mx-auto text-center"
      style={{ color: "var(--xrio-fg2)", fontSize: 13.5, lineHeight: 1.72, maxWidth: 430 }}
    >
      MCP or the CLI. No key to provision, no quota to negotiate, no dashboard in the way.
    </p>

    <div
      className="grid md:grid-cols-2 mt-14 pt-14"
      style={{ borderTop: "1px solid var(--xrio-border)" }}
    >
      <Half
        className="pb-12 md:pb-0 md:pr-14"
        lead="One command."
        rest="Connect your agent to Xrio through MCP or the CLI."
        cmds={CONNECT}
        link="View the docs"
      />
      <Half
        className="pt-12 md:pt-0 md:pl-14 border-t md:border-t-0 md:border-l"
        lead="Agent onboarding."
        rest="Are you an agent? Fetch this and start scraping. There is no key to wait for."
        cmds={ONBOARD}
        link="View the skill"
      />
    </div>
  </div>
);
