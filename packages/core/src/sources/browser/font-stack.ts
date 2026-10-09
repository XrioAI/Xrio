import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";

import { publishInternalEvent } from "../../diagnostics.ts";
import type { FontStack, FontStackFacts } from "../../humanizer/contracts.ts";
import {
  FONT_CONFIG_NAME,
  fontCheckEnvironment,
  fontConfigOf,
  fontConfigPathOf,
} from "../../humanizer/fonts.ts";
import {
  createScratchDir,
  ensureScratchRoot,
  removeScratchDir,
  writeAtomically,
} from "./browser-process.ts";

const STACK_DIRECTORY = "fontstack";

const MANIFEST = "stack.json";

const RULE_FILE = /^\d.*\.conf$/u;

const SHA256 = /^[\da-f]{64}$/u;

const CHECK_FORMAT = 1;

const REFUSED_CHECK_TTL_MS = 60_000;

const REASON_STDERR_CHARS = 200;

const PAYLOAD_ROOTS = ["fonts", "share"] as const;

const HASH_WORKERS = 8;

const MS_PER_SECOND = 1000;

const FONTCONFIG_UUID = ".uuid";

export interface FontCheckOptions {
  readonly budgetMs: number;
  readonly budgetSignal: (budgetMs: number) => AbortSignal;
  readonly fcList: string;
  readonly now: () => number;
  readonly root: string;
  readonly scratchRoot: string;
  readonly signal: AbortSignal;
}

interface Manifest {
  readonly payload: string;
  readonly families: readonly string[];
}

interface CheckOutputs {
  readonly payload: string;
  readonly listing: string;
  readonly stderr: string;
}

interface StoredCheck {
  readonly format: typeof CHECK_FORMAT;
  readonly checkedAt: number;
  readonly outputs: CheckOutputs;
}

interface CheckResult {
  readonly facts: FontStackFacts;
  readonly transient: boolean;
}

interface CheckEntry {
  readonly result: Promise<CheckResult>;
  refusedAt?: number;
}

class FontStackRefusalError extends Error {
  override readonly name = "FontStackRefusalError";
  readonly kept: boolean;

  constructor(reason: string, { cause, kept = false }: { cause?: unknown; kept?: boolean } = {}) {
    super(reason, { cause });
    this.kept = kept;
  }
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isManifest = (value: unknown): value is Manifest =>
  isObject(value) &&
  "payload" in value &&
  isText(value.payload) &&
  SHA256.test(value.payload) &&
  "families" in value &&
  Array.isArray(value.families) &&
  value.families.length > 0 &&
  value.families.every(isText);

const isCheckOutputs = (value: unknown): value is CheckOutputs =>
  isObject(value) &&
  "payload" in value &&
  isText(value.payload) &&
  "listing" in value &&
  isText(value.listing) &&
  "stderr" in value &&
  isText(value.stderr);

const isStoredCheck = (value: unknown): value is StoredCheck =>
  isObject(value) &&
  "format" in value &&
  value.format === CHECK_FORMAT &&
  "checkedAt" in value &&
  isNumber(value.checkedAt) &&
  "outputs" in value &&
  isCheckOutputs(value.outputs);

export const fontStackBeside = async (browserPath: string): Promise<string | null> => {
  try {
    const directory = path.join(path.dirname(await realpath(browserPath)), STACK_DIRECTORY);
    const manifest = await stat(path.join(directory, MANIFEST));

    return manifest.isFile() ? directory : null;
  } catch {
    return null;
  }
};

const statOf = async (entry: string) => {
  try {
    const { dev, ino, mtimeMs, size } = await stat(entry);

    return [entry, dev, ino, size, Math.floor(mtimeMs / MS_PER_SECOND)];
  } catch {
    return [entry, null];
  }
};

const signatureOf = async (directory: string): Promise<string> => {
  const stats = await Promise.all(
    [
      path.join(directory, MANIFEST),
      path.join(directory, "fonts"),
      path.join(directory, "share"),
      path.join(fontConfigPathOf({ directory }), "conf.d"),
    ].map(statOf),
  );

  return createHash("sha256")
    .update(JSON.stringify([directory, ...stats]))
    .digest("hex");
};

const readManifest = async (directory: string): Promise<Manifest> => {
  let manifest: unknown;

  try {
    manifest = JSON.parse(await readFile(path.join(directory, MANIFEST), "utf-8"));
  } catch (error) {
    throw new FontStackRefusalError(`${MANIFEST} cannot be read: ${messageOf(error)}`, {
      cause: error,
    });
  }

  if (!isManifest(manifest)) {
    throw new FontStackRefusalError(`${MANIFEST} has no sha256 payload or family list`);
  }

  return manifest;
};

const readRules = async (directory: string): Promise<string[]> => {
  let names: string[] = [];

  try {
    names = await readdir(path.join(fontConfigPathOf({ directory }), "conf.d"));
  } catch (error) {
    throw new FontStackRefusalError(`fonts/conf.d cannot be read: ${messageOf(error)}`, {
      cause: error,
    });
  }

  const rules = names.filter((name) => RULE_FILE.test(name)).toSorted();

  if (rules.length === 0) {
    throw new FontStackRefusalError("fonts/conf.d holds no rules");
  }

  return rules;
};

const namesIn = (listing: string): string[] => [
  ...new Set(
    listing
      .split("\n")
      .flatMap((line) => line.split(","))
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  ),
];

const verdictOf = (
  { listing, payload, stderr }: CheckOutputs,
  manifest: Manifest,
  stack: Omit<FontStack, "families" | "payload">,
): FontStackFacts => {
  if (payload !== manifest.payload) {
    return {
      kind: "refused",
      reason: `the payload digest ${payload} differs from the manifest's ${manifest.payload}`,
    };
  }

  if (stderr.trim() !== "") {
    return {
      kind: "refused",
      reason: `fc-list wrote to stderr: ${stderr.trim().slice(0, REASON_STDERR_CHARS)}`,
    };
  }

  const families = namesIn(listing).length;

  if (families !== manifest.families.length) {
    return {
      kind: "refused",
      reason: `fc-list printed ${families} families, the manifest lists ${manifest.families.length}`,
    };
  }

  return { ...stack, families, kind: "checked", payload };
};

const compareBytes = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));

const filesUnder = async (directory: string, root: string): Promise<string[]> => {
  const entries = await readdir(path.join(directory, root), {
    recursive: true,
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile() && entry.name !== FONTCONFIG_UUID)
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)));
};

const fileDigestOf = async (file: string, budget: AbortSignal): Promise<string> => {
  const hash = createHash("sha256");
  const chunks: AsyncIterable<Buffer> = createReadStream(file, { signal: budget });

  for await (const chunk of chunks) {
    hash.update(chunk);
  }

  return hash.digest("hex");
};

const listedName = (name: string): string => {
  const escapedName = name.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");

  return escapedName === name ? name : `\\${escapedName}`;
};

const digestsOf = async (
  directory: string,
  files: readonly string[],
  budget: AbortSignal,
): Promise<string[]> => {
  const digests = Array.from<string>({ length: files.length });
  let next = 0;

  const work = async (): Promise<void> => {
    const index = next;

    next += 1;

    if (index < files.length) {
      digests[index] = await fileDigestOf(path.join(directory, files[index]), budget);
      await work();
    }
  };

  await Promise.all(Array.from({ length: HASH_WORKERS }, work));

  return digests;
};

const payloadOf = async (directory: string, budget: AbortSignal): Promise<string> => {
  const listed = await Promise.all(
    PAYLOAD_ROOTS.map(async (root) => await filesUnder(directory, root)),
  );

  const files = listed.flat().toSorted(compareBytes);
  const digests = await digestsOf(directory, files, budget);

  const lines = files.map((file, index) => `${digests[index]}  ${listedName(file)}\n`);

  return createHash("sha256").update(lines.join("")).digest("hex");
};

const listFamilies = async (
  stack: FontStack,
  fcList: string,
  scratch: string,
  budget: AbortSignal,
): Promise<{ readonly listing: string; readonly stderr: string }> => {
  const configFile = path.join(scratch, FONT_CONFIG_NAME);

  await writeAtomically(configFile, fontConfigOf(stack));

  const child = spawn(fcList, [":", "family"], {
    env: fontCheckEnvironment(stack, { configFile, home: scratch }),
    signal: budget,
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const [listing, stderr] = await Promise.all([
      text(child.stdout),
      text(child.stderr),
      once(child, "close"),
    ]);

    return { listing, stderr };
  } catch (error) {
    if (budget.aborted) {
      throw error;
    }

    return { listing: "", stderr: `fc-list could not run: ${messageOf(error)}` };
  }
};

const readStoredCheck = async (file: string): Promise<StoredCheck | undefined> => {
  let stored: unknown;

  try {
    stored = JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return undefined;
  }

  return isStoredCheck(stored) ? stored : undefined;
};

export const createFontStackCheck = (options: FontCheckOptions) => {
  const entries = new Map<string, CheckEntry>();

  const isFresh = (refusedAt: number): boolean => options.now() - refusedAt < REFUSED_CHECK_TTL_MS;

  const runCheck = async (
    stack: FontStack,
    file: string,
    budget: AbortSignal,
  ): Promise<CheckOutputs> => {
    const scratch = await createScratchDir(options.now(), options.scratchRoot);

    try {
      const payload = await payloadOf(stack.directory, budget);
      const listed = await listFamilies(stack, options.fcList, scratch.path, budget);

      const outputs = { ...listed, payload };

      await writeAtomically(
        file,
        JSON.stringify({
          checkedAt: options.now(),
          format: CHECK_FORMAT,
          outputs,
        } satisfies StoredCheck),
      );

      return outputs;
    } finally {
      await removeScratchDir(scratch);
    }
  };

  const checkStack = async (directory: string, signature: string): Promise<FontStackFacts> => {
    await ensureScratchRoot(options.root);

    const manifest = await readManifest(directory);

    const stack = {
      cacheDir: path.join(options.root, `fontcache-${signature.slice(0, 16)}`),
      directory,
      families: manifest.families.length,
      payload: manifest.payload,
      rules: await readRules(directory),
    };

    const file = path.join(options.root, `host-fonts-${signature}.json`);
    const stored = await readStoredCheck(file);
    const known = stored === undefined ? undefined : verdictOf(stored.outputs, manifest, stack);

    if (
      stored !== undefined &&
      known !== undefined &&
      (known.kind === "checked" || isFresh(stored.checkedAt))
    ) {
      return known;
    }

    const started = options.now();
    const budget = options.budgetSignal(options.budgetMs);
    const stop = AbortSignal.any([budget, options.signal]);
    let outputs: CheckOutputs;

    try {
      outputs = await runCheck(stack, file, stop);
    } catch (error) {
      if (options.signal.aborted) {
        throw new FontStackRefusalError(
          "the font stack check was stopped because its client closed",
        );
      }

      throw budget.aborted
        ? new FontStackRefusalError(
            `the font stack check did not finish within ${options.budgetMs} ms`,
            { kept: true },
          )
        : error;
    }

    const facts = verdictOf(outputs, manifest, stack);

    publishInternalEvent({
      detail: JSON.stringify({
        directory,
        families: facts.kind === "checked" ? facts.families : null,
        ms: options.now() - started,
        reason: facts.kind === "refused" ? facts.reason : null,
      }),
      event: "font-stack-checked",
    });

    return facts;
  };

  const resultOf = async (directory: string, signature: string): Promise<CheckResult> => {
    try {
      return { facts: await checkStack(directory, signature), transient: false };
    } catch (error) {
      return {
        facts: { kind: "refused", reason: messageOf(error) },
        transient: !(error instanceof FontStackRefusalError && error.kept),
      };
    }
  };

  const settle = async (directory: string): Promise<FontStackFacts> => {
    const signature = await signatureOf(directory);
    const known = entries.get(signature);

    if (known !== undefined && (known.refusedAt === undefined || isFresh(known.refusedAt))) {
      const { facts: shared } = await known.result;

      return shared;
    }

    const entry: CheckEntry = { result: resultOf(directory, signature) };

    entries.set(signature, entry);

    const { facts, transient } = await entry.result;

    if (transient && entries.get(signature) === entry) {
      entries.delete(signature);
    } else if (facts.kind === "refused") {
      entry.refusedAt ??= options.now();
    }

    return facts;
  };

  return async (directory: string): Promise<FontStackFacts> => await settle(directory);
};
