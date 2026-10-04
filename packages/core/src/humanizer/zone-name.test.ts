import { describe, expect, it } from "vite-plus/test";

import { canonicalZone } from "./zone-name.ts";

describe(canonicalZone, () => {
  it.each([
    ["America/Chicago", "America/Chicago"],
    ["america/chicago", "America/Chicago"],
    ["UTC", "UTC"],
    ["utc", "UTC"],
    ["Etc/UTC", "UTC"],
    ["Etc/GMT+5", "Etc/GMT+5"],
    ["Europe/Kyiv", "Europe/Kiev"],
    ["Asia/Kolkata", "Asia/Calcutta"],
    ["Asia/Calcutta", "Asia/Calcutta"],
    ["Australia/Adelaide", "Australia/Adelaide"],
  ])("names %s as %s, the spelling Chrome reports", (zone, named) => {
    expect(canonicalZone(zone)).toBe(named);
  });

  it.each([
    "Mars/Olympus",
    "",
    " UTC",
    "UTC ",
    "Etc/Unknown",
    "+05:30",
    "-08",
    "+0530",
    "Europe/Berlin\0",
    undefined,
  ])("names no zone for %j", (zone) => {
    expect(canonicalZone(zone)).toBeUndefined();
  });
});
