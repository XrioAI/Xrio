import { stat } from "node:fs/promises";

const USER_PRIVATE_GROUP_UMASK = 0o002;

const PERMISSION_RANGE = 0o1000;

export const underUserPrivateGroupUmask = async <Result>(
  run: () => Promise<Result>,
): Promise<Result> => {
  const previous = process.umask(USER_PRIVATE_GROUP_UMASK);

  try {
    return await run();
  } finally {
    process.umask(previous);
  }
};

export const permissionsOf = async (file: string): Promise<string> => {
  const { mode } = await stat(file);

  return (mode % PERMISSION_RANGE).toString(8);
};
