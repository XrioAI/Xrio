import path from "node:path";

import { isOwnedSwitch } from "../../src/humanizer/owned-inputs.ts";

const USER_DATA_DIR = "--user-data-dir=";

const RELAY_ADDRESS = /^(?<flag>--proxy-server=\w+:\/\/127\.0\.0\.1:)\d+$/u;

const PORT_MASK = "<port>";

const DRAWN_MASK = "<drawn>";

const SCRATCH_MASK = "<scratch>";

const scratchRootOf = (argv: readonly string[]): string => {
  const profile = argv.find((arg) => arg.startsWith(USER_DATA_DIR));

  if (profile === undefined) {
    throw new Error("The launched Chrome has no --user-data-dir in its argv.");
  }

  return path.dirname(profile.slice(USER_DATA_DIR.length));
};

const isDrawn = (arg: string): boolean => isOwnedSwitch(arg.split("=")[0] ?? arg);

export const drawnValuesOf = (argv: readonly string[]): string[] => argv.filter(isDrawn);

const comparableArg = (arg: string, scratchRoot: string): string => {
  if (isDrawn(arg)) {
    return `${arg.split("=")[0]}=${DRAWN_MASK}`;
  }

  const relay = RELAY_ADDRESS.exec(arg)?.groups?.flag;

  return relay === undefined ? arg.replaceAll(scratchRoot, SCRATCH_MASK) : `${relay}${PORT_MASK}`;
};

const comparableArgv = (argv: readonly string[]): string[] => {
  const scratchRoot = scratchRootOf(argv);

  return argv.map((arg) => comparableArg(arg, scratchRoot));
};

const differences = (expected: readonly string[], actual: readonly string[]): string[] => [
  ...expected.flatMap((arg) => (actual.includes(arg) ? [] : [`- ${arg}`])),
  ...actual.flatMap((arg) => (expected.includes(arg) ? [] : [`+ ${arg}`])),
];

export const createLaunchLedger = () => {
  let agreed: string[] | undefined;

  return {
    admit: (argv: readonly string[]): void => {
      const comparable = comparableArgv(argv);

      agreed ??= comparable;

      const changed = differences(agreed, comparable);

      if (changed.length > 0) {
        throw new Error(`Chrome argv differs between samples:\n${changed.join("\n")}`);
      }

      if (agreed.join("\n") !== comparable.join("\n")) {
        throw new Error(
          `Chrome argv has the same flags in a different order between samples:\n${comparable.join("\n")}`,
        );
      }
    },
    agreedArgv: (): string[] => {
      if (agreed === undefined) {
        throw new Error("No sample launched Chrome.");
      }

      return agreed;
    },
  };
};
