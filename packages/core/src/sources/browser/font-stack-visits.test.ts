import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../../deadline.ts";
import { fakeChromePath } from "../../testing/fake-chrome-path.ts";
import { fakeFontStack, hangFcListFor } from "../../testing/fake-font-stack.ts";
import type { FakeFontStack } from "../../testing/fake-font-stack.ts";
import { noPins } from "../../testing/no-pins.ts";
import { createBrowsers } from "./browsers.ts";
import { createCapabilityProbe } from "./capabilities.ts";
import { cdpDriver } from "./cdp/driver.ts";
import { createFontEvidenceStore } from "./font-evidence.ts";

describe("scrapes that run beside each other while the font stack check fails", () => {
  let root = "";
  let stack: FakeFontStack;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "xrio-font-visits-"));
    stack = await fakeFontStack(path.join(root, "stack"));
    await writeFile(stack.binary, `#!/bin/sh\nexec "${await fakeChromePath("normal")}" "$@"\n`);
    await chmod(stack.binary, 0o755);
    await hangFcListFor(stack, 30);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("resolves both, each reporting the host's fonts and the reason the stack was refused", async () => {
    const browsers = createBrowsers(cdpDriver, 2, {
      fontEvidence: createFontEvidenceStore({ root: path.join(root, "scratch") }),
      hostCapabilities: createCapabilityProbe({
        budgetMs: 300,
        fcList: stack.fcList,
        platform: "linux",
        root: path.join(root, "scratch"),
      }),
    });

    const scrape = async () => {
      using deadline = startDeadline(10_000);

      return await browsers.load({
        browserArgs: [],
        browserPath: stack.binary,
        deadline,
        mode: "headless",
        pins: noPins,
        proxy: undefined,
        url: new URL("https://fake.test/page"),
      });
    };

    const results = await Promise.allSettled([scrape(), scrape()]);

    await browsers.close();
    expect(
      results.map((result) =>
        result.status === "fulfilled"
          ? {
              fonts:
                result.value.identity?.mode === "http"
                  ? null
                  : result.value.identity?.surfaces.fonts,
              hostFonts: result.value.identity?.tells.includes("host-fonts"),
            }
          : String(result.reason),
      ),
    ).toStrictEqual(
      Array.from({ length: 2 }, () => ({
        fonts: {
          reason: "the font stack check did not finish within 300 ms",
          source: "host",
        },
        hostFonts: true,
      })),
    );
  });
});
