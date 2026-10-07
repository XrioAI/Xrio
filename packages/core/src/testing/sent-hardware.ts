import { expect } from "vite-plus/test";

import type { BrowserIdentityReport } from "../humanizer/report.ts";

export interface SentHardware {
  readonly cores: number;
  readonly memoryGb: number;
}

export const expectSentHardware = ({
  binary,
  surfaces,
  tells,
}: Pick<BrowserIdentityReport, "binary" | "surfaces" | "tells">): SentHardware | undefined => {
  const { cores, memoryGb, source } = surfaces.hardware;

  if (binary.fork !== "xrio") {
    expect({ source, unhonored: tells.includes("hardware-unhonored") }).toStrictEqual({
      source: "host",
      unhonored: true,
    });

    return undefined;
  }

  if (source === "host") {
    expect(tells).toContain("hardware-capped");

    return undefined;
  }

  expect(["drawn", "pinned"]).toContain(source);

  return { cores, memoryGb };
};
