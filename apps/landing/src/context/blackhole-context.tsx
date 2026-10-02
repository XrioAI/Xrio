"use client";

import { createContext, useMemo, useContext, useState } from "react";

interface BlackholeCtx {
  /* The void's horizontal framing, as a percentage of screen width. It aims the camera at
     -shift% of the frustum width, so the scene slides the OTHER way: raising it moves the void
     right, away from the copy column. 34, not the 24 it was — see the lookAtX note in
     BlackholeCanvas.build(). */
  shift: number;
  setShift: (v: number) => void;
  /* Where the horizon's centre should sit vertically, as a fraction of canvas height.
     `shift` already holds the void's horizontal position steady across aspect ratios — both the
     mass's world X and the lookAt target scale with the frustum half-width, so they cancel. The
     vertical axis has no such compensation: CAM_Y is a fixed world height while the frustum grows
     with the viewport, so the void slid from 51% to 66% of the frame between 3:4 and 21:9. This
     pins it. See the lens shift in BlackholeCanvas.build(). */
  anchorY: number;
  setAnchorY: (v: number) => void;
  opacity: number;
  setOpacity: (v: number) => void;
  scale: number;
  setScale: (v: number) => void;

  /* ── GPU HERO ──
     Separate from everything above, which belongs to the three.js BlackholeCanvas and is shaped
     by that renderer's controls (shift is a lookAt in frustum widths, scale divides its FOV).
     The WebGPU hero is a different camera and these are its own knobs, in units you can read off
     a screenshot rather than in either renderer's internals. Nothing here touches the old canvas
     and nothing above touches the new one. */
  /** Void centre, % of viewport width from the left. */
  gpuX: number;
  setGpuX: (v: number) => void;
  /** Void centre, % of viewport height from the top. */
  gpuY: number;
  setGpuY: (v: number) => void;
  /** Zoom multiplier on the camera's FOV; 1 is the shipped framing. */
  gpuSize: number;
  setGpuSize: (v: number) => void;
  /* Three rotations, one per camera axis, all in degrees. */
  /** X — elevation above the disk plane; how edge-on it is. Shader clamps at +-75.6. */
  gpuPitch: number;
  setGpuPitch: (v: number) => void;
  /** Y — orbit around the disk. A real viewpoint change: it re-lights the disk. */
  gpuYaw: number;
  setGpuYaw: (v: number) => void;
  /** Z — roll, positive counter-clockwise. Spins the picture; does not move the void. */
  gpuRoll: number;
  setGpuRoll: (v: number) => void;
}

/* Shipped desktop framing for the WebGPU hero, tuned on the sliders below against the three.js
   hero it replaced. Mobile does NOT use these — it has its own layout in the renderer, derived
   from BlackholeFigure's constants; see MOBILE_LAYOUT there. */
const GPU_DEFAULTS = { pitch: 14, roll: -23, size: 0.96, x: 82, y: 47, yaw: 0 };

/* ── ANCHOR ──
   Where the horizon's centre sits vertically, as a fraction of canvas height. This used to
   track the viewport: the band the hero copy is centred in runs from the nav padding to the
   foot of the hero, and its centre in canvas fractions moves with viewport height, so the
   number was computed rather than typed. It is a flat 61% now, by choice — one position that
   holds across the range instead of one that is exactly centred at every height. Nudged down
   from 54% so the void's gap to the right and bottom viewport edges reads as equal. */
const ANCHOR_Y = 0.61;

const BlackholeContext = createContext<BlackholeCtx | null>(null);

export const BlackholeProvider = ({ children }: { children: React.ReactNode }) => {
  const [shift, setShift] = useState(34);
  const [anchorY, setAnchorY] = useState(ANCHOR_Y);
  const [opacity, setOpacity] = useState(0.75);
  const [scale, setScale] = useState(1);
  const [gpuX, setGpuX] = useState(GPU_DEFAULTS.x);
  const [gpuY, setGpuY] = useState(GPU_DEFAULTS.y);
  const [gpuSize, setGpuSize] = useState(GPU_DEFAULTS.size);
  const [gpuPitch, setGpuPitch] = useState(GPU_DEFAULTS.pitch);
  const [gpuYaw, setGpuYaw] = useState(GPU_DEFAULTS.yaw);
  const [gpuRoll, setGpuRoll] = useState(GPU_DEFAULTS.roll);

  const value = useMemo(
    () => ({
      anchorY,
      gpuPitch,
      gpuRoll,
      gpuSize,
      gpuX,
      gpuY,
      gpuYaw,
      opacity,
      scale,
      setAnchorY,
      setGpuPitch,
      setGpuRoll,
      setGpuSize,
      setGpuX,
      setGpuY,
      setGpuYaw,
      setOpacity,
      setScale,
      setShift,
      shift,
    }),
    [anchorY, opacity, scale, shift, gpuX, gpuY, gpuSize, gpuPitch, gpuYaw, gpuRoll],
  );

  return <BlackholeContext.Provider value={value}>{children}</BlackholeContext.Provider>;
};

export const useBlackhole = () => {
  const context = useContext(BlackholeContext);

  if (!context) {
    throw new Error("useBlackhole requires BlackholeProvider");
  }

  return context;
};
