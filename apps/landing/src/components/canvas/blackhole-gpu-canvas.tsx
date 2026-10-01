"use client";

import { useEffect, useRef, useState } from "react";

import { BlackholeFigure } from "@/components/canvas/blackhole-figure";
import { useBlackhole } from "@/context/blackhole-context";

import { createRenderer } from "./blackhole-gpu/renderer";

/** WebGPU black hole (vgpu multi-pass bake → shade → bloom). Drop-in for BlackholeCanvas:
 *  fills its parent, and takes its framing from the GPU-hero controls in BlackholeContext, which
 *  the design panel exposes as X / Y / Size plus a rotation per camera axis. Those are its own; the panel's Shift,
 *  Anchor Y, Opacity and Scale still belong to the three.js BlackholeCanvas and are untouched by
 *  this. See setFraming in blackhole-gpu/renderer.ts for the mapping onto the camera uniforms. */
export const BlackholeGpuCanvas = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ReturnType<typeof createRenderer> | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const { gpuX, gpuY, gpuSize, gpuPitch, gpuYaw, gpuRoll } = useBlackhole();

  useEffect((): ReturnType<React.EffectCallback> => {
    let cancelled = false;
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const renderer = createRenderer({
      canvas,
      /* Fires for device loss too, which happens long after `ready` has resolved — so this, not
         the rejection below, is what covers a GPU reset mid-session. */
      onFailure: (e) => {
        console.error("[blackhole-gpu]", e);

        if (!cancelled) {
          setFailed(true);
        }
      },
    });

    rendererRef.current = renderer;

    const showWhenReady = async () => {
      try {
        await renderer.ready;

        if (!cancelled) {
          setIsReady(true);
        }
      } catch {
        // onFailure already switches to the Canvas 2D fallback, including device loss.
      }
    };

    void showWhenReady();

    return () => {
      cancelled = true;
      rendererRef.current = null;
      renderer.dispose();
    };
  }, []);

  /* Declared after the mount effect, so on the first pass the renderer already exists and this
     seeds the framing; afterwards it is the path a slider move or a resize takes. setFraming
     before init() finishes is fine — it writes settings, which initialize() reads when it bakes. */
  useEffect(() => {
    rendererRef.current?.setFraming({
      pitchDeg: gpuPitch,
      rollDeg: gpuRoll,
      size: gpuSize,
      x: gpuX,
      y: gpuY,
      yawDeg: gpuYaw,
    });
  }, [gpuX, gpuY, gpuSize, gpuPitch, gpuYaw, gpuRoll]);

  if (failed) {
    return <BlackholeFigure className="size-full" />;
  }

  return (
    <canvas
      ref={canvasRef}
      /* Decorative, like the figure it replaced — nothing here is content. */
      aria-hidden="true"
      className={`block h-full w-full touch-none transition-opacity duration-500 ${
        isReady ? "opacity-100" : "opacity-0"
      }`}
    />
  );
};
