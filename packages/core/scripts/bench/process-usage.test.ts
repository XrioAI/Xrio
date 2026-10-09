import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it } from "vite-plus/test";

import { startUsageMeter } from "./process-usage.ts";

const BUSY_CHILD = "const end = Date.now() + 600; while (Date.now() < end) {}";

const BUSY_PARENT = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(BUSY_CHILD)}], { stdio: "ignore" });
${BUSY_CHILD}
`;

const expectedBrowser =
  process.platform === "linux"
    ? { cpuOverHalfSecond: true, processes: 2, rssOver10Mib: true }
    : null;

describe(startUsageMeter, () => {
  it("reads the CPU and memory of the launched process group and of Node", async () => {
    const meter = startUsageMeter();

    const leader = spawn(process.execPath, ["-e", BUSY_PARENT], {
      detached: true,
      stdio: "ignore",
    });

    if (leader.pid === undefined) {
      throw new Error("The busy process did not start.");
    }

    meter.followBrowser(leader.pid);
    await once(leader, "exit");
    const { browser, nodePeakRssMib } = meter.finish();

    expect(nodePeakRssMib).toBeGreaterThan(10);
    expect(
      browser === null
        ? null
        : {
            cpuOverHalfSecond: browser.cpuSeconds > 0.5,
            processes: browser.processes,
            rssOver10Mib: browser.peakRssMib > 10,
          },
    ).toStrictEqual(expectedBrowser);
  });
});
