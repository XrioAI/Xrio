import { describe, expect, it } from "vite-plus/test";

import { planIdentity } from "../../humanizer/humanizer.ts";
import { isChromeBadFlag, XRIO_SENT_BAD_FLAG_SWITCHES } from "../../humanizer/owned-inputs.ts";
import { fixedDevice } from "../../testing/fixed-seed.ts";
import { noPins } from "../../testing/no-pins.ts";
import { parseBrowserArgs, planLaunch } from "./launch-plan.ts";

const SCRATCH = "/tmp/xrio-501/bAbC123";

const launchOf = (headless: boolean, browserArgs: readonly string[]) => {
  const identity = planIdentity({
    capabilities: { permittedCpus: 32, platform: "linux" },
    device: fixedDevice,
    exit: { facts: { kind: "unknown" }, route: "direct" },
    hostZone: "America/Chicago",
    mode: headless ? "headless" : "headed",
    pins: noPins,
  });

  const { args } = planLaunch({
    browserArgs,
    browserPath: "/browser",
    display: undefined,
    headless,
    identity: identity.inputs,
    scratchDir: SCRATCH,
    xauthority: undefined,
  });

  return { args, tells: identity.tells };
};

const infobarTellsOf = (headless: boolean, browserArgs: readonly string[]): readonly string[] =>
  launchOf(headless, browserArgs).tells.filter((tell) => tell === "flag-infobar");

describe("the flag-infobar tell against the planned argv", () => {
  it("marks a headed launch with no caller switches, which still sends the managed switch", () => {
    const { args } = launchOf(false, []);

    expect(args).toContain("--disable-blink-features=AutomationControlled");
    expect(infobarTellsOf(false, [])).toStrictEqual(["flag-infobar"]);
  });

  it.each([
    "--no-sandbox",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--proxy-server=http://127.0.0.1:1",
  ])("leaves the headed tell unchanged when a caller sends %s", (entry) => {
    expect(launchOf(false, [entry]).args).toContain(entry);
    expect(infobarTellsOf(false, [entry])).toStrictEqual(["flag-infobar"]);
  });

  it("never marks a headless launch, even with a caller's --no-sandbox", () => {
    expect(launchOf(true, ["--no-sandbox"]).args).toContain("--no-sandbox");
    expect(infobarTellsOf(true, ["--no-sandbox"])).toStrictEqual([]);
    expect(infobarTellsOf(true, [])).toStrictEqual([]);
  });

  it("sends every switch the Humanizer counts as Xrio's own", () => {
    const { args } = launchOf(false, []);
    const names = args.map((entry) => entry.split("=", 1)[0]);

    for (const name of XRIO_SENT_BAD_FLAG_SWITCHES) {
      expect(names).toContain(name);
    }
  });

  it.each(["--disable-webnn-compiler-sandbox", "--no-sandbox", "--log-net-log=/tmp/net.json"])(
    "accepts the listed switch %s from a caller",
    (entry) => {
      expect(parseBrowserArgs([entry])).toStrictEqual([entry]);
    },
  );

  it("refuses a caller's --host-resolver-rules, which would compete with Xrio's DNS rule", () => {
    expect(() => parseBrowserArgs(["--host-resolver-rules=MAP * ~NOTFOUND"])).toThrow(
      /browserArgs cannot include --host-resolver-rules, which Xrio manages/u,
    );
  });

  it.each([
    "--enable-blink-features=Foo",
    "--use-fake-ui-for-media-stream",
    "--enable-unsafe-webgpu",
  ])("refuses %s from a caller, so the list leaves it out", (entry) => {
    expect(() => parseBrowserArgs([entry])).toThrow(/Xrio manages/u);
    expect(isChromeBadFlag("--no-sandbox", "linux")).toBeTruthy();
    expect(isChromeBadFlag(entry.split("=", 1)[0], "linux")).toBeFalsy();
  });
});
