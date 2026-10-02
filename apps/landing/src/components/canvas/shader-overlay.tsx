"use client";

import { useRef, useEffect } from "react";

import { useShader } from "@/context/shader-context";

export const ShaderOverlay = () => {
  const { shader, setShader } = useShader();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wakeRef = useRef<(() => void) | null>(null);

  /* frame() runs outside React's render pass and needs the live shader, but assigning to a ref
     during render leaves the write behind even when React discards that render. Synced in an
     effect instead, and declared before the wake effect below so a frame woken by a shader
     change never reads the previous value. */
  const shaderRef = useRef(shader);
  useEffect(() => {
    shaderRef.current = shader;
  }, [shader]);

  useEffect((): ReturnType<React.EffectCallback> => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");

    if (!ctx) {
      return;
    }

    let raf = 0;
    let lastTs = 0;
    /* true while the loop is stopped because the shader is 'none'; the restart effect below
       checks it via rafRef to know whether a wake-up is needed */
    let parked = false;
    // Rolling average of frame dt over 10 frames
    const dtWindow: number[] = [];
    const DT_WINDOW = 10;
    // ~45fps threshold
    const AUTO_DISABLE_MS = 22;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    /* Grain is drawn once into a small offscreen tile and then tiled across the viewport, rather
       than scattered a pixel at a time. The old version did W*H*0.08 fillRects per frame — at
       1512x982 that is ~119k canvas calls plus ~119k template-literal fillStyle strings every
       frame, which is what made 'film' the most expensive thing on the page. A 256px tile of
       the same density is ~5.2k specks generated once per resize; each frame then just stamps
       it with a random offset, so the grain still swims and never shows a visible seam. */
    const GRAIN_TILE = 256;
    const grainTile = document.createElement("canvas");
    grainTile.width = GRAIN_TILE;
    grainTile.height = GRAIN_TILE;
    const grainCtx = grainTile.getContext("2d");

    if (!grainCtx) {
      return;
    }

    const buildGrainTile = () => {
      grainCtx.clearRect(0, 0, GRAIN_TILE, GRAIN_TILE);
      const N = Math.floor(GRAIN_TILE * GRAIN_TILE * 0.08);
      /* bucket by brightness so fillStyle is assigned a handful of times instead of once per
         speck — assigning it parses a color string, which dominated the old loop */
      const BUCKETS = 6;

      for (let b = 0; b < BUCKETS; b += 1) {
        const v = Math.floor(60 + (180 * (b + 0.5)) / BUCKETS);
        grainCtx.fillStyle = `rgba(${v},${v},${v},0.05)`;

        for (let i = 0; i < N / BUCKETS; i += 1) {
          grainCtx.fillRect(Math.random() * GRAIN_TILE, Math.random() * GRAIN_TILE, 2, 2);
        }
      }
    };

    buildGrainTile();

    const drawFilm = () => {
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      /* random sub-tile offset each frame so the pattern never sits still */
      const ox = -Math.floor(Math.random() * GRAIN_TILE);
      const oy = -Math.floor(Math.random() * GRAIN_TILE);

      for (let y = oy; y < H; y += GRAIN_TILE) {
        for (let x = ox; x < W; x += GRAIN_TILE) {
          ctx.drawImage(grainTile, x, y);
        }
      }
    };

    const drawPixel = () => {
      const W = canvas.width;
      const H = canvas.height;
      // Simple CSS pixelation via canvas scaling trick
      // Draw a 1/8 scale dark grid overlay
      const BLOCK = 8;
      ctx.clearRect(0, 0, W, H);

      for (let y = 0; y < H; y += BLOCK) {
        for (let x = 0; x < W; x += BLOCK) {
          if ((x + y) % (BLOCK * 2) === 0) {
            ctx.fillStyle = "rgba(0,0,0,0.06)";
            ctx.fillRect(x, y, BLOCK, BLOCK);
          }
        }
      }
    };

    const frame = (ts: number) => {
      const dt = lastTs ? Math.min(ts - lastTs, 100) : 16;
      lastTs = ts;

      const { current } = shaderRef;

      /* 'none' is the default, so without this the loop spent every frame clearing a
         full-viewport canvas in order to draw nothing. Park the loop instead: the effect below
         restarts it when the shader changes, so there is nothing to poll for. One last clear
         runs before parking so no stale grain is left on screen. */
      if (current === "none") {
        if (!parked) {
          parked = true;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          dtWindow.length = 0;
        }

        raf = 0;

        return;
      }

      parked = false;

      // Track rolling average for adaptive shutoff
      dtWindow.push(dt);

      if (dtWindow.length > DT_WINDOW) {
        dtWindow.shift();
      }

      const avg = dtWindow.reduce((a, b) => a + b, 0) / dtWindow.length;

      if (dtWindow.length >= DT_WINDOW && avg > AUTO_DISABLE_MS) {
        setShader("none");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        raf = requestAnimationFrame(frame);

        return;
      }

      /* drawFilm/drawPixel each clear before drawing, so no clear is needed here */
      if (current === "film") {
        drawFilm();
      } else {
        drawPixel();
      }

      raf = requestAnimationFrame(frame);
    };

    const onResize = () => {
      resize();
    };

    window.addEventListener("resize", onResize);
    resize();
    raf = requestAnimationFrame(frame);

    /* published so the shader-change effect can restart a parked loop without re-running this
       effect (which would tear down and rebuild the canvas context on every shader switch) */
    wakeRef.current = () => {
      if (raf === 0) {
        lastTs = 0;
        raf = requestAnimationFrame(frame);
      }
    };

    return () => {
      cancelAnimationFrame(raf);
      raf = 0;
      wakeRef.current = null;
      window.removeEventListener("resize", onResize);
    };
  }, [setShader]);

  /* Wake the loop when the shader turns on. Separate from the effect above so that switching
     shaders does not rebuild the canvas context. */
  useEffect(() => {
    if (shader !== "none") {
      wakeRef.current?.();
    }
  }, [shader]);

  // Hide canvas when shader is none for zero composite cost
  const hidden = shader === "none";

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        height: "100%",
        inset: 0,
        opacity: hidden ? 0 : 1,
        pointerEvents: "none",
        position: "fixed",
        transition: "opacity 0.3s",
        width: "100%",
        zIndex: 150,
      }}
    />
  );
};
