"use client";

import { createContext, useMemo, useContext, useState } from "react";

export type ShaderKey = "none" | "film" | "pixel";

interface ShaderCtx {
  shader: ShaderKey;
  setShader: (k: ShaderKey) => void;
}

const ShaderContext = createContext<ShaderCtx | null>(null);

export const ShaderProvider = ({ children }: { children: React.ReactNode }) => {
  const [shader, setShader] = useState<ShaderKey>("none");

  const value = useMemo(() => ({ setShader, shader }), [shader]);

  return <ShaderContext.Provider value={value}>{children}</ShaderContext.Provider>;
};

export const useShader = () => {
  const context = useContext(ShaderContext);

  if (!context) {
    throw new Error("useShader requires ShaderProvider");
  }

  return context;
};
