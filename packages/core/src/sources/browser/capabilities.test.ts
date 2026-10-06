import { execFileSync, spawn } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  open,
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
  renderProbeLines,
  renderProbesRun,
  replaceDump,
  setHostRenderer,
  stopHanging,
  trapExecuted,
} from "../../testing/fake-fork.ts";
import type { FakeForkScenario } from "../../testing/fake-fork.ts";
import { sweepAbandonedScratch } from "./browser-process.ts";
import { createCapabilityProbe, createProbeWork } from "./capabilities.ts";
import { waitForGroupExit } from "./group-lifetime.ts";

const KIT_DUMP = new URL("fixtures/kit-dump.txt", import.meta.url);

const SPEECH_ARTIFACT = new URL("fixtures/synthetic-voices-154.xrio-speech.json", import.meta.url);

const SPEECH_FILE = "synthetic-voices-154.xrio-speech.json";

const HOUR_MS = 60 * 60 * 1000;

const FAILED_PROBE_TTL_MS = 60_000;

const PARALLELISM = 12;

const KIT_PERSONAS = {
  gl: [
    {
      chromeVersion: "154.0.8037.57",
      digest: "sha256:6819059b04a8e00c0dfd89c5e126ec5e729750d967656784b4a22a2170a7c6c3",
      formFactor: "laptop",
      hiddenExtensions: ["WEBGL_synthetic_a"],
      kind: "hardware",
      maxThreads: 12,
      name: "synthetic-gpu",
      renderer: "ANGLE (Synthetic, Synthetic GPU)",
      vendor: "Synthetic Inc.",
    },
    {
      chromeVersion: "154.0.8037.57",
      digest: "sha256:ce60cf8e5d741d9396b26631c12bc4d81c7cae56c122aabf53823bd842ec9c3e",
      formFactor: "desktop",
      hiddenExtensions: ["WEBGL_synthetic_a", "WEBGL_synthetic_b"],
      kind: "hide-only",
      maxThreads: 16,
      name: "synthetic-swiftshader-hidden",
      renderer: "ANGLE (Synthetic, SwiftShader Device)",
      vendor: "Synthetic Inc.",
    },
  ],
  refusedGl: [],
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

const GL_SUFFIX = ".xrio-gl.json";

const GL_DIGEST = `sha256:${"a".repeat(64)}`;

const hardwareGl = (name: string) => ({
  chrome_version: "154.0.8037.57",
  digest: GL_DIGEST,
  float_arrays: [],
  floats: [],
  form_factor: "desktop",
  hidden_extensions: ["WEBGL_synthetic_a"],
  int_arrays: [],
  ints: [[3379, 16_384]],
  max_threads: 8,
  name,
  not_added: [],
  renderer: "ANGLE (Synthetic, Synthetic GPU)",
  schema: "xrio-gl-table/v2",
  vendor: "Synthetic Inc.",
});

const hideOnlyGl = (name: string) => ({
  ...hardwareGl(name),
  ints: [],
  renderer: "ANGLE (Synthetic, SwiftShader Device)",
});

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

const writeStatus = async (directory: string, cpusAllowed: string): Promise<string> => {
  const file = path.join(directory, "status");

  await writeFile(
    file,
    `Name:\tnode\nCpus_allowed:\tffffffff\nCpus_allowed_list:\t${cpusAllowed}\nMems_allowed:\t1\n`,
  );

  return file;
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
    overrides: {
      now?: () => number;
      budgetMs?: number;
      renderNodeDirectory?: string;
      platform?: NodeJS.Platform;
      processStatusFile?: string;
      onlineCpusFile?: string;
    } = {},
  ) =>
    createCapabilityProbe({
      onlineCpusFile: path.join(root, "no-online"),
      parallelism: () => PARALLELISM,
      processStatusFile: path.join(root, "no-status"),
      renderNodeDirectory: dri(),
      root: scratch(),
      ...overrides,
    });

  const forkAt = async (scenario: FakeForkScenario) => await fakeForkPath(scenario, { root });

  const permittedOn = async (
    platform: NodeJS.Platform,
    processStatusFile: string,
    onlineCpusFile = path.join(root, "no-online"),
  ) => {
    const { permittedCpus } = await probeWith({ onlineCpusFile, platform, processStatusFile })(
      path.join(root, "chrome"),
    );

    return permittedCpus;
  };

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

    it("fails the probe on a speech artifact it cannot read, and keeps no failure", async () => {
      const executable = await forkAt("kit");
      const directory = await packageOf(executable);
      const probe = probeWith();

      await chmod(path.join(directory, "personas", SPEECH_FILE), 0o000);

      const failures = [await failureOf(probe(executable)), await failureOf(probe(executable))];

      expect({
        dumps: await dumpsRun(executable),
        failures,
        stored: await factsFiles(),
      }).toStrictEqual({
        dumps: 2,
        failures: Array.from({ length: 2 }, () => ({
          code: "BROWSER_LAUNCH_FAILED",
          message: `The Xrio fork package at ${directory} failed its probe: EACCES: permission denied, open '${path.join(directory, "personas", SPEECH_FILE)}'.`,
        })),
        stored: [],
      });
    });

    it("refuses a misnamed GL artifact by its stem and leaves the probe intact", async () => {
      const executable = await forkAt("kit");
      const personas = path.join(path.dirname(executable), "personas");

      await rename(
        path.join(personas, "synthetic-gpu.xrio-gl.json"),
        path.join(personas, "renamed-gpu.xrio-gl.json"),
      );

      const { fork } = await probeWith()(executable);

      expect(fork?.personas).toStrictEqual({
        gl: [KIT_PERSONAS.gl[1]],
        refusedGl: [
          {
            reason: 'is named "synthetic-gpu", not its file stem renamed-gpu',
            stem: "renamed-gpu",
          },
        ],
        speech: KIT_PERSONAS.speech,
      });
    });

    it("detects the kit by a VERSIONS file that declares FORK_VERSION, with no knob file", async () => {
      const { fork } = await probeWith()(await forkAt("kit-unconfigured"));

      expect([fork?.dialect, fork?.knobs["speech-persona"], fork?.personas]).toStrictEqual([
        "xrio",
        { origin: "def", value: null },
        { gl: [], refusedGl: [], speech: [] },
      ]);
    });

    it.each(["stock-trap", "pristine-trap", "pxr-trap"] as const)(
      "never executes the %s layout, which has no knob file and no FORK_VERSION",
      async (scenario) => {
        const trap = await forkAt(scenario);

        await expect(probeWith()(trap)).resolves.toStrictEqual({
          permittedCpus: PARALLELISM,
          platform: process.platform,
        });
        expect(existsSync(trapExecuted(trap))).toBeFalsy();
        expect(probed).toStrictEqual([]);
      },
    );

    it("treats a browser path that does not resolve as stock", async () => {
      await expect(probeWith()(path.join(root, "missing", "chrome"))).resolves.toStrictEqual({
        permittedCpus: PARALLELISM,
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
        permittedCpus: PARALLELISM,
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
        permittedCpus: PARALLELISM,
        platform: process.platform,
      });
    });

    it("is present when any render node opens for reading", async () => {
      await driWith(dri(), { card0: "readable", renderD128: "dangling", renderD129: "readable" });

      await expect(probeWith()(path.join(root, "chrome"))).resolves.toStrictEqual({
        permittedCpus: PARALLELISM,
        platform: process.platform,
        readableRenderNode: true,
      });
    });

    it("is absent when every render node fails to open", async () => {
      await driWith(dri(), { renderD128: "dangling" });

      await expect(probeWith()(path.join(root, "chrome"))).resolves.toStrictEqual({
        permittedCpus: PARALLELISM,
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

  describe("the permitted CPUs", () => {
    it.each([
      { count: 32, list: "0-31" },
      { count: 6, list: "1,3,8-11" },
      { count: 1, list: "5" },
      { count: 5, list: "0-1,4-5,8" },
    ])("counts $count CPUs in the Linux list $list", async ({ count, list }) => {
      await expect(permittedOn("linux", await writeStatus(root, list))).resolves.toBe(count);
    });

    it.each(["", "3-1", "a-b", "1,,2", "1-"])(
      "falls back to the host's parallelism for the list %j",
      async (list) => {
        await expect(permittedOn("linux", await writeStatus(root, list))).resolves.toBe(
          PARALLELISM,
        );
      },
    );

    it.each([
      { allowed: "0-15", count: 12, online: "0-11\n" },
      { allowed: "1,3,8-11", count: 6, online: "0-31\n" },
      { allowed: "0-15", count: 8, online: "0-3,8-11\n" },
      { allowed: "0-31", count: 32, online: undefined },
      { allowed: "0-31", count: 32, online: "0-x\n" },
      { allowed: "0-31", count: 32, online: "" },
      { allowed: "0-3", count: 4, online: "8-11\n" },
    ])(
      "counts $count CPUs for allowed $allowed with online $online",
      async ({ allowed, count, online }) => {
        const onlineFile = path.join(root, "online");

        if (online !== undefined) {
          await writeFile(onlineFile, online);
        }

        await expect(
          permittedOn("linux", await writeStatus(root, allowed), onlineFile),
        ).resolves.toBe(count);
      },
    );

    it("falls back to the host's parallelism where /proc/self/status is unreadable", async () => {
      await expect(permittedOn("linux", path.join(root, "absent"))).resolves.toBe(PARALLELISM);
    });

    it("falls back to the host's parallelism when the status file has no list", async () => {
      const file = path.join(root, "status");

      await writeFile(file, "Name:\tnode\n");

      await expect(permittedOn("linux", file)).resolves.toBe(PARALLELISM);
    });

    it("reads no status file off Linux", async () => {
      await expect(permittedOn("darwin", await writeStatus(root, "0-1"))).resolves.toBe(
        PARALLELISM,
      );
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
      expect(stored).toMatchObject({ format: 2, kind: "probed" });
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
      parallelism: () => PARALLELISM,
      platform: "linux",
      processStatusFile: path.join(fixture().directory, "no-status"),
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

const glProbeIn = (root: string) =>
  createCapabilityProbe({
    parallelism: () => PARALLELISM,
    processStatusFile: path.join(root, "no-status"),
    renderNodeDirectory: path.join(root, "dri"),
    root: path.join(root, "scratch"),
  });

const glPersonasIn = async (root: string, files: Readonly<Record<string, string>>) => {
  const executable = await fakeForkPath("kit", { root });
  const directory = path.join(path.dirname(executable), "personas");

  await Promise.all(
    Object.entries(files).map(async ([file, contents]) => {
      await writeFile(path.join(directory, file), contents);
    }),
  );

  const { fork } = await glProbeIn(root)(executable);

  return fork?.personas;
};

const glOnly = (personas: Awaited<ReturnType<typeof glPersonasIn>>, stem: string) => ({
  kind: personas?.gl.find(({ name }) => name === stem)?.kind,
  refusal: personas?.refusedGl.find((refused) => refused.stem === stem)?.reason,
});

describe("hostCapabilities GL personas", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "xrio-capabilities-gl-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const probeWith = () => glProbeIn(root);

  const personasOf = async (files: Readonly<Record<string, string>>) =>
    await glPersonasIn(root, files);

  it("parses both synthetic artifacts with every field and derives each one's kind", async () => {
    const { fork } = await probeWith()(await fakeForkPath("kit", { root }));

    expect(fork?.personas.gl).toStrictEqual(KIT_PERSONAS.gl);
    expect(fork?.personas.refusedGl).toStrictEqual([]);
  });

  it.each([
    [
      "a renderer naming Swift Shader with a space",
      { renderer: "ANGLE (Swift Shader)" },
      "hide-only",
    ],
    ["a non-empty ints list", { ints: [[1, 2]] }, "hardware"],
    ["a non-empty floats list", { floats: [[1, 2]] }, "hardware"],
    ["a non-empty float_arrays list", { float_arrays: [[1, [2]]] }, "hardware"],
    ["a non-empty int_arrays list", { int_arrays: [[1, [2]]] }, "hardware"],
    ["a missing not_added list", { not_added: undefined }, "hardware"],
    ["a non-empty not_added list", { not_added: ["WEBGL_synthetic_c"] }, "hardware"],
    ["an empty hidden_extensions list", { hidden_extensions: [] }, "hardware"],
    ["a renderer without the SwiftShader marker", { renderer: "ANGLE (llvmpipe)" }, "hardware"],
    ["an empty string in hidden_extensions", { hidden_extensions: [""] }, "hide-only"],
  ] as const)("derives the kind of an artifact with %s", async (_label, changes, kind) => {
    const personas = await personasOf({
      [`small${GL_SUFFIX}`]: JSON.stringify({ ...hideOnlyGl("small"), ...changes }),
    });

    expect(glOnly(personas, "small")).toStrictEqual({ kind, refusal: undefined });
  });

  it.each([
    ["is not JSON", "not json", "is not JSON"],
    ["is a JSON array", "[]", "is not a JSON object"],
    ["is JSON null", "null", "is not a JSON object"],
    [
      "has another schema",
      JSON.stringify({ ...hardwareGl("bad"), schema: "xrio-gl-table/v1" }),
      'has schema "xrio-gl-table/v1", not xrio-gl-table/v2',
    ],
    [
      "has a name other than its stem",
      JSON.stringify({ ...hardwareGl("other") }),
      'is named "other", not its file stem bad',
    ],
    [
      "has a malformed digest",
      JSON.stringify({ ...hardwareGl("bad"), digest: "sha256:abc" }),
      "lacks a sha256 digest",
    ],
    [
      "has a numeric vendor",
      JSON.stringify({ ...hardwareGl("bad"), vendor: 3 }),
      "lacks a non-empty chrome_version, vendor or renderer",
    ],
    [
      "has no renderer",
      JSON.stringify({ ...hardwareGl("bad"), renderer: undefined }),
      "lacks a non-empty chrome_version, vendor or renderer",
    ],
    [
      "has an empty vendor",
      JSON.stringify({ ...hideOnlyGl("bad"), vendor: "" }),
      "lacks a non-empty chrome_version, vendor or renderer",
    ],
    [
      "has an empty renderer",
      JSON.stringify({ ...hardwareGl("bad"), renderer: "" }),
      "lacks a non-empty chrome_version, vendor or renderer",
    ],
    [
      "has an empty chrome_version",
      JSON.stringify({ ...hardwareGl("bad"), chrome_version: "" }),
      "lacks a non-empty chrome_version, vendor or renderer",
    ],
    [
      "has an unknown form factor",
      JSON.stringify({ ...hardwareGl("bad"), form_factor: "tablet" }),
      "has a form_factor that is not laptop or desktop",
    ],
    [
      "has zero max_threads",
      JSON.stringify({ ...hardwareGl("bad"), max_threads: 0 }),
      "has a max_threads that is not an integer of at least 1",
    ],
    [
      "has fractional max_threads",
      JSON.stringify({ ...hardwareGl("bad"), max_threads: 1.5 }),
      "has a max_threads that is not an integer of at least 1",
    ],
    [
      "has a max_threads past the fork's integers",
      JSON.stringify({ ...hardwareGl("bad"), max_threads: 2_147_483_648 }),
      "has a max_threads that is not an integer of at least 1",
    ],
    [
      "has no int_arrays list",
      JSON.stringify({ ...hardwareGl("bad"), int_arrays: undefined }),
      "has no int_arrays list",
    ],
    [
      "has a floats field that is not a list",
      JSON.stringify({ ...hardwareGl("bad"), floats: {} }),
      "has no floats list",
    ],
    [
      "has an ints entry that is not a pair",
      JSON.stringify({ ...hardwareGl("bad"), ints: [[3379, 16_384, 1]] }),
      "has a malformed ints entry",
    ],
    [
      "has a negative pname",
      JSON.stringify({ ...hardwareGl("bad"), ints: [[-1, 16_384]] }),
      "has a malformed ints entry",
    ],
    [
      "has a fractional ints value",
      JSON.stringify({ ...hardwareGl("bad"), ints: [[3379, 0.5]] }),
      "has a malformed ints entry",
    ],
    [
      "has a floats value that is not a number",
      JSON.stringify({ ...hardwareGl("bad"), floats: [[36_444, "2"]] }),
      "has a malformed floats entry",
    ],
    [
      "has a float array of five components",
      JSON.stringify({ ...hardwareGl("bad"), float_arrays: [[33_902, [1, 2, 3, 4, 5]]] }),
      "has a malformed float_arrays entry",
    ],
    [
      "has an empty int array",
      JSON.stringify({ ...hardwareGl("bad"), int_arrays: [[33_902, []]] }),
      "has a malformed int_arrays entry",
    ],
    [
      "has a fractional int array component",
      JSON.stringify({ ...hardwareGl("bad"), int_arrays: [[33_902, [1, 2.5]]] }),
      "has a malformed int_arrays entry",
    ],
    [
      "repeats a pname in ints",
      JSON.stringify({
        ...hardwareGl("bad"),
        ints: [
          [3379, 16_384],
          [3379, 8192],
        ],
      }),
      "repeats a pname in ints",
    ],
    [
      "has a non-string hidden extension",
      JSON.stringify({ ...hardwareGl("bad"), hidden_extensions: ["a", 1] }),
      "has hidden_extensions that is not an array of strings",
    ],
  ])("refuses an artifact that %s and still resolves the probe", async (_label, text, reason) => {
    const personas = await personasOf({ [`bad${GL_SUFFIX}`]: text });

    expect(personas?.refusedGl).toStrictEqual([{ reason, stem: "bad" }]);
    expect(personas?.gl).toStrictEqual(KIT_PERSONAS.gl);
    expect(personas?.speech).toStrictEqual(KIT_PERSONAS.speech);
  });
});

describe("hostCapabilities GL artifacts the fork's loader refuses", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "xrio-capabilities-gl-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const scratch = () => path.join(root, "scratch");

  const probeWith = () => glProbeIn(root);

  const personasOf = async (files: Readonly<Record<string, string>>) =>
    await glPersonasIn(root, files);

  it.each([
    ["a space", "amd renoir"],
    ["a leading dot", ".renoir"],
    ["129 characters", "r".repeat(129)],
    ["a letter outside A to Z", "rénoir"],
  ])(
    "refuses an artifact whose name holds %s, which the fork cannot select",
    async (_label, stem) => {
      const personas = await personasOf({
        [`${stem}${GL_SUFFIX}`]: JSON.stringify(hideOnlyGl(stem)),
      });

      expect(personas?.refusedGl).toStrictEqual([
        { reason: "has a name the fork cannot select", stem },
      ]);
      expect(personas?.gl).toStrictEqual(KIT_PERSONAS.gl);
    },
  );

  it("keeps an artifact of 262,144 bytes and refuses one a byte longer, as the fork reads", async () => {
    const personas = await personasOf({
      [`fits${GL_SUFFIX}`]: JSON.stringify(hideOnlyGl("fits")).padEnd(262_144),
      [`over${GL_SUFFIX}`]: JSON.stringify(hideOnlyGl("over")).padEnd(262_145),
    });

    expect([glOnly(personas, "fits"), glOnly(personas, "over")]).toStrictEqual([
      { kind: "hide-only", refusal: undefined },
      { kind: undefined, refusal: "is over the 262144 bytes the fork reads" },
    ]);
  });

  it("reads an artifact no further than a byte past the cap, and keeps none of an oversized one", async () => {
    const executable = await fakeForkPath("kit", { root });
    const directory = path.join(path.dirname(executable), "personas");
    const endless = path.join(directory, `endless${GL_SUFFIX}`);

    execFileSync("/usr/bin/mkfifo", [endless]);
    await writeFile(path.join(directory, `large${GL_SUFFIX}`), " ".repeat(1_048_576));

    const feeding = (async () => {
      const writer = await open(endless, "w");

      await writer.write(Buffer.alloc(262_145, " "));

      return writer;
    })();

    const { fork } = await probeWith()(executable);
    const writer = await feeding;

    await writer.close();

    const entries = await readdir(scratch());
    const facts = entries.find((entry) => entry.startsWith("host-facts-")) ?? "";

    const stored = await readFile(path.join(scratch(), facts));

    expect(fork?.personas.refusedGl).toStrictEqual([
      { reason: "is over the 262144 bytes the fork reads", stem: "endless" },
      { reason: "is over the 262144 bytes the fork reads", stem: "large" },
    ]);
    expect(stored.length).toBeLessThan(16_384);
  });

  it("caps an artifact's bytes and name at the gl-table-max-bytes and gl-persona-max-name the dump sets", async () => {
    const executable = await fakeForkPath("kit", { root });
    const kitDump = await readFile(KIT_DUMP, "utf-8");
    const directory = path.join(path.dirname(executable), "personas");

    await replaceDump(
      executable,
      kitDump
        .replace("[def] synthetic-knob-01 = 3", "[set] gl-table-max-bytes = 1024")
        .replace("[def] synthetic-knob-02 = 6", "[set] gl-persona-max-name = 16"),
    );

    const files = {
      fits: JSON.stringify(hideOnlyGl("fits")).padEnd(1024),
      over: JSON.stringify(hideOnlyGl("over")).padEnd(1025),
      "seventeen-letters": JSON.stringify(hideOnlyGl("seventeen-letters")),
      "sixteen-letters1": JSON.stringify(hideOnlyGl("sixteen-letters1")),
      wide: JSON.stringify({ ...hideOnlyGl("wide"), vendor: "é".repeat(300) }).padEnd(1024),
    };

    await Promise.all(
      Object.entries(files).map(async ([stem, contents]) => {
        await writeFile(path.join(directory, `${stem}${GL_SUFFIX}`), contents);
      }),
    );

    const { fork } = await probeWith()(executable);

    expect({
      gl: fork?.personas.gl.map(({ name }) => name),
      refusedGl: fork?.personas.refusedGl,
      wide: [files.wide.length, Buffer.byteLength(files.wide)],
    }).toStrictEqual({
      gl: ["fits", "sixteen-letters1", "synthetic-gpu"],
      refusedGl: [
        { reason: "is over the 1024 bytes the fork reads", stem: "over" },
        { reason: "has a name the fork cannot select", stem: "seventeen-letters" },
        { reason: "has a name the fork cannot select", stem: "synthetic-swiftshader-hidden" },
        { reason: "is over the 1024 bytes the fork reads", stem: "wide" },
      ],
      wide: [1024, 1324],
    });
  });

  it("keeps facts that list an unreadable artifact for the next process, and probes again after a chmod either way", async () => {
    const executable = await fakeForkPath("kit", { root });
    const locked = path.join(path.dirname(executable), "personas", `locked${GL_SUFFIX}`);

    const lockedNow = async () => {
      const { fork } = await probeWith()(executable);

      return {
        dumps: await dumpsRun(executable),
        locked: glOnly(fork?.personas, "locked"),
      };
    };

    await writeFile(locked, JSON.stringify(hideOnlyGl("locked")));
    await chmod(locked, 0o000);

    const unreadable = [await lockedNow(), await lockedNow()];

    await chmod(locked, 0o644);

    const readable = await lockedNow();

    await chmod(locked, 0o000);

    expect([...unreadable, readable, await lockedNow()]).toStrictEqual([
      { dumps: 1, locked: { kind: undefined, refusal: "could not be read (EACCES)" } },
      { dumps: 1, locked: { kind: undefined, refusal: "could not be read (EACCES)" } },
      { dumps: 2, locked: { kind: "hide-only", refusal: undefined } },
      { dumps: 3, locked: { kind: undefined, refusal: "could not be read (EACCES)" } },
    ]);
  });

  it("refuses an artifact it cannot read and still resolves the probe", async () => {
    const executable = await fakeForkPath("kit", { root });
    const directory = path.join(path.dirname(executable), "personas");
    const locked = path.join(directory, `locked${GL_SUFFIX}`);

    await writeFile(locked, JSON.stringify(hideOnlyGl("locked")));
    await chmod(locked, 0o000);
    await mkdir(path.join(directory, `folder${GL_SUFFIX}`));

    const { fork } = await probeWith()(executable);

    expect(fork?.personas.refusedGl).toStrictEqual([
      { reason: "could not be read (EISDIR)", stem: "folder" },
      { reason: "could not be read (EACCES)", stem: "locked" },
    ]);
    expect(fork?.personas.gl).toStrictEqual(KIT_PERSONAS.gl);
  });

  it("rejects a package whose config sets gl-persona, naming the knob", async () => {
    const executable = await fakeForkPath("kit", { root });
    const kitDump = await readFile(KIT_DUMP, "utf-8");

    await replaceDump(
      executable,
      kitDump.replace("[def] gl-persona = <unset>", "[set] gl-persona = basharsx4-amd-renoir"),
    );

    await expect(failureOf(probeWith()(executable))).resolves.toStrictEqual({
      code: "BROWSER_LAUNCH_FAILED",
      message: `The Xrio fork package at ${await packageOf(executable)} failed its probe: its config sets gl-persona to "basharsx4-amd-renoir", and Xrio chooses the GL persona itself, so gl-persona must be unset.`,
    });
  });

  it("probes a package whose config sets gl-persona to nothing", async () => {
    const executable = await fakeForkPath("kit", { root });
    const kitDump = await readFile(KIT_DUMP, "utf-8");

    await replaceDump(
      executable,
      kitDump.replace("[def] gl-persona = <unset>", "[set] gl-persona ="),
    );

    await expect(probeWith()(executable)).resolves.toMatchObject({
      fork: { knobs: { "gl-persona": { origin: "set", value: "" } } },
    });
  });

  it("accepts an artifact whose hidden_extensions holds an empty string as hide-only", async () => {
    const personas = await personasOf({
      [`blank${GL_SUFFIX}`]: JSON.stringify({
        ...hideOnlyGl("blank"),
        hidden_extensions: ["", "WEBGL_synthetic_a"],
      }),
    });

    expect(personas?.gl.find(({ name }) => name === "blank")).toStrictEqual({
      chromeVersion: "154.0.8037.57",
      digest: GL_DIGEST,
      formFactor: "desktop",
      hiddenExtensions: ["", "WEBGL_synthetic_a"],
      kind: "hide-only",
      maxThreads: 8,
      name: "blank",
      renderer: "ANGLE (Synthetic, SwiftShader Device)",
      vendor: "Synthetic Inc.",
    });
    expect(personas?.refusedGl).toStrictEqual([]);
  });

  it("ignores a facts file of format 1 and probes the package again", async () => {
    const executable = await fakeForkPath("kit", { root });

    await probeWith()(executable);

    const entries = await readdir(scratch());
    const file = entries.find((entry) => entry.startsWith("host-facts-")) ?? "";
    const stored = await readFile(path.join(scratch(), file), "utf-8");

    await writeFile(path.join(scratch(), file), stored.replace('"format":2', '"format":1'));

    const { fork } = await probeWith()(executable);

    expect(fork?.personas.gl).toStrictEqual(KIT_PERSONAS.gl);
    await expect(dumpsRun(executable)).resolves.toBe(2);
  });
});

const AMD = {
  renderer: "ANGLE (AMD, Vulkan 1.3.255 (AMD Radeon Graphics (RADV RENOIR) (0x0000164C)), radv)",
  vendor: "Google Inc. (AMD)",
};

const isRendererProbed = (message: unknown): message is { event: string; detail: string } =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  message.event === "host-renderer-probed" &&
  "detail" in message &&
  typeof message.detail === "string";

const NVIDIA = {
  renderer: "ANGLE (NVIDIA, Vulkan 1.3.277 (NVIDIA GeForce RTX 3060 (0x00002504)), NVIDIA)",
  vendor: "Google Inc. (NVIDIA)",
};

const rendererProbeIn = (
  root: string,
  overrides: Partial<{ now: () => number; platform: NodeJS.Platform }> = {},
) =>
  createCapabilityProbe({
    drmDirectory: path.join(root, "drm"),
    parallelism: () => PARALLELISM,
    platform: "linux",
    processStatusFile: path.join(root, "no-status"),
    renderNodeDirectory: path.join(root, "dri"),
    root: path.join(root, "scratch"),
    ...overrides,
  });

const pciIdsIn = async (root: string, node: string, vendor: string, device: string) => {
  const directory = path.join(root, "drm", node, "device");

  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "vendor"), `${vendor}\n`);
  await writeFile(path.join(directory, "device"), `${device}\n`);
};

const renderNodesIn = async (root: string, ...names: string[]) => {
  await rm(path.join(root, "dri"), { force: true, recursive: true });
  await driWith(
    path.join(root, "dri"),
    Object.fromEntries(names.map((name) => [name, "readable" as const])),
  );
};

const readyForkIn = async (root: string) => {
  await renderNodesIn(root, "renderD128");

  const executable = await fakeForkPath("kit", { root });

  await setHostRenderer(executable, AMD);

  return executable;
};

const renderProbeStarted = async (executable: string, runs: number): Promise<void> => {
  if ((await renderProbesRun(executable)) < runs) {
    await delay(10);
    await renderProbeStarted(executable, runs);
  }
};

const rendererFilesIn = async (root: string) => {
  const entries = await readdir(path.join(root, "scratch"));

  return entries.filter((entry) => entry.startsWith("host-renderer-"));
};

const storedRendererIn = async (root: string): Promise<string> => {
  const [file = ""] = await rendererFilesIn(root);

  return await readFile(path.join(root, "scratch", file), "utf-8");
};

describe("hostCapabilities host renderer", () => {
  let root = "";
  let probed: string[] = [];

  const recordRendererProbe: ChannelListener = (message) => {
    if (isRendererProbed(message)) {
      probed.push(message.detail);
    }
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "xrio-capabilities-renderer-"));
    probed = [];
    subscribe("xrio:event", recordRendererProbe);
  });

  afterEach(async () => {
    unsubscribe("xrio:event", recordRendererProbe);
    await rm(root, { force: true, recursive: true });
  });

  it("learns the renderer once, and a second process reads it from the file", async () => {
    const executable = await readyForkIn(root);
    const clock = clockAt(1_000_000);
    const first = await rendererProbeIn(root, { now: clock.now })(executable);
    const second = await rendererProbeIn(root, { now: clock.now })(executable);
    const [file = ""] = await rendererFilesIn(root);

    expect([first.hostRenderer, second.hostRenderer]).toStrictEqual([AMD, AMD]);
    await expect(renderProbesRun(executable)).resolves.toBe(1);
    expect(file).toMatch(/^host-renderer-[\da-f]{64}\.json$/u);
    expect(JSON.parse(await storedRendererIn(root))).toStrictEqual({
      format: 1,
      kind: "learned",
      learnedAt: 1_000_000,
      ...AMD,
    });
    expect(probed).toStrictEqual([
      JSON.stringify({ binary: await realpath(executable), renderNodes: ["renderD128"], ...AMD }),
    ]);
  });

  it("keys the record by the render node, so another node launches again", async () => {
    const executable = await readyForkIn(root);

    await rendererProbeIn(root)(executable);
    await renderNodesIn(root, "renderD129");
    await expect(rendererProbeIn(root)(executable)).resolves.toMatchObject({ hostRenderer: AMD });

    await expect(renderProbesRun(executable)).resolves.toBe(2);
    await expect(rendererFilesIn(root)).resolves.toHaveLength(2);
  });

  it("reads the renderer again when its file does not hold one", async () => {
    const executable = await readyForkIn(root);

    await rendererProbeIn(root)(executable);

    const [file = ""] = await rendererFilesIn(root);

    await writeFile(path.join(root, "scratch", file), '{"format":1,"vendor":3}');
    await expect(rendererProbeIn(root)(executable)).resolves.toMatchObject({ hostRenderer: AMD });
    await expect(renderProbesRun(executable)).resolves.toBe(2);
  });

  it("learns the renderer again when the GPU behind the same render node changes", async () => {
    const executable = await readyForkIn(root);

    await pciIdsIn(root, "renderD128", "0x1002", "0x1636");
    await expect(rendererProbeIn(root)(executable)).resolves.toMatchObject({ hostRenderer: AMD });

    await pciIdsIn(root, "renderD128", "0x10de", "0x2504");
    await setHostRenderer(executable, NVIDIA);
    await expect(rendererProbeIn(root)(executable)).resolves.toMatchObject({
      hostRenderer: NVIDIA,
    });
    await expect(renderProbesRun(executable)).resolves.toBe(2);
  });

  it("forgets a renderer 24 hours after it was learned, also in a process that read it later", async () => {
    const executable = await readyForkIn(root);
    const clock = clockAt(1_000_000);

    await rendererProbeIn(root, { now: clock.now })(executable);
    clock.advance(23 * HOUR_MS);

    const later = rendererProbeIn(root, { now: clock.now });

    await later(executable);

    const launchesWhenRead = await renderProbesRun(executable);

    clock.advance(HOUR_MS);
    await expect(later(executable)).resolves.toMatchObject({ hostRenderer: AMD });
    expect([launchesWhenRead, await renderProbesRun(executable)]).toStrictEqual([1, 2]);
  });

  it("keeps the renderer another process learned while its own read failed", async () => {
    const executable = await readyForkIn(root);
    const clock = clockAt(1_000_000);
    const page = path.join(path.dirname(executable), "renderer-page.html");

    await rendererProbeIn(root, { now: clock.now })(executable);
    clock.advance(25 * HOUR_MS);
    await rm(page);
    execFileSync("/usr/bin/mkfifo", [page]);

    const reading = rendererProbeIn(root, { now: clock.now })(executable);

    await renderProbeStarted(executable, 2);

    const [file = ""] = await rendererFilesIn(root);
    const learnedMeanwhile = { format: 1, kind: "learned", learnedAt: clock.now(), ...NVIDIA };

    await writeFile(path.join(root, "scratch", file), JSON.stringify(learnedMeanwhile));
    await setHostRenderer(executable, null);

    await expect(reading).resolves.toMatchObject({ hostRenderer: NVIDIA });
    expect(JSON.parse(await storedRendererIn(root))).toStrictEqual(learnedMeanwhile);
  });

  it("learns the renderer again after a chmod of the binary either way", async () => {
    const executable = await readyForkIn(root);

    await rendererProbeIn(root)(executable);
    await chmod(executable, 0o700);
    await rendererProbeIn(root)(executable);
    await chmod(executable, 0o755);
    await rendererProbeIn(root)(executable);

    await expect(renderProbesRun(executable)).resolves.toBe(3);
  });

  it("keeps a learned renderer for 24 hours, then learns it again", async () => {
    const executable = await readyForkIn(root);
    const clock = clockAt(1_000_000);

    await rendererProbeIn(root, { now: clock.now })(executable);
    clock.advance(23 * HOUR_MS);
    await rendererProbeIn(root, { now: clock.now })(executable);
    await expect(renderProbesRun(executable)).resolves.toBe(1);

    clock.advance(2 * HOUR_MS);
    await expect(rendererProbeIn(root, { now: clock.now })(executable)).resolves.toMatchObject({
      hostRenderer: AMD,
    });
    await expect(renderProbesRun(executable)).resolves.toBe(2);
  });

  it("answers a scrape within half its remaining deadline and keeps learning for later ones", async () => {
    const executable = await readyForkIn(root);
    const probe = rendererProbeIn(root);
    const work = createProbeWork();

    const page = path.join(path.dirname(executable), "renderer-page.html");

    await rm(page);
    execFileSync("/usr/bin/mkfifo", [page]);
    using deadline = startDeadline(2000);

    const answered = await probe(executable, deadline, work);

    expect([answered.fork?.dialect, answered.hostRenderer]).toStrictEqual(["xrio", undefined]);
    expect(deadline.remainingMs()).toBeGreaterThan(500);

    await setHostRenderer(executable, AMD);
    await work.settled();

    expect(JSON.parse(await storedRendererIn(root))).toMatchObject({ kind: "learned", ...AMD });
    await expect(rendererProbeIn(root)(executable)).resolves.toMatchObject({ hostRenderer: AMD });
    await expect(renderProbesRun(executable)).resolves.toBe(1);
  });

  it("shares one launch between concurrent probes", async () => {
    const executable = await readyForkIn(root);
    const probe = rendererProbeIn(root);
    const results = await Promise.all([probe(executable), probe(executable), probe(executable)]);

    expect(results.map(({ hostRenderer }) => hostRenderer)).toStrictEqual([AMD, AMD, AMD]);
    await expect(renderProbesRun(executable)).resolves.toBe(1);
  });

  it("launches headless with both native GL switches and the dump", async () => {
    const executable = await readyForkIn(root);

    await rendererProbeIn(root)(executable);

    const [line = ""] = await renderProbeLines(executable);
    const [headless, profile, useGl, useAngle, dump, url = ""] = line.split(" ");

    expect([headless, useGl, useAngle, dump]).toStrictEqual([
      "--headless",
      "--use-gl=angle",
      "--use-angle=vulkan",
      "--dump-dom",
    ]);
    expect(profile).toMatch(/^--user-data-dir=\//u);
    expect(url.startsWith("data:text/html,")).toBeTruthy();
    expect(decodeURIComponent(url)).toContain("UNMASKED_RENDERER_WEBGL");
  });
});

describe("hostCapabilities host renderer that is not learned", () => {
  let root = "";
  let probed: string[] = [];

  const recordRendererProbe: ChannelListener = (message) => {
    if (isRendererProbed(message)) {
      probed.push(message.detail);
    }
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "xrio-capabilities-renderer-"));
    probed = [];
    subscribe("xrio:event", recordRendererProbe);
  });

  afterEach(async () => {
    unsubscribe("xrio:event", recordRendererProbe);
    await rm(root, { force: true, recursive: true });
  });

  it("launches nothing without a readable render node", async () => {
    const executable = await readyForkIn(root);

    await renderNodesIn(root);
    await expect(rendererProbeIn(root)(executable)).resolves.not.toHaveProperty("hostRenderer");
    await expect(renderProbesRun(executable)).resolves.toBe(0);
  });

  it("launches nothing off Linux", async () => {
    const executable = await readyForkIn(root);

    await expect(
      rendererProbeIn(root, { platform: "darwin" })(executable),
    ).resolves.not.toHaveProperty("hostRenderer");
    await expect(renderProbesRun(executable)).resolves.toBe(0);
  });

  it("launches nothing on stock Chrome", async () => {
    await renderNodesIn(root, "renderD128");

    const trap = await fakeForkPath("stock-trap", { root });

    await expect(rendererProbeIn(root)(trap)).resolves.toStrictEqual({
      permittedCpus: PARALLELISM,
      platform: "linux",
      readableRenderNode: true,
    });
    expect(existsSync(trapExecuted(trap))).toBeFalsy();
  });

  it("launches nothing on a fork whose personas hold no hardware artifact", async () => {
    const executable = await readyForkIn(root);

    await rm(path.join(path.dirname(executable), "personas", "synthetic-gpu.xrio-gl.json"));
    await expect(rendererProbeIn(root)(executable)).resolves.not.toHaveProperty("hostRenderer");
    await expect(renderProbesRun(executable)).resolves.toBe(0);
  });

  it.each([
    ["a page with no marker", undefined, "the page printed no WebGL payload"],
    ["a page that reports no WebGL context", null, "the page reported no WebGL renderer"],
  ])("gives no renderer and stores the failure for %s", async (_label, strings, reason) => {
    const executable = await readyForkIn(root);
    const probe = rendererProbeIn(root, { now: clockAt(1_000_000).now });

    await setHostRenderer(executable, strings);

    const result = await probe(executable);

    expect([result.fork?.dialect, result.hostRenderer]).toStrictEqual(["xrio", undefined]);
    expect(JSON.parse(await storedRendererIn(root))).toStrictEqual({
      failedAt: 1_000_000,
      format: 1,
      kind: "failed",
      reason,
    });
    expect(probed).toStrictEqual([
      JSON.stringify({
        binary: await realpath(executable),
        reason,
        renderNodes: ["renderD128"],
        renderer: null,
        vendor: null,
      }),
    ]);
  });

  it("keeps a failed read 60 s for the next process too, then reads again", async () => {
    const executable = await readyForkIn(root);
    const clock = clockAt(1_000_000);

    await setHostRenderer(executable, undefined);
    await rendererProbeIn(root, { now: clock.now })(executable);
    clock.advance(FAILED_PROBE_TTL_MS - 1);
    await rendererProbeIn(root, { now: clock.now })(executable);
    await expect(renderProbesRun(executable)).resolves.toBe(1);

    await setHostRenderer(executable, AMD);
    clock.advance(1);
    await expect(rendererProbeIn(root, { now: clock.now })(executable)).resolves.toMatchObject({
      hostRenderer: AMD,
    });
    await expect(renderProbesRun(executable)).resolves.toBe(2);
  });

  it("does not retry a failed read for 60 s, then reads again", async () => {
    const executable = await readyForkIn(root);
    const clock = clockAt(1_000_000);
    const probe = rendererProbeIn(root, { now: clock.now });

    await setHostRenderer(executable, undefined);
    await probe(executable);
    clock.advance(FAILED_PROBE_TTL_MS - 1);
    await probe(executable);
    await expect(renderProbesRun(executable)).resolves.toBe(1);

    await setHostRenderer(executable, AMD);
    clock.advance(1);
    await expect(probe(executable)).resolves.toMatchObject({ hostRenderer: AMD });
    await expect(renderProbesRun(executable)).resolves.toBe(2);
  });
});

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
      permittedCpus: PARALLELISM,
      platform: "linux",
    });
    await expect(fcListRuns(fixture())).resolves.toStrictEqual([]);
  });

  it("looks for no stack off Linux", async () => {
    await expect(probeOn({ platform: "darwin" })(fixture().binary)).resolves.toStrictEqual({
      permittedCpus: PARALLELISM,
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

  it("answers at its deadline mid-check, and settles the caller's work once the check is kept", async () => {
    const work = createProbeWork();

    await hangFcListFor(fixture(), 1);
    using deadline = startDeadline(200);

    await expect(probeOn()(fixture().binary, deadline, work)).rejects.toMatchObject({
      code: "TIMEOUT",
    });

    const keptAtDeadline = await stackFiles();

    await work.settled();

    const keptOnceSettled = await stackFiles();

    expect([keptAtDeadline.length, keptOnceSettled.length]).toStrictEqual([0, 1]);
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
