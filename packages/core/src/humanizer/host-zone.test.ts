import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { readHostZone } from "./host-zone.ts";

describe(readHostZone, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["Asia/Kolkata", "Asia/Calcutta"],
    ["Europe/Kyiv", "Europe/Kiev"],
    ["America/Chicago", "America/Chicago"],
    [":UTC", "UTC"],
    ["Etc/UTC", "UTC"],
    [":Europe/Berlin", "Europe/Berlin"],
    ["posix/Europe/Berlin", "Europe/Berlin"],
    ["right/Europe/Berlin", "Europe/Berlin"],
    ["EST5EDT", "America/New_York"],
    ["CET", "Europe/Brussels"],
  ])("presents the host's TZ=%s as %s", (ambient, zone) => {
    vi.stubEnv("TZ", ambient);

    expect(readHostZone()).toBe(zone);
  });

  it.each([
    [":/usr/share/zoneinfo/Asia/Tokyo", "Asia/Tokyo"],
    ["/usr/share/zoneinfo/Asia/Tokyo", "Asia/Tokyo"],
    ["/usr/share/zoneinfo/Asia/Kolkata", "Asia/Calcutta"],
    [":/usr/share/zoneinfo/posix/America/Chicago", "America/Chicago"],
    ["/usr/share/zoneinfo/right/Europe/Berlin", "Europe/Berlin"],
    ["/var/db/timezone/zoneinfo/Europe/Berlin", "Europe/Berlin"],
    [":/var/db/timezone/zoneinfo/UTC", "UTC"],
  ])("presents the host's TZ=%s as %s", (ambient, zone) => {
    vi.stubEnv("TZ", ambient);

    expect(readHostZone()).toBe(zone);
  });

  it.each([
    "/usr/share/zoneinfo/Mars/Olympus",
    "/usr/share/zoneinfo/",
    "/usr/share/zoneinfo/America/../../etc/passwd",
    "/etc/zoneinfo",
    "/tmp/Asia/Tokyo",
  ])("presents UTC when the host's TZ=%s names no zone", (ambient) => {
    vi.stubEnv("TZ", ambient);

    expect(readHostZone()).toBe("UTC");
  });

  it.each([":/etc/localtime", "/etc/localtime"])(
    "presents the zone the system names for the host's TZ=%s",
    (ambient) => {
      vi.stubEnv("TZ", "Asia/Tokyo");
      delete process.env.TZ;

      const system = readHostZone();

      vi.stubEnv("TZ", ambient);

      expect(readHostZone()).toBe(system);
    },
  );

  it.each(["", "garbage", "Foo/Bar", "UTC0", "Etc/Unknown", "GMT", "europe/berlin", "JST-9"])(
    "presents UTC when the host's TZ=%j names no zone",
    (ambient) => {
      vi.stubEnv("TZ", ambient);

      expect(readHostZone()).toBe("UTC");
    },
  );

  it("presents the system zone when the host exports no TZ", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    expect(readHostZone()).toBe("Asia/Tokyo");

    delete process.env.TZ;

    expect(readHostZone()).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
