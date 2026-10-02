import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../../../deadline.ts";
import type { Clock } from "../../../deadline.ts";
import { isXrioError } from "../../../errors.ts";
import { fakeChromePath } from "../../../testing/fake-chrome-path.ts";
import { leftovers, nothingLeft } from "../../../testing/leftovers.ts";
import { manualClock } from "../../../testing/manual-clock.ts";
import { createBrowsers } from "../browsers.ts";
import { cdpDriver } from "./driver.ts";

const LAUNCH_CAP_MS = 30_000;

const SCRAPE_DEADLINE_MS = 120_000;

describe("the CDP driver's launch", () => {
  it("fails a launch whose first page never attaches within 30 s, long before the scrape deadline", async () => {
    const { advance, clock } = manualClock();
    const capStarted = Promise.withResolvers<"started">();

    const watched: Clock = {
      now: clock.now,
      setTimer: (delayMs, onTimeout) => {
        if (delayMs === LAUNCH_CAP_MS) {
          capStarted.resolve("started");
        }

        return clock.setTimer(delayMs, onTimeout);
      },
    };

    const browsers = createBrowsers(cdpDriver, 1);
    using deadline = startDeadline(SCRAPE_DEADLINE_MS, undefined, watched);

    const loading = browsers.load({
      browserPath: await fakeChromePath("slow-start"),
      deadline,
      mode: "headless",
      proxy: undefined,
      url: new URL("https://fake.test/page"),
    });

    await capStarted.promise;
    advance(LAUNCH_CAP_MS);

    await expect(loading).rejects.toSatisfy(
      (error) =>
        isXrioError(error, "BROWSER_LAUNCH_FAILED") &&
        error.details.stderr.startsWith("Chrome opened no page within 30000 ms."),
    );
    expect(deadline.signal.aborted).toBeFalsy();
    await browsers.close();
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });
});
