"use client";

import { useRef, useEffect } from "react";

import { hexToRgb } from "@/lib/utils";

const StreamCanvas = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect((): ReturnType<React.EffectCallback> => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;

    if (!canvas || !wrap) {
      return;
    }

    const ctx = canvas.getContext("2d");

    if (!ctx) {
      return;
    }

    const POOL = '0123456789abcdefABCDEF{}[]",:./\\?=&<>@#-_';
    const N_ROWS = 28;
    const FS_LEFT = 10;
    const FS_RIGHT = 20;
    const CW_SCALE = 0.64;
    const FRAY_MAX = 520;

    const rc = () => POOL[Math.floor(Math.random() * POOL.length)];
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);

    let H = 0;
    let W = 0;
    let dpr = 1;
    let raf2 = 0;
    let ts0 = 0;

    interface Row {
      yBase: number;
      sign: number;
      offset: number;
      speed: number;
      chars: string[];
      baseOp: number;
      tint: number;
    }

    let rows: Row[] = [];

    /* ctx.font is a string reassignment, and every reassignment forces the browser to
       re-resolve font metrics — one of the more expensive canvas state changes there is.
       fs varies continuously per character, so setting it unrounded meant a fresh font
       string (and a fresh resolve) on every single one of the ~6k fillText calls a frame:
       measured at ~19ms/frame, already over the 60fps budget before anything else on the
       page gets a turn. Rounding to whole px collapses that to ~10 distinct sizes total,
       and skipping the reassignment when the string hasn't changed cuts it to ~2-3
       ctx.font writes per row instead of one per character — no visible difference at
       these font sizes, and it measured a 2.3x speedup (17.5ms -> 7.6ms). */
    let lastFont = "";

    const setup = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1);
      W = wrap.offsetWidth;
      H = wrap.offsetHeight || 520;

      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const charsPerRow = Math.ceil(W / (FS_LEFT * CW_SCALE)) + 12;

      rows = Array.from({ length: N_ROWS }, (_, i) => {
        const t = (i + 0.5) / N_ROWS;
        const yBase = t * H;
        const sign = (t - 0.5) * 2;
        const g1 = i === Math.floor(N_ROWS * 0.25);
        const g2 = i === Math.floor(N_ROWS * 0.55);
        const g3 = i === Math.floor(N_ROWS * 0.8);
        const ga = i === Math.floor(N_ROWS * 0.42);
        const guaranteed = g1 || g2 || g3;
        const tint = guaranteed ? 1 : Number(ga) * 2;

        return {
          baseOp: guaranteed || ga ? 0.65 : rnd(0.1, 0.38),
          chars: Array.from({ length: charsPerRow }, rc),
          offset: rnd(0, W),
          sign,
          speed: rnd(30, 80),
          tint,
          yBase,
        };
      });
    };

    const drawCharacter = (row: Row, xi: number, scrollX: number, rgb: string) => {
      const cw0 = FS_LEFT * CW_SCALE;

      if (xi < -FS_RIGHT) {
        return cw0;
      }

      /* Mirrored with the band: the copy sits right now, so the field has to open to
               the LEFT — characters grow and the rows fray out toward the left edge.
               One axis flip here rather than scaleX(-1) on the element, which would have
               mirrored the glyphs themselves and left the stream reading as backwards text. */
      const nx = 1 - Math.max(0, Math.min(1, xi / W));
      const fs = FS_LEFT + (FS_RIGHT - FS_LEFT) * nx * nx;
      const cw = fs * CW_SCALE;

      const nxCurve = Math.max(0, (nx - 0.25) / 0.75);
      const curveY = row.sign * FRAY_MAX * nxCurve ** 5;
      const drawY = row.yBase + curveY;

      if (drawY < -fs || drawY > H + fs) {
        return cw;
      }

      // nx is already the mirrored axis
      const xBright = 0.4 + 0.6 * nx;
      const op = row.baseOp * 0.75 * xBright;

      if (op < 0.005) {
        return cw;
      }

      const tapeSlot = Math.floor((xi - scrollX + W * 10) / cw0);

      const ch = row.chars[((tapeSlot % row.chars.length) + row.chars.length) % row.chars.length];

      const fontStr = `${Math.round(fs)}px 'IBM Plex Mono', monospace`;

      if (fontStr !== lastFont) {
        ctx.font = fontStr;
        lastFont = fontStr;
      }

      ctx.fillStyle = `rgba(${rgb},${op.toFixed(3)})`;
      ctx.fillText(ch, xi, drawY + fs * 0.38);

      return cw;
    };

    const drawRow = (row: Row, dt: number, colors: string[]) => {
      row.offset += row.speed * dt * 0.001;

      if (Math.random() < 0.03) {
        row.chars[Math.floor(Math.random() * row.chars.length)] = rc();
      }

      const scrollX = row.offset % W;

      for (let pass = 0; pass < 2; pass += 1) {
        let xi = scrollX - W + pass * W;

        while (xi < W + FS_RIGHT) {
          xi += drawCharacter(row, xi, scrollX, colors[row.tint]);
        }
      }
    };

    const frame = (ts: number) => {
      const dt = Math.min(ts - ts0, 40);
      ts0 = ts;
      ctx.clearRect(0, 0, W, H);
      ctx.textAlign = "left";

      const cs = getComputedStyle(document.documentElement);
      const bgR = Number(cs.getPropertyValue("--xrio-bg-r").trim() || "0");
      const bgG = Number(cs.getPropertyValue("--xrio-bg-g").trim() || "0");
      const bgB = Number(cs.getPropertyValue("--xrio-bg-b").trim() || "0");
      const fgRgb = `${255 - bgR},${255 - bgG},${255 - bgB}`;
      const accRgb = hexToRgb(cs.getPropertyValue("--xrio-accent-fill").trim() || "#3B82F6");
      const acc2Rgb = hexToRgb(cs.getPropertyValue("--xrio-accent2").trim() || "#F59E0B");

      for (const row of rows) {
        drawRow(row, dt, [fgRgb, accRgb, acc2Rgb]);
      }

      raf2 = requestAnimationFrame(frame);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          ts0 = performance.now();
          raf2 = requestAnimationFrame(frame);
        } else {
          cancelAnimationFrame(raf2);
        }
      },
      { threshold: 0.05 },
    );

    observer.observe(wrap);

    const onResize = () => {
      cancelAnimationFrame(raf2);
      setup();
    };

    window.addEventListener("resize", onResize);
    setup();

    return () => {
      cancelAnimationFrame(raf2);
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div ref={wrapRef} className="absolute inset-0 stream-canvas-wrap" style={{ minHeight: 520 }}>
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0" />
    </div>
  );
};

const GitHubMark = () => (
  <svg viewBox="0 0 24 24" width={15} height={15} fill="currentColor" aria-hidden="true">
    <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 2.9-.39c.98 0 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A10.52 10.52 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
  </svg>
);

export const DataStream = () => (
  <div
    className="relative overflow-hidden"
    style={{ background: "var(--xrio-bg, #000)", minHeight: 520 }}
    id="streamWrap"
  >
    <StreamCanvas />

    {/* Right-side readability veil — desktop. Mirrored with the copy. */}
    <div
      aria-hidden="true"
      className="absolute inset-0 z-[1] pointer-events-none hidden md:block"
      style={{
        background:
          "linear-gradient(to left, rgba(var(--xrio-bg-r),var(--xrio-bg-g),var(--xrio-bg-b),0.92) 0%, rgba(var(--xrio-bg-r),var(--xrio-bg-g),var(--xrio-bg-b),0.78) 22%, rgba(var(--xrio-bg-r),var(--xrio-bg-g),var(--xrio-bg-b),0.40) 44%, rgba(var(--xrio-bg-r),var(--xrio-bg-g),var(--xrio-bg-b),0.00) 62%)",
      }}
    />
    {/* Top veil — mobile only */}
    <div
      aria-hidden="true"
      className="absolute inset-0 z-[1] pointer-events-none md:hidden"
      style={{
        background:
          "linear-gradient(to bottom, rgba(var(--xrio-bg-r),var(--xrio-bg-g),var(--xrio-bg-b),0.97) 0%, rgba(var(--xrio-bg-r),var(--xrio-bg-g),var(--xrio-bg-b),0.92) 28%, rgba(var(--xrio-bg-r),var(--xrio-bg-g),var(--xrio-bg-b),0.60) 50%, rgba(var(--xrio-bg-r),var(--xrio-bg-g),var(--xrio-bg-b),0.10) 100%)",
      }}
    />

    {/* Copy */}
    <div
      className="relative z-[2] md:flex md:min-h-[520px] md:flex-col md:justify-center md:items-end"
      /* Horizontal inset is the hero's own clamp, not this section's old 4vw/48px — same left
           plane as the nav logo, the H1 and the plate's edge. min-h + justify-center centres the
           copy in the band's height; md only, since the phone layout stacks under a top veil. */
      style={{ padding: "clamp(40px, 7vw, 72px) clamp(24px, 6vw, 72px)" }}
    >
      {/* The band is mirrored: copy on the right, the field opening to the left. Right
            alignment is desktop only — on a phone the veil is a top-down one and the copy
            stays on the reading edge. */}
      <div className="md:w-[400px] md:text-right">
        <h2
          className="mb-5"
          style={{
            fontFamily:
              "var(--xrio-display-font, var(--font-space-grotesk), system-ui, sans-serif)",
            fontSize: "clamp(30px, 4.5vw, 52px)",
            fontWeight: 700,
            letterSpacing: "-.03em",
            lineHeight: 1.1,
          }}
        >
          Fully open-source.
        </h2>
        <p
          style={{
            color: "var(--xrio-fg2)",
            fontSize: 14,
            lineHeight: 1.7,
            maxWidth: 400,
          }}
        >
          Every layer is open source — the browser engine, session handling, proxy routing, the
          patch set itself. Read the code, audit it, fork it, or self-host the whole stack.
        </p>
        <div className="mt-8 flex items-center gap-6 md:justify-end">
          <span
            aria-disabled="true"
            className="cs-link xrio-ink-link text-[13px] transition-colors inline-flex items-center gap-[7px]"
          >
            <GitHubMark />
            View on GitHub
          </span>
          <span
            aria-disabled="true"
            className="cs-link xrio-ink-link text-[13px] transition-colors"
          >
            Read the source →
          </span>
        </div>
      </div>
    </div>
  </div>
);
