import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { readHostZone } from "./host-zone.ts";

describe(readHostZone, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the zone the host exports", () => {
    vi.stubEnv("TZ", "Asia/Kolkata");

    expect(readHostZone()).toBe("Asia/Kolkata");
  });

  it("reads an empty zone as empty, not as unset", () => {
    vi.stubEnv("TZ", "");

    expect(readHostZone()).toBe("");
  });

  it("reads nothing when the host exports no zone", () => {
    vi.stubEnv("TZ", "to be removed");
    delete process.env.TZ;

    expect(readHostZone()).toBeUndefined();
  });
});
