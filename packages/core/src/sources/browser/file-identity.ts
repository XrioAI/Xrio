import { stat } from "node:fs/promises";

type FileIdentity = readonly (string | number | null)[];

export const fileIdentityOf = async (file: string): Promise<FileIdentity> => {
  try {
    const { ctimeMs, dev, ino, mode, mtimeMs, size } = await stat(file);

    return [file, dev, ino, mode, size, mtimeMs, ctimeMs];
  } catch {
    return [file, null];
  }
};
