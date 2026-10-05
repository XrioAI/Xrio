import { spawn } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../../deadline.ts";
import { isXrioError } from "../../errors.ts";
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

  const probeWith = (overrides: { now?: () => number; budgetMs?: number } = {}) =>
    createCapabilityProbe({ root: scratch(), ...overrides });

  const forkAt = async (scenario: FakeForkScenario) => await fakeForkPath(scenario, { root });

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
        dialect: "xrio",
        knobs: undefined,
        packageDir,
        personas: KIT_PERSONAS,
        version: "154.0.8037.57",
      });
      expect(probed).toStrictEqual([
        JSON.stringify({ knobs: 77, package: packageDir, version: "154.0.8037.57" }),
      ]);
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
