"use client";

import { createContext, useMemo, useContext, useState } from "react";

interface EquatorDef {
  blur: number;
  width: number;
  span: number;
  squash: number;
  squashX: number;
  opacity: number;
  pulse: number;
  angles: number[];
}

export type CoronaKey = "none" | "minimal" | "full";

/* Ported verbatim from the pre-Next build (_archive/Xrio.html, `CORONAS`). "full" stacks four
   near-identical equators rather than one heavier ring: each is drawn and gradient-faded on its
   own canvas before being stamped, so the small squash/squashX offsets between them accumulate
   into a banded halo. A single ring with 4x the width just reads as a thick line. */
const CORONAS: Record<CoronaKey, EquatorDef[]> = {
  full: [
    {
      angles: [0, Math.PI],
      blur: 0,
      opacity: 1,
      pulse: 1,
      span: 0.5,
      squash: 1.15,
      squashX: 1,
      width: 0.1,
    },
    {
      angles: [0, Math.PI],
      blur: 0,
      opacity: 1,
      pulse: 1,
      span: 0.5,
      squash: 1.2,
      squashX: 1,
      width: 0.1,
    },
    {
      angles: [0, Math.PI],
      blur: 0,
      opacity: 1,
      pulse: 1,
      span: 0.5,
      squash: 1.2,
      squashX: 1.05,
      width: 0.1,
    },
    {
      angles: [0, Math.PI],
      blur: 0,
      opacity: 1,
      pulse: 1,
      span: 0.5,
      squash: 1.15,
      squashX: 1,
      width: 0.1,
    },
  ],
  minimal: [
    {
      angles: [0, Math.PI],
      blur: 0,
      opacity: 1,
      pulse: 1,
      span: 0.5,
      squash: 1.15,
      squashX: 1,
      width: 0.1,
    },
  ],
  none: [],
};

interface CoronaCtx {
  equators: EquatorDef[];
  corona: CoronaKey;
  setCorona: (k: CoronaKey) => void;
}

const CoronaContext = createContext<CoronaCtx | null>(null);

export const CoronaProvider = ({ children }: { children: React.ReactNode }) => {
  const [corona, setCorona] = useState<CoronaKey>("none");

  const value = useMemo(() => ({ corona, equators: CORONAS[corona], setCorona }), [corona]);

  return <CoronaContext.Provider value={value}>{children}</CoronaContext.Provider>;
};

export const useCorona = () => {
  const context = useContext(CoronaContext);

  if (!context) {
    throw new Error("useCorona requires CoronaProvider");
  }

  return context;
};
