import { existsSync } from "node:fs";

const STANDARD_PATHS = new Map<string, string>([
  ["darwin", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  ["linux", "/usr/bin/google-chrome"],
]);

export const chromePath = (): string => {
  const executable = process.env.XRIO_CHROME_PATH ?? STANDARD_PATHS.get(process.platform);

  if (executable === undefined || !existsSync(executable)) {
    throw new Error(
      `Chrome was not found at ${executable ?? "a standard path"}; set XRIO_CHROME_PATH to run the browser tests.`,
    );
  }

  return executable;
};
