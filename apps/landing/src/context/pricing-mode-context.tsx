"use client";

import { createContext, useMemo, useContext, useState } from "react";

/* Two competing pricing structures, switchable from the design panel so they can
   be compared on the live page rather than in mockups.

   "dollars" — rates in $/1K requests, slider picks a monthly spend commitment.
   "credits" — one credit currency, slider picks a plan; each request tier costs a
   different number of credits. Firecrawl's model, in our compact layout. */
export type PricingModeKey = "dollars" | "credits";

interface PricingModeCtx {
  mode: PricingModeKey;
  setMode: (m: PricingModeKey) => void;
}

const PricingModeContext = createContext<PricingModeCtx | null>(null);

export const PricingModeProvider = ({ children }: { children: React.ReactNode }) => {
  const [mode, setMode] = useState<PricingModeKey>("dollars");

  const value = useMemo(() => ({ mode, setMode }), [mode]);

  return <PricingModeContext.Provider value={value}>{children}</PricingModeContext.Provider>;
};

export const usePricingMode = () => {
  const context = useContext(PricingModeContext);

  if (!context) {
    throw new Error("usePricingMode requires PricingModeProvider");
  }

  return context;
};
