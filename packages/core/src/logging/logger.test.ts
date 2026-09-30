import { describe, expect, it } from "vite-plus/test";

import { createLogger } from "./logger.ts";
import type { LogLevel } from "./logger.ts";

const capture = (settings: { enabled: boolean; level: LogLevel }) => {
  const lines: string[] = [];

  const logger = createLogger({
    ...settings,
    sink: (line) => {
      lines.push(line);
    },
  });

  return { lines, logger };
};

const emitEveryLevel = (logger: ReturnType<typeof createLogger>): void => {
  logger.debug("d");
  logger.info("i");
  logger.warn("w");
  logger.error("e");
};

describe(createLogger, () => {
  it("emits only the configured level and above", () => {
    const { lines, logger } = capture({ enabled: true, level: "warn" });

    emitEveryLevel(logger);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("WARN");
    expect(lines[1]).toContain("ERROR");
  });

  it("emits everything at debug", () => {
    const { lines, logger } = capture({ enabled: true, level: "debug" });

    emitEveryLevel(logger);

    expect(lines).toHaveLength(4);
  });

  it("emits nothing when disabled, whatever the level", () => {
    const { lines, logger } = capture({ enabled: false, level: "debug" });

    emitEveryLevel(logger);

    expect(lines).toStrictEqual([]);
  });

  it("appends structured fields as key=value", () => {
    const { lines, logger } = capture({ enabled: true, level: "info" });

    logger.info("scrape finished", { status: 200, url: "https://example.com/" });

    expect(lines[0]).toMatch(/INFO {2}scrape finished status=200 url="https:\/\/example\.com\/"$/u);
  });
});
