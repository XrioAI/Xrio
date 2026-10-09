import { describe, expect, it } from "vite-plus/test";

import { createLaunchLedger } from "./launch-ledger.ts";

const launchArgv = (scratch: string, size: string, lang: string): string[] => [
  "--headless",
  `--accept-lang=${lang}`,
  `--window-size=${size}`,
  `--crash-dumps-dir=${scratch}/crashes`,
  `--user-data-dir=${scratch}/profile`,
  "about:blank",
];

describe("launch ledger", () => {
  it("agrees when samples differ only by scratch directory and identity draws", () => {
    const ledger = createLaunchLedger();

    ledger.admit(launchArgv("/tmp/xrio-501/aaa", "1280,984", "en-US"));
    ledger.admit(launchArgv("/tmp/xrio-501/bbb", "1680,1010", "de-DE"));

    expect(ledger.agreedArgv()).toStrictEqual([
      "--headless",
      "--accept-lang=<drawn>",
      "--window-size=<drawn>",
      "--crash-dumps-dir=<scratch>/crashes",
      "--user-data-dir=<scratch>/profile",
      "about:blank",
    ]);
  });

  it("agrees when only the local proxy relay port differs", () => {
    const ledger = createLaunchLedger();

    ledger.admit([
      ...launchArgv("/tmp/xrio-501/aaa", "1280,984", "en-US"),
      "--proxy-server=http://127.0.0.1:43521",
    ]);
    ledger.admit([
      ...launchArgv("/tmp/xrio-501/bbb", "1280,984", "en-US"),
      "--proxy-server=http://127.0.0.1:35573",
    ]);

    expect(ledger.agreedArgv().at(-1)).toBe("--proxy-server=http://127.0.0.1:<port>");
  });

  it("fails with the changed flag when a fixed flag differs", () => {
    const ledger = createLaunchLedger();

    ledger.admit(launchArgv("/tmp/xrio-501/aaa", "1280,984", "en-US"));

    expect(() => {
      ledger.admit(["--headed", ...launchArgv("/tmp/xrio-501/bbb", "1280,984", "en-US").slice(1)]);
    }).toThrow("- --headless\n+ --headed");
  });

  it("fails when a sample adds a flag", () => {
    const ledger = createLaunchLedger();

    ledger.admit(launchArgv("/tmp/xrio-501/aaa", "1280,984", "en-US"));

    expect(() => {
      ledger.admit([...launchArgv("/tmp/xrio-501/bbb", "1280,984", "en-US"), "--no-sandbox"]);
    }).toThrow("+ --no-sandbox");
  });

  it("fails when a sample reorders the flags", () => {
    const ledger = createLaunchLedger();
    const reordered = launchArgv("/tmp/xrio-501/bbb", "1280,984", "en-US");

    ledger.admit(launchArgv("/tmp/xrio-501/aaa", "1280,984", "en-US"));
    reordered.splice(0, 2, reordered[1] ?? "", reordered[0] ?? "");

    expect(() => {
      ledger.admit(reordered);
    }).toThrow(
      "Chrome argv has the same flags in a different order between samples:\n--accept-lang=<drawn>\n--headless",
    );
  });

  it("fails when a sample drops an identity flag", () => {
    const ledger = createLaunchLedger();

    ledger.admit(launchArgv("/tmp/xrio-501/aaa", "1280,984", "en-US"));

    expect(() => {
      ledger.admit(
        launchArgv("/tmp/xrio-501/bbb", "1280,984", "en-US").filter(
          (arg) => !arg.startsWith("--window-size"),
        ),
      );
    }).toThrow("- --window-size=<drawn>");
  });

  it("has no agreed argv before any sample", () => {
    expect(() => createLaunchLedger().agreedArgv()).toThrow("No sample launched Chrome.");
  });
});
