import { realpathSync } from "node:fs";

import { canonicalZone } from "./zone-name.ts";

const UNNAMED_HOST_ZONE = "UTC";

const LOCALTIME = "/etc/localtime";

const ZONEINFO_FILE = /(?:^|\/)zoneinfo\/(?:(?:posix|right)\/)?(?<name>.+)$/u;

const zoneOfZoneinfoFile = (path: string): string | undefined =>
  canonicalZone(ZONEINFO_FILE.exec(path)?.groups?.name);

const systemZone = (): string | undefined => {
  try {
    return zoneOfZoneinfoFile(realpathSync(LOCALTIME));
  } catch {
    return undefined;
  }
};

const zoneOfTzFile = (tz: string): string | undefined => {
  const path = tz.replace(/^:/u, "");

  return path === LOCALTIME ? systemZone() : zoneOfZoneinfoFile(path);
};

export const readHostZone = (): string =>
  canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ??
  zoneOfTzFile(process.env.TZ ?? "") ??
  UNNAMED_HOST_ZONE;
