import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_CHROME = fileURLToPath(new URL("fake-chrome.ts", import.meta.url));

const FIXTURES = fileURLToPath(new URL("../sources/browser/fixtures/", import.meta.url));

const CHECKOUT = createHash("sha256").update(FAKE_CHROME).digest("hex").slice(0, 16);

const KIT_ARTIFACTS = [
  "synthetic-gpu.xrio-gl.json",
  "synthetic-gpu.xrio-media.json",
  "synthetic-swiftshader-hidden.xrio-gl.json",
  "synthetic-voices-154.xrio-speech.json",
] as const;

const TRUNCATED_ROWS = 40;

export const FAKE_FORK_VERSION = "154.0.8037.57";

type TrapScenario = "stock-trap" | "pristine-trap" | "pxr-trap";

export type FakeForkScenario =
  | "kit"
  | "kit-unconfigured"
  | "broken-dump"
  | "truncated-dump"
  | TrapScenario;

interface FakePackage {
  readonly markers: { readonly versions: boolean; readonly config: boolean };
  readonly artifacts: readonly string[];
  readonly dump: (kitDump: string) => string;
}

const BARE_SPEECH_ROW = "[def] speech-persona = <unset>";

const TRAPS: Readonly<Record<TrapScenario, Readonly<Record<string, string>>>> = {
  "pristine-trap": { "MANIFEST.txt": "synthetic pristine Chromium 154.0.8037.57\n" },
  "pxr-trap": {
    "MANIFEST.txt": "synthetic pxr package 154.0.8037.57\n",
    VERSIONS: `CHROMIUM_VERSION=${FAKE_FORK_VERSION}\n`,
    "pxr-config.json": `${JSON.stringify({ "speech-persona": "synthetic-voices-154" })}\n`,
  },
  "stock-trap": {},
};

const isTrap = (scenario: FakeForkScenario): scenario is TrapScenario => scenario in TRAPS;

const PACKAGES: Readonly<Record<Exclude<FakeForkScenario, TrapScenario>, FakePackage>> = {
  "broken-dump": {
    artifacts: [],
    dump: () => "xrio-knobs: some knobs\nnot a knob row\n",
    markers: { config: false, versions: true },
  },
  kit: {
    artifacts: KIT_ARTIFACTS,
    dump: (kitDump) => kitDump,
    markers: { config: true, versions: true },
  },
  "kit-unconfigured": {
    artifacts: [],
    dump: (kitDump) =>
      kitDump
        .replace(/^\[set\] speech-persona = .*$/mu, BARE_SPEECH_ROW)
        .replace(/^\[set\] config-file = .*$/mu, "[def] config-file = <unset>"),
    markers: { config: false, versions: true },
  },
  "truncated-dump": {
    artifacts: [],
    dump: (kitDump) => `${kitDump.split("\n").slice(0, TRUNCATED_ROWS).join("\n")}\n`,
    markers: { config: false, versions: true },
  },
};

const quoted = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;

const forkScript = (directory: string, overrides: { readonly version?: string }): string =>
  [
    "#!/bin/sh",
    `HANG=${quoted(path.join(directory, "hang"))}`,
    `DUMPS=${quoted(path.join(directory, "dumps"))}`,
    'case "$1" in',
    `  --xrio-dump-config) echo dump >> "$DUMPS"; [ -e "$HANG" ] && /bin/sleep "$(/bin/cat "$HANG")"; exec /bin/cat ${quoted(path.join(directory, "dump.txt"))} ;;`,
    `  --version) echo ${quoted(`Chromium ${overrides.version ?? FAKE_FORK_VERSION}`)}; exit 0 ;;`,
    "esac",
    `exec /usr/bin/env XRIO_FAKE_SCENARIO=fork ${quoted(process.execPath)} ${quoted(FAKE_CHROME)} "$@"`,
    "",
  ].join("\n");

const trapScript = (directory: string): string =>
  ["#!/bin/sh", `/usr/bin/touch ${quoted(path.join(directory, "executed"))}`, "exit 1", ""].join(
    "\n",
  );

const writeExecutable = async (file: string, contents: string): Promise<void> => {
  await writeFile(file, contents);
  await chmod(file, 0o755);
};

const writeTrap = async (directory: string, scenario: TrapScenario): Promise<void> => {
  const files = Object.entries(TRAPS[scenario]);

  if (files.length > 0) {
    await mkdir(path.join(directory, "personas"));
  }

  await Promise.all(
    files.map(async ([name, contents]) => {
      await writeFile(path.join(directory, name), contents);
    }),
  );
  await writeExecutable(path.join(directory, "chrome"), trapScript(directory));
};

interface ForkOverrides {
  readonly version?: string;
  readonly versionsLines?: string;
}

const writePackage = async (directory: string, fake: FakePackage, overrides: ForkOverrides) => {
  const kitDump = await readFile(path.join(FIXTURES, "kit-dump.txt"), "utf-8");

  await mkdir(path.join(directory, "personas"), { recursive: true });
  await writeFile(path.join(directory, "dump.txt"), fake.dump(kitDump));

  if (fake.markers.versions) {
    await writeFile(
      path.join(directory, "VERSIONS"),
      `CHROMIUM_VERSION=${FAKE_FORK_VERSION}\nFORK_VERSION=1.1\n${overrides.versionsLines ?? ""}`,
    );
  }

  if (fake.markers.config) {
    await writeFile(
      path.join(directory, "xrio-config.json"),
      `${JSON.stringify({ "speech-persona": "synthetic-voices-154" })}\n`,
    );
  }

  await Promise.all(
    fake.artifacts.map(async (artifact) => {
      await copyFile(path.join(FIXTURES, artifact), path.join(directory, "personas", artifact));
    }),
  );
  await writeExecutable(path.join(directory, "chrome"), forkScript(directory, overrides));
};

const variantOf = ({ version, versionsLines }: ForkOverrides): string =>
  [
    version,
    versionsLines === undefined
      ? undefined
      : createHash("sha256").update(versionsLines).digest("hex").slice(0, 8),
  ]
    .filter((part) => part !== undefined)
    .join("-");

export const fakeForkPath = async (
  scenario: FakeForkScenario,
  { root = tmpdir(), ...overrides }: { readonly root?: string } & ForkOverrides = {},
): Promise<string> => {
  const variant = variantOf(overrides);
  const name = variant === "" ? scenario : `${scenario}-${variant}`;
  const directory = path.join(root, `xrio-fake-fork-${process.getuid?.() ?? 0}-${CHECKOUT}`, name);

  await rm(directory, { force: true, recursive: true });
  await mkdir(directory, { mode: 0o700, recursive: true });

  await (isTrap(scenario)
    ? writeTrap(directory, scenario)
    : writePackage(directory, PACKAGES[scenario], overrides));

  return path.join(directory, "chrome");
};

export const trapExecuted = (executable: string): string =>
  path.join(path.dirname(executable), "executed");

export const hangDumpFor = async (executable: string, seconds: number): Promise<void> => {
  await writeFile(path.join(path.dirname(executable), "hang"), String(seconds));
};

export const stopHanging = async (executable: string): Promise<void> => {
  await rm(path.join(path.dirname(executable), "hang"), { force: true });
};

export const dumpsRun = async (executable: string): Promise<number> => {
  try {
    const log = await readFile(path.join(path.dirname(executable), "dumps"), "utf-8");

    return log.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

export const replaceDump = async (executable: string, dump: string): Promise<void> => {
  await writeFile(path.join(path.dirname(executable), "dump.txt"), dump);
};
