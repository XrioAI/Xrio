import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const FIXTURE_PAYLOAD = "fe735e7625f633233c23b518ecaa0d5962c1f934481b70f51e7e302e3c8de141";

export const FIXTURE_FAMILIES = [
  "Fixture Mono",
  "Fixture Sans",
  "Fixture Sans Bold",
  "Fixture Serif",
];

const FIXTURE_LISTING = "Fixture Sans,Fixture Sans Bold\nFixture Serif\nFixture Mono\n";

const FIXTURE_RULES = [
  "10-fixture.conf",
  "50-user.conf",
  "51-local.conf",
  "60-fixture.conf",
] as const;

const FIXTURE_FILES = {
  "fonts/conf.d/10-fixture.conf": "<fontconfig/>\n",
  "fonts/conf.d/50-user.conf": "<fontconfig><include>user</include></fontconfig>\n",
  "fonts/conf.d/51-local.conf": "<fontconfig><include>local.conf</include></fontconfig>\n",
  "fonts/conf.d/60-fixture.conf": "<fontconfig/>\n",
  "fonts/conf.d/README": "rules\n",
  "fonts/fonts.conf": "<fontconfig/>\n",
  "share/truetype/Fixture-Bold.ttf": "bold\n",
  "share/truetype/Fixture.ttf": "regular\n",
} as const satisfies Record<string, string>;

export interface FakeFontStack {
  readonly binary: string;
  readonly directory: string;
  readonly fcList: string;
  readonly rules: readonly string[];
}

const quoted = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;

const fcListScript = (control: string): string =>
  [
    "#!/bin/sh",
    `CONTROL=${quoted(control)}`,
    'echo "$FONTCONFIG_FILE|$FONTCONFIG_PATH|$HOME|$*" >> "$CONTROL/runs"',
    '/bin/cat "$FONTCONFIG_FILE" > "$CONTROL/config-seen"',
    '[ -e "$CONTROL/scan-writes" ] && while read -r FILE; do echo scanned > "$FILE"; done < "$CONTROL/scan-writes"',
    '[ -e "$CONTROL/hang" ] && exec /bin/sleep "$(/bin/cat "$CONTROL/hang")"',
    '/bin/cat "$CONTROL/stderr" >&2',
    '/bin/cat "$CONTROL/listing"',
    "",
  ].join("\n");

export const fakeFontStack = async (
  root: string,
  { payload = FIXTURE_PAYLOAD }: { readonly payload?: string } = {},
): Promise<FakeFontStack> => {
  const directory = path.join(root, "package", "fontstack");
  const control = path.join(root, "control");

  await mkdir(control, { recursive: true });

  await Promise.all(
    Object.entries(FIXTURE_FILES).map(async ([name, contents]) => {
      await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
      await writeFile(path.join(directory, name), contents);
    }),
  );

  await writeFile(
    path.join(directory, "stack.json"),
    JSON.stringify({ families: FIXTURE_FAMILIES, name: "fixture", payload }),
  );
  await writeFile(path.join(control, "listing"), FIXTURE_LISTING);
  await writeFile(path.join(control, "stderr"), "");
  await writeFile(path.join(root, "package", "chrome"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(root, "package", "chrome"), 0o755);

  const fcList = path.join(control, "fc-list");

  await writeFile(fcList, fcListScript(control));
  await chmod(fcList, 0o755);

  return { binary: path.join(root, "package", "chrome"), directory, fcList, rules: FIXTURE_RULES };
};

export const fcListRuns = async (stack: FakeFontStack): Promise<string[]> => {
  try {
    const log = await readFile(path.join(path.dirname(stack.fcList), "runs"), "utf-8");

    return log.split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

export const configSeenByFcList = async (stack: FakeFontStack): Promise<string> =>
  await readFile(path.join(path.dirname(stack.fcList), "config-seen"), "utf-8");

export const hangFcListFor = async (
  stack: FakeFontStack,
  seconds: number | null,
): Promise<void> => {
  const hang = path.join(path.dirname(stack.fcList), "hang");

  await (seconds === null ? rm(hang, { force: true }) : writeFile(hang, String(seconds)));
};

export const writeDuringScan = async (
  stack: FakeFontStack,
  files: readonly string[],
): Promise<void> => {
  await writeFile(
    path.join(path.dirname(stack.fcList), "scan-writes"),
    files.map((file) => `${path.join(stack.directory, file)}\n`).join(""),
  );
};

export const setFcListOutput = async (
  stack: FakeFontStack,
  { listing, stderr }: { readonly listing?: string; readonly stderr?: string },
): Promise<void> => {
  const control = path.dirname(stack.fcList);

  if (listing !== undefined) {
    await writeFile(path.join(control, "listing"), listing);
  }

  if (stderr !== undefined) {
    await writeFile(path.join(control, "stderr"), stderr);
  }
};
