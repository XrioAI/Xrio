import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

/* Every caller already OR-guards its input against a literal hex fallback
   (`cs.getPropertyValue(...) || "#3B82F6"`), so this only misses on a
   genuinely malformed computed value. */
export const hexToRgb = (hex: string): string => {
  const m = /^#?(?<r>[0-9a-f]{2})(?<g>[0-9a-f]{2})(?<b>[0-9a-f]{2})$/iu.exec(hex.trim());

  if (m?.groups) {
    return `${Number.parseInt(m.groups.r, 16)},${Number.parseInt(m.groups.g, 16)},${Number.parseInt(m.groups.b, 16)}`;
  }

  return "255,255,255";
};
