import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../deadline.ts";
import { cdpDriver } from "../sources/browser/cdp/driver.ts";
import { chromePath } from "../testing/chrome-path.ts";
import { conformancePages } from "../testing/conformance-pages.ts";
import { fixedRandom } from "../testing/fixed-seed.ts";
import { startFixtureServer } from "../testing/fixture-server.ts";
import type { FixtureServer } from "../testing/fixture-server.ts";
import { noPins } from "../testing/no-pins.ts";
import { plannedScrapes } from "../testing/planned-scrapes.ts";
import { expectSentHardware } from "../testing/sent-hardware.ts";

const IDENTITY_REALMS =
  /<script type="application\/json" id="identity-workers">(?<realms>[^<]*)<\/script>/u;

const LOAD_BUDGET_MS = 20_000;

let server: FixtureServer;

const identityPage = async () => {
  const browsers = plannedScrapes(cdpDriver, 1, { random: fixedRandom });
  using deadline = startDeadline(LOAD_BUDGET_MS);

  try {
    return await browsers.visit({
      browserArgs: [],
      browserPath: chromePath(),
      deadline,
      mode: "headless",
      pins: noPins,
      proxy: undefined,
      url: new URL("/identity", server.origin),
    }).document;
  } finally {
    await browsers.close();
  }
};

describe("the hardware every realm reads", () => {
  beforeAll(async () => {
    server = await startFixtureServer(conformancePages);
  });

  afterAll(async () => {
    await server[Symbol.asyncDispose]();
  });

  it("agrees with the main realm on cores and memory in every worker and in a cross-site frame, and with the draw where the launch sent it", async () => {
    const { html, identity } = await identityPage();

    if (identity.mode === "http") {
      throw new Error("A browser scrape reports a browser identity.");
    }

    const { hardwareConcurrency, deviceMemory } = identity.observed;
    const sent = expectSentHardware(identity);
    const row = { deviceMemory, hardwareConcurrency };
    const realms: unknown = JSON.parse(IDENTITY_REALMS.exec(html)?.groups?.realms ?? "null");

    expect(realms).toMatchObject({
      dedicated: row,
      frame: { dedicated: row, service: row, shared: row, window: row },
      service: row,
      shared: row,
      window: row,
    });
    expect(row).toStrictEqual(
      sent === undefined ? row : { deviceMemory: sent.memoryGb, hardwareConcurrency: sent.cores },
    );
  });
});
