import { spawn } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { startDeadline } from "../../deadline.ts";
import { isXrioError } from "../../errors.ts";
import {
  configSeenByFcList,
  fakeFontStack,
  fcListRuns,
  FIXTURE_PAYLOAD,
  hangFcListFor,
  setFcListOutput,
  writeDuringScan,
} from "../../testing/fake-font-stack.ts";
import type { FakeFontStack } from "../../testing/fake-font-stack.ts";
import {
  dumpsRun,
  fakeForkPath,
  hangDumpFor,
  replaceDump,
  stopHanging,
  trapExecuted,
} from "../../testing/fake-fork.ts";
import type { FakeForkScenario } from "../../testing/fake-fork.ts";
import { sweepAbandonedScratch } from "./browser-process.ts";
import { createCapabilityProbe } from "./capabilities.ts";
import { waitForGroupExit } from "./group-lifetime.ts";

const KIT_DUMP = new URL("fixtures/kit-dump.txt", import.meta.url);

const SPEECH_ARTIFACT = new URL("fixtures/synthetic-voices-154.xrio-speech.json", import.meta.url);

const SPEECH_FILE = "synthetic-voices-154.xrio-speech.json";

const HOUR_MS = 60 * 60 * 1000;

const FAILED_PROBE_TTL_MS = 60_000;

const KIT_PERSONAS = {
  speech: [
    {
      chromeVersion: "154.0.8037.57",
      digest: "sha256:ccc9c0cb9cc77635b0367a46c14e35f6f9912cc524703f817bc4e9b7fd7ae48e",
      name: "synthetic-voices-154",
      schema: "xrio-speech-table/v1",
    },
  ],
};

const isForkProbed = (message: unknown): message is { event: "fork-probed"; detail: string } =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  message.event === "fork-probed" &&
  "detail" in message &&
  typeof message.detail === "string";

const clockAt = (start: number) => {
  let now = start;

  return {
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
};

const dumpStarted = async (executable: string, runs: number): Promise<void> => {
  if ((await dumpsRun(executable)) < runs) {
    await delay(10);
    await dumpStarted(executable, runs);
  }
};

const packageOf = async (executable: string) => await realpath(path.dirname(executable));

const failureOf = async (pending: Promise<unknown>) => {
  try {
    await pending;
  } catch (error) {
    if (isXrioError(error, "BROWSER_LAUNCH_FAILED")) {
      return { code: error.code, message: error.message };
    }

    throw error;
  }

  throw new Error("The probe resolved.");
};

type RenderNodeKind = "readable" | "dangling";

const writeRenderNode = async (
  directory: string,
  name: string,
  kind: RenderNodeKind,
): Promise<void> => {
  const node = path.join(directory, name);

  await (kind === "readable"
    ? writeFile(node, "")
    : symlink(path.join(directory, "missing-device"), node));
};

const driWith = async (
  directory: string,
  nodes: Readonly<Record<string, RenderNodeKind>>,
): Promise<void> => {
  await mkdir(directory);
  await Promise.all(
    Object.entries(nodes).map(async ([name, kind]) => {
      await writeRenderNode(directory, name, kind);
    }),
  );
};

const deadPid = async (): Promise<number> => {
  const child = spawn("/usr/bin/true");

  await once(child, "exit");

  return child.pid ?? 0;
};

const ownedBy = async (root: string, prefix: string, pid: number): Promise<string> => {
  await mkdir(root, { mode: 0o700, recursive: true });

  const directory = await mkdtemp(path.join(root, prefix));

  await writeFile(
    path.join(directory, "xrio-owner.json"),
    JSON.stringify({ createdAt: Date.now(), pid }),
  );

  return directory;
};

describe("hostCapabilities", () => {
  let root = "";
  let probed: string[] = [];

  const recordProbe: ChannelListener = (message) => {
    if (isForkProbed(message)) {
      probed.push(message.detail);
    }
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "xrio-capabilities-"));
    probed = [];
    subscribe("xrio:event", recordProbe);
  });

  afterEach(async () => {
    unsubscribe("xrio:event", recordProbe);
    await rm(root, { force: true, recursive: true });
  });

  const scratch = () => path.join(root, "scratch");

  const dri = () => path.join(root, "dri");

  const probeWith = (
    overrides: { now?: () => number; budgetMs?: number; renderNodeDirectory?: string } = {},
  ) => createCapabilityProbe({ renderNodeDirectory: dri(), root: scratch(), ...overrides });

  const forkAt = async (scenario: FakeForkScenario) => await fakeForkPath(scenario, { root });

  const buildRecordedBy = async (versionsLines: string) => {
    const { fork } = await probeWith()(await fakeForkPath("kit", { root, versionsLines }));

    return [fork?.commit, fork?.dirty, fork?.buildUnreadable];
  };

  const factsFiles = async () => {
    const entries = await readdir(scratch());

    return entries.filter((entry) => entry.startsWith("host-facts-"));
  };

  describe("on the kit's package", () => {
    it("parses the 77-knob dump into a registry with each row's origin", async () => {
      const { fork } = await probeWith()(await forkAt("kit"));

      expect(Object.keys(fork?.knobs ?? {})).toHaveLength(77);
      expect([
        fork?.knobs["speech-persona"],
        fork?.knobs["dump-config"],
        fork?.knobs["persona-dir"],
        fork?.knobs["speech-table"],
        fork?.knobs["synthetic-umbrella-knob"],
      ]).toStrictEqual([
        { origin: "set", value: "synthetic-voices-154" },
        { origin: "set", value: "" },
        { origin: "def", value: null },
        { origin: "der", value: null },
        { origin: "umb", value: "true" },
      ]);
    });

    it("keeps the speech persona in its shipped schema and the probed version", async () => {
      const executable = await forkAt("kit");
      const { fork, platform } = await probeWith()(executable);
      const packageDir = await packageOf(executable);

      expect(platform).toBe(process.platform);
      expect({ ...fork, knobs: undefined }).toStrictEqual({
        buildUnreadable: false,
        commit: null,
        dialect: "xrio",
        dirty: null,
        knobs: undefined,
        packageDir,
        personas: KIT_PERSONAS,
        version: "154.0.8037.57",
      });
      expect(probed).toStrictEqual([
        JSON.stringify({ knobs: 77, package: packageDir, version: "154.0.8037.57" }),
      ]);
    });

    describe("the build recorded in VERSIONS", () => {
      const COMMIT = "0123456789abcdef0123456789abcdef01234567";

      it("reads FORK_COMMIT and FORK_DIRTY when both lines are valid", async () => {
        await expect(
          buildRecordedBy(`FORK_COMMIT=${COMMIT}\nFORK_DIRTY=3\n`),
        ).resolves.toStrictEqual([COMMIT, 3, false]);
      });

      it("reads a clean build's zero dirty count", async () => {
        await expect(
          buildRecordedBy(`FORK_COMMIT=${COMMIT}\nFORK_DIRTY=0\n`),
        ).resolves.toStrictEqual([COMMIT, 0, false]);
      });

      it("reports no build, and no tell, when neither line is present", async () => {
        await expect(buildRecordedBy("")).resolves.toStrictEqual([null, null, false]);
      });

      it("reads the commit alone when FORK_DIRTY is absent", async () => {
        await expect(buildRecordedBy(`FORK_COMMIT=${COMMIT}\n`)).resolves.toStrictEqual([
          COMMIT,
          null,
          false,
        ]);
      });

      it.each(["unknown", COMMIT.slice(1), `${COMMIT}0`, `${COMMIT} `, ""])(
        "treats FORK_COMMIT=%j as absent and unreadable",
        async (commit) => {
          await expect(
            buildRecordedBy(`FORK_COMMIT=${commit}\nFORK_DIRTY=0\n`),
          ).resolves.toStrictEqual([null, 0, true]);
        },
      );

      it.each(["-1", "1.5", "two", "", "99999999999999999999"])(
        "treats FORK_DIRTY=%j as absent and unreadable",
        async (dirty) => {
          await expect(
            buildRecordedBy(`FORK_COMMIT=${COMMIT}\nFORK_DIRTY=${dirty}\n`),
          ).resolves.toStrictEqual([COMMIT, null, true]);
        },
      );

      it("stores an uppercase commit lowercased", async () => {
        await expect(
          buildRecordedBy(`FORK_COMMIT=${COMMIT.toUpperCase()}\nFORK_DIRTY=1\n`),
        ).resolves.toStrictEqual([COMMIT, 1, false]);
      });

      it("reads a VERSIONS file with CRLF line endings", async () => {
        await expect(
          buildRecordedBy(`FORK_COMMIT=${COMMIT}\r\nFORK_DIRTY=4\r\n`),
        ).resolves.toStrictEqual([COMMIT, 4, false]);
      });

      it.each([
        {
          lines: `FORK_COMMIT=${COMMIT}\nFORK_COMMIT=${COMMIT}\nFORK_DIRTY=0\n`,
          name: "equal commits",
        },
        {
          lines: `FORK_COMMIT=${COMMIT}\nFORK_COMMIT=unknown\nFORK_DIRTY=0\n`,
          name: "a commit then unknown",
        },
      ])("treats $name as an unreadable commit and keeps the dirty count", async ({ lines }) => {
        await expect(buildRecordedBy(lines)).resolves.toStrictEqual([null, 0, true]);
      });

      it.each([
        { lines: `FORK_COMMIT=${COMMIT}\nFORK_DIRTY=0\nFORK_DIRTY=0\n`, name: "equal counts" },
        {
          lines: `FORK_COMMIT=${COMMIT}\nFORK_DIRTY=0\nFORK_DIRTY=unknown\n`,
          name: "a count then unknown",
        },
      ])("treats $name as an unreadable dirty count and keeps the commit", async ({ lines }) => {
        await expect(buildRecordedBy(lines)).resolves.toStrictEqual([COMMIT, null, true]);
      });

      it.skipIf(process.getuid?.() === 0)(
        "reads no build and tells when VERSIONS exists but cannot be read, still detecting the fork by its knob file",
        async () => {
          const executable = await forkAt("kit");
          const versions = path.join(path.dirname(executable), "VERSIONS");

          await chmod(versions, 0o000);

          const { fork } = await probeWith()(executable);

          expect([fork?.dialect, fork?.commit, fork?.dirty, fork?.buildUnreadable]).toStrictEqual([
            "xrio",
            null,
            null,
            true,
          ]);
        },
      );

      it("serves the build of the VERSIONS text it read, even when a rewrite keeps its size and modification time", async () => {
        const other = "f".repeat(40);

        const executable = await fakeForkPath("kit", {
          root,
          versionsLines: `FORK_COMMIT=${COMMIT}\n`,
        });

        const versions = path.join(path.dirname(executable), "VERSIONS");
        const original = await readFile(versions, "utf-8");
        const probe = probeWith();
        const FIXED_SECONDS = 1_700_000_000;

        await utimes(versions, FIXED_SECONDS, FIXED_SECONDS);
        await expect(probe(executable)).resolves.toMatchObject({ fork: { commit: COMMIT } });
        await writeFile(versions, original.replace(COMMIT, other));
        await utimes(versions, FIXED_SECONDS, FIXED_SECONDS);
        await expect(probe(executable)).resolves.toMatchObject({ fork: { commit: other } });
      });

      it("probes a changed VERSIONS again, so a new build is never served from the old facts", async () => {
        const executable = await forkAt("kit");
        const versions = path.join(path.dirname(executable), "VERSIONS");
        const probe = probeWith();

        await expect(probe(executable)).resolves.toMatchObject({ fork: { commit: null } });
        await appendFile(versions, `FORK_COMMIT=${COMMIT}\n`);
        await expect(probe(executable)).resolves.toMatchObject({ fork: { commit: COMMIT } });
      });
    });

    it("rejects a persona whose name differs from its file stem, naming the package", async () => {
      const executable = await forkAt("kit");
      const personas = path.join(path.dirname(executable), "personas");

      await rename(
        path.join(personas, SPEECH_FILE),
        path.join(personas, "renamed-voices.xrio-speech.json"),
      );

      await expect(failureOf(probeWith()(executable))).resolves.toStrictEqual({
        code: "BROWSER_LAUNCH_FAILED",
        message: `The Xrio fork package at ${await packageOf(executable)} failed its probe: persona renamed-voices.xrio-speech.json is named "synthetic-voices-154", not its file stem renamed-voices.`,
      });
    });

    it("never reads a GL artifact, so a misnamed one leaves the probe intact", async () => {
      const executable = await forkAt("kit");
      const personas = path.join(path.dirname(executable), "personas");

      await rename(
        path.join(personas, "synthetic-gpu.xrio-gl.json"),
        path.join(personas, "renamed-gpu.xrio-gl.json"),
      );

      const { fork } = await probeWith()(executable);

      expect(fork?.personas).toStrictEqual(KIT_PERSONAS);
    });

    it("detects the kit by a VERSIONS file that declares FORK_VERSION, with no knob file", async () => {
      const { fork } = await probeWith()(await forkAt("kit-unconfigured"));

      expect([fork?.dialect, fork?.knobs["speech-persona"], fork?.personas]).toStrictEqual([
        "xrio",
        { origin: "def", value: null },
        { speech: [] },
      ]);
    });

    it.each(["stock-trap", "pristine-trap", "pxr-trap"] as const)(
      "never executes the %s layout, which has no knob file and no FORK_VERSION",
      async (scenario) => {
        const trap = await forkAt(scenario);

        await expect(probeWith()(trap)).resolves.toStrictEqual({ platform: process.platform });
        expect(existsSync(trapExecuted(trap))).toBeFalsy();
        expect(probed).toStrictEqual([]);
      },
    );

    it("treats a browser path that does not resolve as stock", async () => {
      await expect(probeWith()(path.join(root, "missing", "chrome"))).resolves.toStrictEqual({
        platform: process.platform,
      });
    });

    it("raises BROWSER_LAUNCH_FAILED naming the package for a broken dump", async () => {
      const executable = await forkAt("broken-dump");

      await expect(failureOf(probeWith()(executable))).resolves.toStrictEqual({
        code: "BROWSER_LAUNCH_FAILED",
        message: `The Xrio fork package at ${await packageOf(executable)} failed its probe: the dump has no xrio-knobs header.`,
      });
    });

    it("raises BROWSER_LAUNCH_FAILED for a dump truncated below its header's count", async () => {
      const executable = await forkAt("truncated-dump");

      await expect(failureOf(probeWith()(executable))).resolves.toStrictEqual({
        code: "BROWSER_LAUNCH_FAILED",
        message: `The Xrio fork package at ${await packageOf(executable)} failed its probe: the dump lists 39 of 77 knobs.`,
      });
    });
  });

  describe("the render node", () => {
    it("is absent where the host has no /dev/dri", async () => {
      await expect(probeWith()(path.join(root, "chrome"))).resolves.toStrictEqual({
        platform: process.platform,
      });
    });

    it("ignores the display's card node and entries that are not render nodes", async () => {
      await driWith(dri(), {
        card0: "readable",
        renderD: "readable",
        "renderD128.bak": "readable",
      });

      await expect(probeWith()(path.join(root, "chrome"))).resolves.toStrictEqual({
        platform: process.platform,
      });
    });

    it("is present when any render node opens for reading", async () => {
      await driWith(dri(), { card0: "readable", renderD128: "dangling", renderD129: "readable" });

      await expect(probeWith()(path.join(root, "chrome"))).resolves.toStrictEqual({
        platform: process.platform,
        readableRenderNode: true,
      });
    });

    it("is absent when every render node fails to open", async () => {
      await driWith(dri(), { renderD128: "dangling" });

      await expect(probeWith()(path.join(root, "chrome"))).resolves.toStrictEqual({
        platform: process.platform,
      });
    });

    it("accompanies the fork's facts", async () => {
      await driWith(dri(), { renderD128: "readable" });

      const capabilities = await probeWith()(await forkAt("kit"));

      expect([
        capabilities.platform,
        capabilities.readableRenderNode,
        capabilities.fork?.version,
      ]).toStrictEqual([process.platform, true, "154.0.8037.57"]);
    });
  });

  describe("the per-host facts file", () => {
    it("is written atomically and read by a second process instead of probing", async () => {
      const executable = await forkAt("kit");
      const first = await probeWith()(executable);
      const entries = await readdir(scratch());
      const [file = ""] = await factsFiles();
      const stored: unknown = JSON.parse(await readFile(path.join(scratch(), file), "utf-8"));

      expect(
        entries.filter((entry) => entry.startsWith("host-facts-") || entry.endsWith(".tmp")),
      ).toStrictEqual([file]);
      expect(file).toMatch(/^host-facts-[\da-f]{64}\.json$/u);
      expect(stored).toMatchObject({ format: 1, kind: "probed" });
      await expect(probeWith()(executable)).resolves.toStrictEqual(first);
      expect(probed).toHaveLength(1);
    });

    it("probes again once the binary's mtime changes", async () => {
      const executable = await forkAt("kit");
      const later = new Date(Date.now() + HOUR_MS);

      await probeWith()(executable);
      await utimes(executable, later, later);
      await probeWith()(executable);

      expect(probed).toHaveLength(2);
      await expect(factsFiles()).resolves.toHaveLength(2);
    });

    it("keeps a failed probe for 60 s only, in this process and in the next", async () => {
      const executable = await forkAt("broken-dump");
      const clock = clockAt(1_000_000);
      const probe = probeWith({ now: clock.now });
      const failed = { code: "BROWSER_LAUNCH_FAILED" };

      await expect(failureOf(probe(executable))).resolves.toMatchObject(failed);
      await replaceDump(executable, await readFile(KIT_DUMP, "utf-8"));

      clock.advance(FAILED_PROBE_TTL_MS - 1);
      await expect(failureOf(probe(executable))).resolves.toMatchObject(failed);
      await expect(failureOf(probeWith({ now: clock.now })(executable))).resolves.toMatchObject(
        failed,
      );

      clock.advance(1);
      await expect(probe(executable)).resolves.toMatchObject({ fork: { dialect: "xrio" } });
      expect(probed).toHaveLength(1);
    });

    it("keeps a probe that ran out of its budget for 60 s, like any probe failure", async () => {
      const executable = await forkAt("kit");
      const clock = clockAt(1_000_000);
      const probe = probeWith({ budgetMs: 1000, now: clock.now });

      await hangDumpFor(executable, 30);
      await expect(failureOf(probe(executable))).resolves.toStrictEqual({
        code: "BROWSER_LAUNCH_FAILED",
        message: `The Xrio fork package at ${await packageOf(executable)} failed its probe: --xrio-dump-config did not finish within 1000 ms.`,
      });
      await stopHanging(executable);
      await expect(failureOf(probe(executable))).resolves.toMatchObject({
        code: "BROWSER_LAUNCH_FAILED",
      });

      clock.advance(FAILED_PROBE_TTL_MS);
      await expect(probe(executable)).resolves.toMatchObject({ fork: { dialect: "xrio" } });
      await expect(dumpsRun(executable)).resolves.toBe(2);
    });

    it("settles at its budget when a descendant leaves the process group holding stdout", async () => {
      const executable = await forkAt("kit");
      const dump = path.join(path.dirname(executable), "dump.txt");

      await writeFile(
        executable,
        [
          "#!/bin/sh",
          'case "$1" in',
          '  --version) echo "Chromium 154.0.8037.57"; exit 0 ;;',
          `  --xrio-dump-config) /usr/bin/perl -e 'use POSIX qw(setsid); setsid(); sleep 6' & /bin/cat '${dump}'; exit 0 ;;`,
          "esac",
          "",
        ].join("\n"),
      );

      const started = performance.now();

      await expect(failureOf(probeWith({ budgetMs: 700 })(executable))).resolves.toMatchObject({
        code: "BROWSER_LAUNCH_FAILED",
      });
      expect(performance.now() - started).toBeLessThan(2000);
    });

    it("keeps a stored failure 60 s from when it was stored, not from when it was read", async () => {
      const executable = await forkAt("broken-dump");
      const clock = clockAt(1_000_000);

      await probeWith({ now: clock.now })(executable).catch(() => "failed");
      clock.advance(59_000);

      const reader = probeWith({ now: clock.now });

      await expect(failureOf(reader(executable))).resolves.toMatchObject({
        code: "BROWSER_LAUNCH_FAILED",
      });
      await replaceDump(executable, await readFile(KIT_DUMP, "utf-8"));
      clock.advance(1000);
      await expect(reader(executable)).resolves.toMatchObject({ fork: { dialect: "xrio" } });
    });

    it("probes again in a new process when an artifact in a persona-dir outside the package changes", async () => {
      const executable = await forkAt("kit");
      const external = path.join(root, "external-personas");
      const speech: unknown = JSON.parse(await readFile(SPEECH_ARTIFACT, "utf-8"));
      const kitDump = await readFile(KIT_DUMP, "utf-8");

      await mkdir(external);
      await writeFile(path.join(external, SPEECH_FILE), JSON.stringify(speech));
      await replaceDump(
        executable,
        kitDump.replace("[def] persona-dir = <unset>", `[set] persona-dir = ${external}`),
      );
      await probeWith()(executable);
      await writeFile(
        path.join(external, SPEECH_FILE),
        JSON.stringify(speech).replace(
          '"chrome_version":"154.0.8037.57"',
          '"chrome_version":"155.0.1.2"',
        ),
      );

      const { fork } = await probeWith()(executable);

      expect(fork?.personas.speech.map(({ chromeVersion }) => chromeVersion)).toStrictEqual([
        "155.0.1.2",
      ]);
    });

    it("never keeps a spawn error, which says nothing about the binary", async () => {
      const executable = await forkAt("kit");
      const probe = probeWith();

      await chmod(executable, 0o644);
      await expect(failureOf(probe(executable))).resolves.toMatchObject({
        code: "BROWSER_LAUNCH_FAILED",
      });
      await expect(factsFiles()).resolves.toStrictEqual([]);
      await chmod(executable, 0o755);
      await expect(probe(executable)).resolves.toMatchObject({ fork: { dialect: "xrio" } });
    });

    it("returns the facts it read even when its scratch vanished mid-run", async () => {
      const executable = await forkAt("kit");

      await hangDumpFor(executable, 0.5);

      const pending = probeWith()(executable);

      await dumpStarted(executable, 1);

      const entries = await readdir(scratch());

      await Promise.all(
        entries
          .filter((entry) => entry.startsWith("p"))
          .map(async (entry) => {
            await rm(path.join(scratch(), entry), { force: true, recursive: true });
          }),
      );

      await expect(pending).resolves.toMatchObject({ fork: { dialect: "xrio" } });
    });

    it("never overwrites a stored success with a failure", async () => {
      const executable = await forkAt("kit");

      await probeWith()(executable);

      const [file = ""] = await factsFiles();
      const stored = await readFile(path.join(scratch(), file), "utf-8");

      await rm(path.join(scratch(), file));
      await replaceDump(executable, "not a dump\n");
      await hangDumpFor(executable, 0.5);

      const failing = failureOf(probeWith()(executable));

      await dumpStarted(executable, 2);
      await writeFile(path.join(scratch(), file), stored);
      await expect(failing).resolves.toMatchObject({ code: "BROWSER_LAUNCH_FAILED" });
      await expect(readFile(path.join(scratch(), file), "utf-8")).resolves.toBe(stored);
    });

    it("shares one probe, so one caller's expired deadline never fails another waiter", async () => {
      const executable = await forkAt("kit");
      const probe = probeWith();

      await hangDumpFor(executable, 0.5);
      using short = startDeadline(50);
      const expiring = probe(executable, short);
      const waiting = probe(executable);

      await expect(expiring).rejects.toMatchObject({ code: "TIMEOUT" });
      await expect(waiting).resolves.toMatchObject({ fork: { dialect: "xrio" } });
      await expect(probe(executable)).resolves.toMatchObject({ fork: { dialect: "xrio" } });
      await expect(dumpsRun(executable)).resolves.toBe(1);
    });
  });

  describe("the startup sweep", () => {
    it.each([
      { order: "the probe's own order", tail: ["--headless"] },
      { order: "the marker last", tail: [] },
    ])(
      "reclaims a probe's scratch at once when its owner died, stopping the probe it left, with $order",
      async ({ tail }) => {
        const owner = await deadPid();
        const probeScratch = await ownedBy(scratch(), "p", owner);
        const browserScratch = await ownedBy(scratch(), "b", owner);

        const left = spawn(
          "/bin/sh",
          [
            "-c",
            "sleep 30; true",
            "sh",
            "--xrio-dump-config",
            `--user-data-dir=${probeScratch}`,
            ...tail,
          ],
          { detached: true, stdio: "ignore" },
        );

        await expect(sweepAbandonedScratch(scratch(), Date.now())).resolves.toStrictEqual([
          probeScratch,
        ]);
        await expect(
          waitForGroupExit(left.pid ?? 0, AbortSignal.timeout(5000)),
        ).resolves.toBeTruthy();
        expect([existsSync(probeScratch), existsSync(browserScratch)]).toStrictEqual([false, true]);
      },
    );
  });
});

const isFontStackChecked = (message: unknown): message is { event: string; detail: string } =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  message.event === "font-stack-checked" &&
  "detail" in message &&
  typeof message.detail === "string";

const CHECKED_LISTING = "Fixture Sans,Fixture Sans Bold\nFixture Serif\nFixture Mono\n";

interface StackProbeOverrides {
  readonly now?: () => number;
  readonly budgetMs?: number;
  readonly budgetSignal?: (budgetMs: number) => AbortSignal;
  readonly platform?: NodeJS.Platform;
  readonly signal?: AbortSignal;
}

const useFontStack = () => {
  let checks: string[] = [];
  let root = "";
  let stack: FakeFontStack | undefined;

  const recordCheck: ChannelListener = (message) => {
    if (isFontStackChecked(message)) {
      checks.push(message.detail);
    }
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "xrio-font-stack-"));
    checks = [];
    stack = await fakeFontStack(path.join(root, "stack"));
    subscribe("xrio:event", recordCheck);
  });

  afterEach(async () => {
    unsubscribe("xrio:event", recordCheck);
    await rm(root, { force: true, recursive: true });
  });

  const fixture = (): FakeFontStack => {
    if (stack === undefined) {
      throw new Error("The font stack fixture is not built.");
    }

    return stack;
  };

  const scratch = () => path.join(root, "scratch");

  const probeOn = (overrides: StackProbeOverrides = {}) =>
    createCapabilityProbe({
      fcList: fixture().fcList,
      platform: "linux",
      root: scratch(),
      ...overrides,
    });

  const factsOf = async (probe = probeOn()) => {
    const capabilities = await probe(fixture().binary);

    return capabilities.fontStack;
  };

  const stackFiles = async () => {
    const entries = await readdir(scratch());

    return entries.filter((entry) => entry.startsWith("host-fonts-"));
  };

  const stackDirectory = async () =>
    path.join(await realpath(path.dirname(fixture().binary)), "fontstack");

  return {
    checks: () => checks,
    factsOf,
    fixture,
    probeOn,
    root: () => root,
    scratch,
    stackDirectory,
    stackFiles,
  };
};

const refusalOf = (facts: { readonly kind: string; readonly reason?: string } | undefined) =>
  facts?.kind === "refused" ? facts.reason : undefined;

describe("hostCapabilities font stack", () => {
  const { checks, factsOf, fixture, probeOn, scratch, stackDirectory, stackFiles } = useFontStack();

  it("ignores the .uuid files fontconfig writes into a writable stack, before and during a scan", async () => {
    await writeFile(path.join(fixture().directory, "share", ".uuid"), "before\n");
    await writeDuringScan(fixture(), ["share/truetype/.uuid"]);

    const first = await factsOf();
    const later = new Date(Date.now() + HOUR_MS);

    await utimes(path.join(fixture().directory, "stack.json"), later, later);

    const second = await factsOf(probeOn());

    expect([first, second]).toMatchObject([
      { kind: "checked", payload: FIXTURE_PAYLOAD },
      { kind: "checked", payload: FIXTURE_PAYLOAD },
    ]);

    const written = await readFile(
      path.join(fixture().directory, "share", "truetype", ".uuid"),
      "utf-8",
    );

    expect(written).toBe("scanned\n");
  });

  it("hashes the payload before the scan, so a file the scan leaves behind cannot race the digest", async () => {
    await writeDuringScan(fixture(), ["share/truetype/Scanned.ttf"]);

    const first = await factsOf();
    const later = new Date(Date.now() + HOUR_MS);

    await utimes(path.join(fixture().directory, "stack.json"), later, later);

    const second = await factsOf(probeOn());

    expect([first?.kind, second?.kind]).toStrictEqual(["checked", "refused"]);
  });

  it("returns the checked stack with its rules and family count", async () => {
    await expect(factsOf()).resolves.toMatchObject({
      directory: await stackDirectory(),
      families: 4,
      kind: "checked",
      payload: FIXTURE_PAYLOAD,
      rules: ["10-fixture.conf", "50-user.conf", "51-local.conf", "60-fixture.conf"],
    });
  });

  it("keeps the per-host font cache beside the facts, named by the stack", async () => {
    const facts = await factsOf();

    expect(facts?.kind === "checked" ? facts.cacheDir : "").toMatch(
      new RegExp(`^${scratch()}/fontcache-[\\da-f]{16}$`, "u"),
    );
  });

  it("runs fc-list with the environment Chrome will get", async () => {
    const directory = await stackDirectory();

    await factsOf();

    const [run = ""] = await fcListRuns(fixture());
    const [file = "", fontsPath = "", home = "", args = ""] = run.split("|");

    expect({ args, fontsPath }).toStrictEqual({
      args: ": family",
      fontsPath: `${directory}/fonts`,
    });
    expect([file.startsWith(scratch()), home.startsWith(scratch())]).toStrictEqual([true, true]);
  });

  it("gives fc-list the pinned configuration without the user's rules", async () => {
    const directory = await stackDirectory();

    await factsOf();

    const config = await configSeenByFcList(fixture());

    expect(config).toContain(`<dir>${directory}/share</dir>`);
    expect(config).toContain(
      `<include ignore_missing="no">${directory}/fonts/conf.d/60-fixture.conf</include>`,
    );
    expect(config).not.toContain("50-user.conf");
    expect(config).not.toContain("51-local.conf");
  });

  it("records a passing check once per host, for every later process", async () => {
    await factsOf();
    await factsOf(probeOn());

    const [file = ""] = await stackFiles();

    await expect(fcListRuns(fixture())).resolves.toHaveLength(1);
    expect(checks()).toHaveLength(1);
    expect(JSON.parse(checks()[0] ?? "")).toMatchObject({ families: 4, reason: null });
    expect(file).toMatch(/^host-fonts-[\da-f]{64}\.json$/u);
    expect(JSON.parse(await readFile(path.join(scratch(), file), "utf-8"))).toMatchObject({
      format: 1,
      outputs: { payload: FIXTURE_PAYLOAD },
    });
  });

  it("checks again once the stack's manifest changes", async () => {
    const later = new Date(Date.now() + HOUR_MS);

    await factsOf();
    await utimes(path.join(fixture().directory, "stack.json"), later, later);
    await factsOf(probeOn());

    await expect(fcListRuns(fixture())).resolves.toHaveLength(2);
    await expect(stackFiles()).resolves.toHaveLength(2);
  });

  it("keeps the verdict when fontconfig resets a font directory's mtime to whole seconds", async () => {
    const share = path.join(fixture().directory, "share");
    const exact = new Date(1_700_000_000_500);
    const whole = new Date(1_700_000_000_000);

    await utimes(share, exact, exact);
    await factsOf();
    await utimes(share, whole, whole);
    await factsOf(probeOn());

    await expect(fcListRuns(fixture())).resolves.toHaveLength(1);
    await expect(stackFiles()).resolves.toHaveLength(1);
  });

  it("checks again once a font directory changes by a whole second", async () => {
    const share = path.join(fixture().directory, "share");
    const before = new Date(1_700_000_000_000);
    const after = new Date(1_700_000_001_000);

    await utimes(share, before, before);
    await factsOf();
    await utimes(share, after, after);
    await factsOf(probeOn());

    await expect(fcListRuns(fixture())).resolves.toHaveLength(2);
  });

  it("reports no stack, and runs nothing, beside a binary without one", async () => {
    await rm(path.join(fixture().directory, "stack.json"));

    await expect(probeOn()(fixture().binary)).resolves.toStrictEqual({
      platform: "linux",
    });
    await expect(fcListRuns(fixture())).resolves.toStrictEqual([]);
  });

  it("looks for no stack off Linux", async () => {
    await expect(probeOn({ platform: "darwin" })(fixture().binary)).resolves.toStrictEqual({
      platform: "darwin",
    });
    await expect(fcListRuns(fixture())).resolves.toStrictEqual([]);
  });
});

describe("hostCapabilities font stack refusals", () => {
  const { factsOf, fixture, probeOn, stackFiles } = useFontStack();

  it("refuses a stack whose fc-list prints zero families with an empty stderr", async () => {
    await setFcListOutput(fixture(), { listing: "" });

    await expect(factsOf()).resolves.toStrictEqual({
      kind: "refused",
      reason: "fc-list printed 0 families, the manifest lists 4",
    });
  });

  it("refuses a stack whose payload digest differs from its manifest", async () => {
    await writeFile(
      path.join(fixture().directory, "share", "truetype", "Fixture.ttf"),
      "changed\n",
    );

    expect(refusalOf(await factsOf())).toMatch(
      new RegExp(
        `^the payload digest [\\da-f]{64} differs from the manifest's ${FIXTURE_PAYLOAD}$`,
        "u",
      ),
    );
  });

  it("refuses a stack whose fc-list writes to stderr", async () => {
    await setFcListOutput(fixture(), {
      stderr: "Fontconfig error: cannot load default config file\n",
    });

    await expect(factsOf()).resolves.toStrictEqual({
      kind: "refused",
      reason: "fc-list wrote to stderr: Fontconfig error: cannot load default config file",
    });
  });

  it("refuses a stack whose manifest holds no payload digest, without running fc-list", async () => {
    await writeFile(
      path.join(fixture().directory, "stack.json"),
      JSON.stringify({ families: ["A"] }),
    );

    await expect(factsOf()).resolves.toStrictEqual({
      kind: "refused",
      reason: "stack.json has no sha256 payload or family list",
    });
    await expect(fcListRuns(fixture())).resolves.toStrictEqual([]);
  });

  it("refuses a stack whose fc-list cannot run", async () => {
    const probe = createCapabilityProbe({
      fcList: path.join(fixture().directory, "missing-fc-list"),
      platform: "linux",
      root: path.join(path.dirname(fixture().directory), "scratch"),
    });

    const { fontStack } = await probe(fixture().binary);

    expect(refusalOf(fontStack)).toMatch(/^fc-list wrote to stderr: fc-list could not run: /u);
  });

  it("keeps a refusal for 60 s, in this process and in the next", async () => {
    const clock = clockAt(1_000_000);
    const probe = probeOn({ now: clock.now });

    await setFcListOutput(fixture(), { listing: "" });
    await expect(factsOf(probe)).resolves.toMatchObject({ kind: "refused" });
    await setFcListOutput(fixture(), { listing: CHECKED_LISTING });

    clock.advance(FAILED_PROBE_TTL_MS - 1);
    await expect(factsOf(probe)).resolves.toMatchObject({ kind: "refused" });
    await expect(factsOf(probeOn({ now: clock.now }))).resolves.toMatchObject({ kind: "refused" });
    await expect(fcListRuns(fixture())).resolves.toHaveLength(1);
  });

  it("checks the stack again once a refusal is 60 s old", async () => {
    const clock = clockAt(1_000_000);
    const probe = probeOn({ now: clock.now });

    await setFcListOutput(fixture(), { listing: "" });
    await expect(factsOf(probe)).resolves.toMatchObject({ kind: "refused" });
    await setFcListOutput(fixture(), { listing: CHECKED_LISTING });

    clock.advance(FAILED_PROBE_TTL_MS);
    await expect(factsOf(probe)).resolves.toMatchObject({ kind: "checked" });
    await expect(fcListRuns(fixture())).resolves.toHaveLength(2);
  });

  it("stops a check when its client closes, and keeps nothing", async () => {
    const closing = new AbortController();

    await hangFcListFor(fixture(), 30);

    const checking = factsOf(probeOn({ signal: closing.signal }));

    closing.abort();

    await expect(checking).resolves.toStrictEqual({
      kind: "refused",
      reason: "the font stack check was stopped because its client closed",
    });
    await expect(stackFiles()).resolves.toStrictEqual([]);
  });

  it("gives every concurrent caller the refusal, never a rejection, when the check runs out of its budget", async () => {
    const probe = probeOn({ budgetMs: 300 });

    await hangFcListFor(fixture(), 30);

    const results = await Promise.allSettled([probe(fixture().binary), probe(fixture().binary)]);

    expect(results.map((result) => result.status)).toStrictEqual(["fulfilled", "fulfilled"]);
    expect(
      results.map((result) => (result.status === "fulfilled" ? result.value.fontStack : null)),
    ).toStrictEqual(
      Array.from({ length: 2 }, () => ({
        kind: "refused",
        reason: "the font stack check did not finish within 300 ms",
      })),
    );
  });

  it("gives every concurrent caller the refusal when the manifest is malformed", async () => {
    const probe = probeOn();

    await writeFile(path.join(fixture().directory, "stack.json"), "{not json");

    const results = await Promise.allSettled([probe(fixture().binary), probe(fixture().binary)]);

    expect(results.map((result) => result.status)).toStrictEqual(["fulfilled", "fulfilled"]);

    const reasons = results.map((result) =>
      result.status === "fulfilled" ? (refusalOf(result.value.fontStack) ?? "") : "",
    );

    expect(reasons.map((reason) => reason.startsWith("stack.json cannot be read"))).toStrictEqual([
      true,
      true,
    ]);
  });

  it("gives every concurrent caller the refusal when its client closes mid-check", async () => {
    const closing = new AbortController();
    const probe = probeOn({ signal: closing.signal });

    await hangFcListFor(fixture(), 30);

    const checking = Promise.allSettled([probe(fixture().binary), probe(fixture().binary)]);

    closing.abort();

    const results = await checking;

    expect(results.map((result) => result.status)).toStrictEqual(["fulfilled", "fulfilled"]);
  });

  it("keeps a check that ran out of its budget for 60 s in memory, so scrapes do not each pay the budget", async () => {
    const clock = clockAt(1_000_000);
    const budget = new AbortController();
    const probe = probeOn({ budgetMs: 300, budgetSignal: () => budget.signal, now: clock.now });

    await hangFcListFor(fixture(), 30);

    const pending = factsOf(probe);

    await vi.waitFor(async () => {
      await expect(fcListRuns(fixture())).resolves.toHaveLength(1);
    });
    budget.abort();

    const first = await pending;
    const second = await factsOf(probe);
    const third = await factsOf(probe);

    expect([first, second, third]).toStrictEqual(
      Array.from({ length: 3 }, () => ({
        kind: "refused",
        reason: "the font stack check did not finish within 300 ms",
      })),
    );
    await expect(fcListRuns(fixture())).resolves.toHaveLength(1);
    await expect(stackFiles()).resolves.toStrictEqual([]);
  });

  it("runs a check that ran out of its budget again once the refusal is 60 s old", async () => {
    const clock = clockAt(1_000_000);
    let budget = new AbortController();
    const probe = probeOn({ budgetMs: 300, budgetSignal: () => budget.signal, now: clock.now });

    await hangFcListFor(fixture(), 30);
    const pending = factsOf(probe);

    await vi.waitFor(async () => {
      await expect(fcListRuns(fixture())).resolves.toHaveLength(1);
    });
    budget.abort();
    await expect(pending).resolves.toMatchObject({ kind: "refused" });
    clock.advance(FAILED_PROBE_TTL_MS - 1);
    await factsOf(probe);
    await expect(fcListRuns(fixture())).resolves.toHaveLength(1);
    await hangFcListFor(fixture(), null);
    budget = new AbortController();
    clock.advance(1);

    await expect(factsOf(probe)).resolves.toMatchObject({ kind: "checked" });
    await expect(fcListRuns(fixture())).resolves.toHaveLength(2);
  });

  it("does not keep a check that its client stopped", async () => {
    const closing = new AbortController();
    const probe = probeOn({ signal: closing.signal });

    await hangFcListFor(fixture(), 30);

    const checking = factsOf(probe);

    closing.abort();
    await checking;
    await hangFcListFor(fixture(), null);

    await expect(factsOf(probeOn())).resolves.toMatchObject({ kind: "checked" });
  });
});

describe("hostCapabilities font stack on a fork", () => {
  const { fixture, root, scratch } = useFontStack();

  it("checks the stack beside a fork's binary next to the fork's own facts", async () => {
    const executable = await fakeForkPath("kit", { root: root() });

    await rename(fixture().directory, path.join(path.dirname(executable), "fontstack"));

    const capabilities = await createCapabilityProbe({
      fcList: fixture().fcList,
      platform: "linux",
      root: scratch(),
    })(executable);

    expect([capabilities.fork?.dialect, capabilities.fontStack?.kind]).toStrictEqual([
      "xrio",
      "checked",
    ]);
  });
});
