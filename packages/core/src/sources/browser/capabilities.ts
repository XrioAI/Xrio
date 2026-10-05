import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, constants, readdir, readFile, realpath, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { text } from "node:stream/consumers";

import { hostCacheRoot } from "../../cache-dir.ts";
import { untilDeadline } from "../../deadline.ts";
import type { Deadline } from "../../deadline.ts";
import { publishInternalEvent } from "../../diagnostics.ts";
import { XrioError } from "../../errors.ts";
import type {
  ForkFacts,
  HostCapabilities,
  KnobOrigin,
  KnobRegistry,
  SpeechPersona,
} from "../../humanizer/contracts.ts";
import { FORK_DUMP_SWITCH } from "../../humanizer/owned-inputs.ts";
import type { ScratchDir } from "./browser-process.ts";
import {
  createScratchDir,
  ensureScratchRoot,
  removeScratchDir,
  scratchRoot,
  writeAtomically,
} from "./browser-process.ts";
import { createFontStackCheck, fontStackBeside } from "./font-stack.ts";
import { killProcessGroup, retireProcessGroup } from "./group-lifetime.ts";
import { TEARDOWN_BUDGET_MS } from "./port.ts";

const PERSONA_MARKER = "personas";

const KNOB_FILE = "xrio-config.json";

const VERSIONS_FILE = "VERSIONS";

const PACKAGE_FILES = [VERSIONS_FILE, KNOB_FILE, PERSONA_MARKER] as const;

const FORK_VERSION_LINE = /^FORK_VERSION=/mu;

const FORK_COMMIT_LINE = /^FORK_COMMIT=(?<value>[^\r\n]*)\r?$/gmu;

const FORK_DIRTY_LINE = /^FORK_DIRTY=(?<value>[^\r\n]*)\r?$/gmu;

const COMMIT_HASH = /^[\dA-Fa-f]{40}$/u;

const UNREADABLE_VERSIONS = "\0unreadable";

const DIRTY_COUNT = /^\d+$/u;

const PROBE_BUDGET_MS = 10_000;

export const PROBE_SETTLE_BUDGET_MS = PROBE_BUDGET_MS + TEARDOWN_BUDGET_MS;

const FAILED_PROBE_TTL_MS = 60_000;

const STDERR_TAIL_CHARS = 2048;

const FACTS_FORMAT = 1;

const RENDER_NODE_DIRECTORY = "/dev/dri";

const PROCESS_STATUS_FILE = "/proc/self/status";

const ONLINE_CPUS_FILE = "/sys/devices/system/cpu/online";

const CPUS_ALLOWED_LINE = /^Cpus_allowed_list:[ \t]*(?<list>[^\r\n]*?)[ \t]*$/mu;

const CPU_RANGE = /^(?<first>\d+)(?:-(?<last>\d+))?$/u;

const RENDER_NODE_NAME = /^renderD\d+$/u;

const UNSET_VALUES = new Set(["<unset>", "<absent>"]);

const ABSENT_DIRECTORY_CODES = new Set(["ENOENT", "ENOTDIR"]);

const DUMP_HEADER = /^xrio-knobs: (?<count>\d+) knobs$/u;

const DUMP_ROW = /^\[(?<origin>set|def|umb|der)\] (?<key>[\da-z-]+) =(?: (?<value>.*))?$/u;

const VERSION = /\b(?<version>\d+\.\d+\.\d+\.\d+)\b/u;

const DIGEST = /^sha256:[\da-f]{64}$/u;

const ARTIFACT_KINDS = {
  speech: { schema: "xrio-speech-table/v1", suffixKnob: "speech-table-suffix" },
} as const;

const ARTIFACT_KIND_NAMES = ["speech"] as const;

type ArtifactKind = (typeof ARTIFACT_KIND_NAMES)[number];

interface ForkPackage {
  readonly binary: string;
  readonly directory: string;
  readonly versions: string | null;
}

type ForkBuild = Pick<ForkFacts, "buildUnreadable" | "commit" | "dirty">;

interface ArtifactText {
  readonly file: string;
  readonly text: string;
}

interface ProbeOutputs {
  readonly dump: string;
  readonly version: string;
  readonly artifacts: readonly ArtifactText[];
  readonly personaSignature: string;
}

type StoredFacts =
  | {
      readonly format: typeof FACTS_FORMAT;
      readonly kind: "probed";
      readonly outputs: ProbeOutputs;
    }
  | {
      readonly format: typeof FACTS_FORMAT;
      readonly kind: "failed";
      readonly failedAt: number;
      readonly reason: string;
    };

interface RawArtifact {
  readonly schema: string;
  readonly name: string;
  readonly digest: string;
  readonly chrome_version: string;
}

interface ProbeOptions {
  readonly budgetMs: number;
  readonly budgetSignal: (budgetMs: number) => AbortSignal;
  readonly fcList: string;
  readonly now: () => number;
  readonly renderNodeDirectory: string;
  readonly onlineCpusFile: string;
  readonly processStatusFile: string;
  readonly parallelism: () => number;
  readonly platform: NodeJS.Platform;
  readonly root: string;
  readonly scratchRoot: string;
  readonly signal: AbortSignal;
}

interface ProbeEntry {
  readonly facts: Promise<ForkFacts>;
  failedAt?: number;
}

interface ForkRun {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ProbeFailure {
  readonly cacheable?: boolean;
  readonly failedAt?: number;
  readonly stderr?: string;
}

class ForkProbeError extends Error {
  override readonly name = "ForkProbeError";
  readonly cacheable: boolean;
  readonly failedAt: number | undefined;
  readonly stderr: string;

  constructor(reason: string, { cacheable = true, failedAt, stderr = "" }: ProbeFailure = {}) {
    super(reason);
    this.cacheable = cacheable;
    this.failedAt = failedAt;
    this.stderr = stderr;
  }
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isKnobOrigin = (value: string | undefined): value is KnobOrigin =>
  value === "set" || value === "def" || value === "umb" || value === "der";

const isRawArtifact = (value: unknown): value is RawArtifact =>
  isObject(value) &&
  "schema" in value &&
  isText(value.schema) &&
  "name" in value &&
  isText(value.name) &&
  "digest" in value &&
  isText(value.digest) &&
  DIGEST.test(value.digest) &&
  "chrome_version" in value &&
  isText(value.chrome_version);

const isArtifactText = (value: unknown): value is ArtifactText =>
  isObject(value) && "file" in value && isText(value.file) && "text" in value && isText(value.text);

const isProbeOutputs = (value: unknown): value is ProbeOutputs =>
  isObject(value) &&
  "dump" in value &&
  isText(value.dump) &&
  "version" in value &&
  isText(value.version) &&
  "artifacts" in value &&
  Array.isArray(value.artifacts) &&
  value.artifacts.every(isArtifactText) &&
  "personaSignature" in value &&
  isText(value.personaSignature);

const isStoredFacts = (value: unknown): value is StoredFacts => {
  if (!isObject(value) || !("format" in value) || value.format !== FACTS_FORMAT) {
    return false;
  }

  const isProbed = "kind" in value && value.kind === "probed";
  const isFailed = "kind" in value && value.kind === "failed";

  return (
    (isProbed && "outputs" in value && isProbeOutputs(value.outputs)) ||
    (isFailed &&
      "failedAt" in value &&
      isNumber(value.failedAt) &&
      "reason" in value &&
      isText(value.reason))
  );
};

const namesIn = async (directory: string): Promise<string[]> => {
  try {
    const names = await readdir(directory);

    return names.toSorted();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ABSENT_DIRECTORY_CODES.has(String(error.code))
    ) {
      return [];
    }

    throw error;
  }
};

const isFile = async (file: string): Promise<boolean> => {
  try {
    const stats = await stat(file);

    return stats.isFile();
  } catch {
    return false;
  }
};

const isReadable = async (file: string): Promise<boolean> => {
  try {
    await access(file, constants.R_OK);

    return true;
  } catch {
    return false;
  }
};

const hasReadableRenderNode = async (directory: string): Promise<boolean> => {
  const names = await namesIn(directory);

  const readable = await Promise.all(
    names
      .filter((name) => RENDER_NODE_NAME.test(name))
      .map(async (name) => await isReadable(path.join(directory, name))),
  );

  return readable.includes(true);
};

const cpusInList = (list: string): ReadonlySet<number> | undefined => {
  const cpus = new Set<number>();

  for (const part of list.split(",")) {
    const { first, last = first } = CPU_RANGE.exec(part)?.groups ?? {};

    if (first === undefined || Number(last) < Number(first)) {
      return undefined;
    }

    for (let cpu = Number(first); cpu <= Number(last); cpu += 1) {
      cpus.add(cpu);
    }
  }

  return cpus;
};

const readCpuList = async (
  file: string,
  listOf: (content: string) => string | undefined,
): Promise<ReadonlySet<number> | undefined> => {
  try {
    const list = listOf(await readFile(file, "utf-8"));

    return list === undefined ? undefined : cpusInList(list);
  } catch {
    return undefined;
  }
};

const allowedCpusIn = async ({
  onlineCpusFile,
  processStatusFile,
}: Pick<ProbeOptions, "onlineCpusFile" | "processStatusFile">): Promise<number | undefined> => {
  const allowed = await readCpuList(
    processStatusFile,
    (content) => CPUS_ALLOWED_LINE.exec(content)?.groups?.list,
  );

  if (allowed === undefined) {
    return undefined;
  }

  const online = await readCpuList(onlineCpusFile, (content) => content.trim());

  const counted =
    online === undefined ? allowed : new Set([...allowed].filter((cpu) => online.has(cpu)));

  return counted.size > 0 ? counted.size : allowed.size;
};

const permittedCpusOf = async ({
  parallelism,
  platform,
  ...files
}: Pick<
  ProbeOptions,
  "onlineCpusFile" | "parallelism" | "platform" | "processStatusFile"
>): Promise<number> =>
  (platform === "linux" ? await allowedCpusIn(files) : undefined) ?? parallelism();

const readVersions = async (versions: string): Promise<string | null> => {
  if (!(await isFile(versions))) {
    return "";
  }

  try {
    return await readFile(versions, "utf-8");
  } catch {
    return null;
  }
};

const forkPackageOf = async (browserPath: string): Promise<ForkPackage | undefined> => {
  let binary: string;

  try {
    binary = await realpath(browserPath);
  } catch {
    return undefined;
  }

  const directory = path.dirname(binary);

  const [versions, hasKnobFile] = await Promise.all([
    readVersions(path.join(directory, VERSIONS_FILE)),
    isFile(path.join(directory, KNOB_FILE)),
  ]);

  return hasKnobFile || FORK_VERSION_LINE.test(versions ?? "")
    ? { binary, directory, versions }
    : undefined;
};

const statOf = async (file: string) => {
  try {
    const { dev, ino, mtimeMs, size } = await stat(file);

    return [file, dev, ino, size, mtimeMs];
  } catch {
    return [file, null];
  }
};

const statsSignature = async (files: readonly string[]): Promise<string> => {
  const stats = await Promise.all(files.map(statOf));

  return createHash("sha256").update(JSON.stringify(stats)).digest("hex");
};

const directorySignature = async (directory: string): Promise<string> => {
  const names = await namesIn(directory);

  return await statsSignature([directory, ...names.map((name) => path.join(directory, name))]);
};

const packageSignature = async ({ binary, directory, versions }: ForkPackage): Promise<string> => {
  const personaDir = path.join(directory, PERSONA_MARKER);
  const personas = await namesIn(personaDir);

  const files = await statsSignature([
    binary,
    ...PACKAGE_FILES.map((file) => path.join(directory, file)),
    ...personas.map((name) => path.join(personaDir, name)),
  ]);

  return createHash("sha256")
    .update(files)
    .update(versions ?? UNREADABLE_VERSIONS)
    .digest("hex");
};

const parseDump = (dump: string): KnobRegistry => {
  const [header = "", ...lines] = dump.trimEnd().split("\n");
  const count = DUMP_HEADER.exec(header)?.groups?.count;

  if (count === undefined) {
    throw new ForkProbeError("the dump has no xrio-knobs header");
  }

  const knobs: Record<string, KnobRegistry[string]> = {};

  for (const line of lines) {
    const row = DUMP_ROW.exec(line)?.groups;

    if (row?.key === undefined || !isKnobOrigin(row.origin)) {
      throw new ForkProbeError(`the dump has a malformed row ${JSON.stringify(line)}`);
    }

    const value = row.value ?? "";

    knobs[row.key] = { origin: row.origin, value: UNSET_VALUES.has(value) ? null : value };
  }

  const listed = Object.keys(knobs).length;

  if (listed !== Number(count)) {
    throw new ForkProbeError(`the dump lists ${listed} of ${count} knobs`);
  }

  return knobs;
};

const parseVersion = (output: string): string => {
  const version = VERSION.exec(output)?.groups?.version;

  if (version === undefined) {
    throw new ForkProbeError(`--version printed no version: ${JSON.stringify(output.trim())}`);
  }

  return version;
};

const suffixOf = (kind: ArtifactKind, knobs: KnobRegistry): string | null =>
  knobs[ARTIFACT_KINDS[kind].suffixKnob]?.value ?? null;

const kindOf = (file: string, knobs: KnobRegistry): ArtifactKind | undefined =>
  ARTIFACT_KIND_NAMES.find((kind) => {
    const suffix = suffixOf(kind, knobs);

    return suffix !== null && suffix !== "" && file.endsWith(suffix);
  });

const auditArtifact = (
  { file, text: contents }: ArtifactText,
  kind: ArtifactKind,
  knobs: KnobRegistry,
): RawArtifact => {
  let artifact: unknown;

  try {
    artifact = JSON.parse(contents);
  } catch {
    throw new ForkProbeError(`persona ${file} is not JSON`);
  }

  const { schema } = ARTIFACT_KINDS[kind];
  const stem = file.slice(0, file.length - (suffixOf(kind, knobs) ?? "").length);

  if (!isRawArtifact(artifact)) {
    throw new ForkProbeError(
      `persona ${file} lacks a schema, name, sha256 digest or chrome_version`,
    );
  }

  if (artifact.schema !== schema) {
    throw new ForkProbeError(`persona ${file} has schema ${artifact.schema}, not ${schema}`);
  }

  if (artifact.name !== stem) {
    throw new ForkProbeError(
      `persona ${file} is named ${JSON.stringify(artifact.name)}, not its file stem ${stem}`,
    );
  }

  return artifact;
};

const personaOf = ({ chrome_version: chromeVersion, digest, name, schema }: RawArtifact) => ({
  chromeVersion,
  digest,
  name,
  schema,
});

const speechPersonaOf = (artifact: ArtifactText, knobs: KnobRegistry): SpeechPersona =>
  personaOf(auditArtifact(artifact, "speech", knobs));

const lineValues = (line: RegExp, versions: string): string[] =>
  [...versions.matchAll(line)].map((match) => match.groups?.value ?? "");

const commitOf = ([recorded, ...repeated]: readonly string[]): string | null =>
  recorded !== undefined && repeated.length === 0 && COMMIT_HASH.test(recorded)
    ? recorded.toLowerCase()
    : null;

const dirtyOf = ([recorded, ...repeated]: readonly string[]): number | null =>
  recorded !== undefined &&
  repeated.length === 0 &&
  DIRTY_COUNT.test(recorded) &&
  Number.isSafeInteger(Number(recorded))
    ? Number(recorded)
    : null;

const buildOf = (versions: string | null): ForkBuild => {
  if (versions === null) {
    return { buildUnreadable: true, commit: null, dirty: null };
  }

  const commitLines = lineValues(FORK_COMMIT_LINE, versions);
  const dirtyLines = lineValues(FORK_DIRTY_LINE, versions);
  const commit = commitOf(commitLines);
  const dirty = dirtyOf(dirtyLines);

  return {
    buildUnreadable:
      (commitLines.length > 0 && commit === null) || (dirtyLines.length > 0 && dirty === null),
    commit,
    dirty,
  };
};

const factsOf = ({ artifacts, dump, version }: ProbeOutputs, fork: ForkPackage): ForkFacts => {
  const knobs = parseDump(dump);
  const speech: SpeechPersona[] = [];

  for (const artifact of artifacts) {
    const kind = kindOf(artifact.file, knobs);

    if (kind === "speech") {
      speech.push(speechPersonaOf(artifact, knobs));
    }
  }

  return {
    ...buildOf(fork.versions),
    dialect: "xrio",
    knobs,
    packageDir: fork.directory,
    personas: { speech },
    version: parseVersion(version),
  };
};

const personaDirOf = ({ directory }: ForkPackage, knobs: KnobRegistry): string =>
  path.resolve(
    directory,
    knobs["persona-dir"]?.value ?? knobs["persona-dir-name"]?.value ?? PERSONA_MARKER,
  );

const readArtifacts = async (directory: string, knobs: KnobRegistry): Promise<ArtifactText[]> => {
  const names = await namesIn(directory);
  const files = names.filter((file) => kindOf(file, knobs) !== undefined);

  return await Promise.all(
    files.map(async (file) => ({
      file,
      text: await readFile(path.join(directory, file), "utf-8"),
    })),
  );
};

interface ForkStops {
  readonly budget: AbortSignal;
  readonly budgetMs: number;
  readonly groups: Set<number>;
  readonly shutdown: AbortSignal;
}

const outputsOf = async (child: ChildProcessByStdio<null, Readable, Readable>) => {
  const [stdout, stderr] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    once(child, "close"),
  ]);

  return { stderr, stdout };
};

const runFork = async (
  binary: string,
  args: readonly string[],
  stop: AbortSignal,
  groups: Set<number>,
): Promise<ForkRun | undefined> => {
  const child = spawn(binary, args, {
    detached: true,
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (child.pid !== undefined) {
    groups.add(child.pid);
  }

  const stopped = Promise.withResolvers<"stopped">();

  const onStop = () => {
    stopped.resolve("stopped");
  };

  if (stop.aborted) {
    onStop();
  } else {
    stop.addEventListener("abort", onStop, { once: true });
  }

  try {
    const outputs = await Promise.race([outputsOf(child), stopped.promise]);

    return outputs === "stopped"
      ? undefined
      : { ...outputs, exitCode: child.exitCode, signalCode: child.signalCode };
  } catch (error) {
    throw new ForkProbeError(`${args[0]} could not run: ${messageOf(error)}`, {
      cacheable: false,
    });
  } finally {
    stop.removeEventListener("abort", onStop);

    if (child.pid !== undefined) {
      killProcessGroup(child.pid);
    }

    child.stdout.destroy();
    child.stderr.destroy();
  }
};

const runForkOutput = async (
  binary: string,
  args: readonly string[],
  { budget, budgetMs, groups, shutdown }: ForkStops,
): Promise<string> => {
  const run = await runFork(binary, args, AbortSignal.any([budget, shutdown]), groups);

  if (shutdown.aborted) {
    throw new ForkProbeError(`${args[0]} was stopped because its client closed`, {
      cacheable: false,
    });
  }

  if (run === undefined || budget.aborted) {
    throw new ForkProbeError(`${args[0]} did not finish within ${budgetMs} ms`, {
      stderr: run?.stderr ?? "",
    });
  }

  const { exitCode, signalCode, stderr, stdout } = run;

  if (exitCode !== 0) {
    const ended = signalCode === null ? `exited with status ${exitCode}` : `died of ${signalCode}`;

    throw new ForkProbeError(`${args[0]} ${ended}`, { stderr });
  }

  return stdout;
};

const settledOrThrow = <Value>(result: PromiseSettledResult<Value>): Value => {
  if (result.status === "rejected") {
    throw result.reason;
  }

  return result.value;
};

const removeProbeScratch = async (scratch: ScratchDir, groups: Set<number>): Promise<void> => {
  const signal = AbortSignal.timeout(TEARDOWN_BUDGET_MS);

  try {
    const exited = await Promise.all(
      [...groups].map(async (pid) => await retireProcessGroup(pid, signal)),
    );

    if (exited.includes(false)) {
      throw new Error("Chrome outlived its fork probe, so its scratch was kept.");
    }

    await removeScratchDir(scratch, signal);
  } catch (error) {
    publishInternalEvent({
      detail: `Removing the fork probe's scratch failed: ${messageOf(error)}`,
      event: "teardown-incomplete",
    });
  }
};

const probeOutputs = async (
  fork: ForkPackage,
  { budgetMs, now, scratchRoot: root, signal }: ProbeOptions,
): Promise<ProbeOutputs> => {
  if (signal.aborted) {
    throw new ForkProbeError("the probe was stopped because its client closed", {
      cacheable: false,
    });
  }

  const scratch = await createScratchDir(now(), root, "probe");
  const groups = new Set<number>();
  const stops = { budget: AbortSignal.timeout(budgetMs), budgetMs, groups, shutdown: signal };
  const dumpArgs = [FORK_DUMP_SWITCH, `--user-data-dir=${scratch.path}`, "--headless"];

  try {
    const [dumped, versioned] = await Promise.allSettled([
      runForkOutput(fork.binary, dumpArgs, stops),
      runForkOutput(fork.binary, ["--version"], stops),
    ]);

    const dump = settledOrThrow(dumped);
    const version = settledOrThrow(versioned);
    const knobs = parseDump(dump);
    const personaDir = personaDirOf(fork, knobs);

    const [artifacts, personaSignature] = await Promise.all([
      readArtifacts(personaDir, knobs),
      directorySignature(personaDir),
    ]);

    return { artifacts, dump, personaSignature, version };
  } finally {
    await removeProbeScratch(scratch, groups);
  }
};

const readStoredFacts = async (file: string): Promise<StoredFacts | undefined> => {
  let stored: unknown;

  try {
    stored = JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return undefined;
  }

  return isStoredFacts(stored) ? stored : undefined;
};

const storeFacts = async (file: string, stored: StoredFacts): Promise<boolean> => {
  try {
    await writeAtomically(file, JSON.stringify(stored));

    return true;
  } catch {
    return false;
  }
};

const parsedFacts = (outputs: ProbeOutputs, fork: ForkPackage): ForkFacts | undefined => {
  try {
    return factsOf(outputs, fork);
  } catch {
    return undefined;
  }
};

const factsFromStore = async (
  outputs: ProbeOutputs,
  fork: ForkPackage,
): Promise<ForkFacts | undefined> => {
  const facts = parsedFacts(outputs, fork);

  if (facts === undefined) {
    return undefined;
  }

  const personaSignature = await directorySignature(personaDirOf(fork, facts.knobs));

  return personaSignature === outputs.personaSignature ? facts : undefined;
};

const probeFailed = ({ directory }: ForkPackage, cause: unknown): XrioError =>
  new XrioError(
    "BROWSER_LAUNCH_FAILED",
    `The Xrio fork package at ${directory} failed its probe: ${messageOf(cause)}.`,
    {
      cause,
      details: {
        mismatches: [],
        stderr: cause instanceof ForkProbeError ? cause.stderr.slice(-STDERR_TAIL_CHARS) : "",
      },
    },
  );

export type HostCapabilityProbe = (
  browserPath: string | undefined,
  deadline?: Deadline,
) => Promise<HostCapabilities>;

export const createCapabilityProbe = (
  overrides: Partial<ProbeOptions> = {},
): HostCapabilityProbe => {
  const options: ProbeOptions = {
    budgetMs: PROBE_BUDGET_MS,
    budgetSignal: (budgetMs) => AbortSignal.timeout(budgetMs),
    fcList: "fc-list",
    now: Date.now,
    onlineCpusFile: ONLINE_CPUS_FILE,
    parallelism: availableParallelism,
    platform: process.platform,
    processStatusFile: PROCESS_STATUS_FILE,
    renderNodeDirectory: RENDER_NODE_DIRECTORY,
    root: hostCacheRoot(),
    scratchRoot: overrides.root ?? scratchRoot(),
    signal: new AbortController().signal,
    ...overrides,
  };

  const checkFontStack = createFontStackCheck(options);

  const entries = new Map<string, ProbeEntry>();

  const isFresh = (failedAt: number): boolean => options.now() - failedAt < FAILED_PROBE_TTL_MS;

  const probeAndStore = async (fork: ForkPackage, file: string): Promise<ForkFacts> => {
    try {
      const outputs = await probeOutputs(fork, options);
      const facts = factsOf(outputs, fork);

      await storeFacts(file, { format: FACTS_FORMAT, kind: "probed", outputs });

      publishInternalEvent({
        detail: JSON.stringify({
          knobs: Object.keys(facts.knobs).length,
          package: fork.directory,
          version: facts.version,
        }),
        event: "fork-probed",
      });

      return facts;
    } catch (error) {
      if (!(error instanceof ForkProbeError) || !error.cacheable) {
        throw new ForkProbeError(messageOf(error), { cacheable: false });
      }

      const failedAt = options.now();
      const current = await readStoredFacts(file);

      if (current?.kind !== "probed") {
        await storeFacts(file, {
          failedAt,
          format: FACTS_FORMAT,
          kind: "failed",
          reason: error.message,
        });
      }

      throw new ForkProbeError(error.message, { failedAt, stderr: error.stderr });
    }
  };

  const factsFor = async (fork: ForkPackage, key: string): Promise<ForkFacts> => {
    await ensureScratchRoot(options.root);

    const file = path.join(options.root, `host-facts-${key}.json`);
    const stored = await readStoredFacts(file);

    const known =
      stored?.kind === "probed" ? await factsFromStore(stored.outputs, fork) : undefined;

    if (known !== undefined) {
      return known;
    }

    if (stored?.kind === "failed" && isFresh(stored.failedAt)) {
      throw new ForkProbeError(stored.reason, { failedAt: stored.failedAt });
    }

    return await probeAndStore(fork, file);
  };

  const sharedFacts = async (fork: ForkPackage, key: string): Promise<ForkFacts> => {
    const known = entries.get(key);

    if (known !== undefined && (known.failedAt === undefined || isFresh(known.failedAt))) {
      return await known.facts;
    }

    const entry: ProbeEntry = { facts: factsFor(fork, key) };

    entries.set(key, entry);

    try {
      return await entry.facts;
    } catch (error) {
      if (error instanceof ForkProbeError && error.cacheable) {
        entry.failedAt = error.failedAt ?? options.now();
      } else if (entries.get(key) === entry) {
        entries.delete(key);
      }

      throw error;
    }
  };

  const forkFactsOf = async (fork: ForkPackage): Promise<ForkFacts> => {
    try {
      return await sharedFacts(fork, await packageSignature(fork));
    } catch (error) {
      throw probeFailed(fork, error);
    }
  };

  const probeFork: HostCapabilityProbe = async (browserPath, deadline) => {
    const permittedCpus = await permittedCpusOf(options);

    const host: HostCapabilities = (await hasReadableRenderNode(options.renderNodeDirectory))
      ? { permittedCpus, platform: options.platform, readableRenderNode: true }
      : { permittedCpus, platform: options.platform };

    const fork = browserPath === undefined ? undefined : await forkPackageOf(browserPath);

    if (fork === undefined) {
      return host;
    }

    const facts =
      deadline === undefined
        ? await forkFactsOf(fork)
        : await untilDeadline(async () => await forkFactsOf(fork), deadline);

    return { ...host, fork: facts };
  };

  const probeFontStack = async (
    browserPath: string | undefined,
    deadline: Deadline | undefined,
  ) => {
    if (options.platform !== "linux" || browserPath === undefined) {
      return null;
    }

    const directory = await fontStackBeside(browserPath);

    if (directory === null) {
      return null;
    }

    return deadline === undefined
      ? await checkFontStack(directory)
      : await untilDeadline(async () => await checkFontStack(directory), deadline);
  };

  return async (browserPath, deadline) => {
    const [capabilities, fontStack] = await Promise.all([
      probeFork(browserPath, deadline),
      probeFontStack(browserPath, deadline),
    ]);

    return fontStack === null ? capabilities : { ...capabilities, fontStack };
  };
};
