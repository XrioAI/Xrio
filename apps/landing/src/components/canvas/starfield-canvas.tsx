"use client";

import { useRef, useEffect } from "react";

import { hexToRgb } from "@/lib/utils";

export const StarfieldCanvas = ({
  sectionRef,
}: {
  sectionRef: React.RefObject<HTMLDivElement | null>;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect((): ReturnType<React.EffectCallback> => {
    const canvas = canvasRef.current;
    const section = sectionRef.current;

    if (!canvas || !section) {
      return;
    }

    const ctx = canvas.getContext("2d");

    if (!ctx) {
      return;
    }

    const N_STARS = 380;
    const RADIUS = 340;
    const MAX_OP = 0.38;

    let H: number;
    let W: number;
    let dpr: number;
    let mx = -9999;
    let my = -9999;

    let glowCur = 0;
    let glowTarget = 0;
    let lastTs = 0;

    let stars: { x: number; y: number; r: number; vx: number; vy: number }[] = [];
    let starRaf: number;

    const seed = () => {
      stars = Array.from({ length: N_STARS }, () => {
        const angle = Math.random() * Math.PI * 2;
        const speed = 0.0125 + Math.random() * 0.0275;

        return {
          r: 0.5 + Math.random() * 0.9,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          x: Math.random() * W,
          y: Math.random() * H,
        };
      });
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1);
      W = section.offsetWidth;
      H = section.offsetHeight;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };

    const moveStar = (s: (typeof stars)[number], dt: number) => {
      const GRAV = 0.000042;
      const MAX_SPD = 0.14;
      const gx = mx - s.x;
      const gy = my - s.y;
      const gd = Math.hypot(gx, gy);

      if (gd > 0 && gd < RADIUS) {
        const pull = GRAV * dt * (1 - gd / RADIUS);
        s.vx += (gx / gd) * pull;
        s.vy += (gy / gd) * pull;
        const spd = Math.hypot(s.vx, s.vy);

        if (spd > MAX_SPD) {
          s.vx = (s.vx / spd) * MAX_SPD;
          s.vy = (s.vy / spd) * MAX_SPD;
        }
      }

      s.x += s.vx * dt;
      s.y += s.vy * dt;

      if (s.x < 0) {
        s.x += W;
      }

      if (s.x > W) {
        s.x -= W;
      }

      if (s.y < 0) {
        s.y += H;
      }

      if (s.y > H) {
        s.y -= H;
      }
    };

    const frame = (ts: number) => {
      const dt = Math.min(ts - lastTs, 40);
      lastTs = ts;
      glowCur += (glowTarget - glowCur) * (1 - Math.exp(-dt / 120));
      ctx.clearRect(0, 0, W, H);

      const cs = getComputedStyle(document.documentElement);
      const bgR = Number(cs.getPropertyValue("--xrio-bg-r").trim() || "0");
      const bgG = Number(cs.getPropertyValue("--xrio-bg-g").trim() || "0");
      const bgB = Number(cs.getPropertyValue("--xrio-bg-b").trim() || "0");
      const bgLuma = 0.2126 * bgR + 0.7152 * bgG + 0.0722 * bgB;
      const isLight = bgLuma > 127;

      /* dominant star color: material accent (brass on Vellum) on light themes, inverted-bg
         ink on dark themes — unchanged from the original behavior for every existing dark palette */
      const starRgb = isLight
        ? hexToRgb(cs.getPropertyValue("--xrio-accent2").trim() || "#F59E0B")
        : `${255 - bgR},${255 - bgG},${255 - bgB}`;

      /* brass-on-cream has less natural contrast than white-on-black, so light themes get a
         stronger glow and bigger dots to compensate — dark themes keep their original values */
      const opBoost = isLight ? 1.8 : 1;
      const rBoost = isLight ? 1.5 : 1;

      for (const s of stars) {
        moveStar(s, dt);

        if (glowCur < 0.005) {
          continue;
        }

        const dx = s.x - mx;
        const dy = s.y - my;
        const dist = Math.hypot(dx, dy);

        if (dist > RADIUS) {
          continue;
        }

        const t = dist / RADIUS;
        const op = Math.min(1, glowCur * MAX_OP * opBoost * (0.5 + 0.5 * Math.cos(t * Math.PI)));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * rBoost, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${starRgb},${op.toFixed(3)})`;
        ctx.fill();
      }

      starRaf = requestAnimationFrame(frame);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          lastTs = 0;
          starRaf = requestAnimationFrame(frame);
        } else {
          cancelAnimationFrame(starRaf);
        }
      },
      { threshold: 0.01 },
    );

    observer.observe(section);

    const toLocal = (e: MouseEvent) => {
      const rect = section.getBoundingClientRect();
      mx = e.clientX - rect.left;
      my = e.clientY - rect.top;
    };

    const onMouseMove = (e: MouseEvent) => {
      toLocal(e);
      glowTarget = 1;
    };

    const onMouseLeave = () => {
      glowTarget = 0;
      mx = -9999;
      my = -9999;
    };

    section.addEventListener("mousemove", onMouseMove);
    section.addEventListener("mouseleave", onMouseLeave);

    /* Touch has no hover, so without this the whole layer never draws
       anything on mobile/tablet — a tap/drag drives the same gravity glow
       a mouse does, and lifting the finger fades it out like mouseleave. */
    const toLocalTouch = (e: TouchEvent) => {
      const touch = e.touches.item(0);

      if (!touch) {
        return;
      }

      const rect = section.getBoundingClientRect();
      mx = touch.clientX - rect.left;
      my = touch.clientY - rect.top;
    };

    const onTouchMove = (e: TouchEvent) => {
      toLocalTouch(e);
      glowTarget = 1;
    };

    const onTouchEnd = () => {
      glowTarget = 0;
      mx = -9999;
      my = -9999;
    };

    section.addEventListener("touchstart", onTouchMove, { passive: true });
    section.addEventListener("touchmove", onTouchMove, { passive: true });
    section.addEventListener("touchend", onTouchEnd);
    section.addEventListener("touchcancel", onTouchEnd);

    window.addEventListener("resize", resize);
    resize();

    return () => {
      cancelAnimationFrame(starRaf);
      observer.disconnect();
      section.removeEventListener("mousemove", onMouseMove);
      section.removeEventListener("mouseleave", onMouseLeave);
      section.removeEventListener("touchstart", onTouchMove);
      section.removeEventListener("touchmove", onTouchMove);
      section.removeEventListener("touchend", onTouchEnd);
      section.removeEventListener("touchcancel", onTouchEnd);
      window.removeEventListener("resize", resize);
    };
  }, [sectionRef]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 pointer-events-none z-0"
    />
  );
};
