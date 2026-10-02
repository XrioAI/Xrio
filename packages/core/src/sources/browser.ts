import { XrioError } from "../errors.ts";

const notImplemented = (mode: string): XrioError<"MODE_NOT_IMPLEMENTED"> =>
  new XrioError("MODE_NOT_IMPLEMENTED", `The ${mode} mode is not implemented.`, {
    details: undefined,
  });

export const loadHeadedDocument = (): never => {
  throw notImplemented("headed");
};

export const loadHeadlessDocument = (): never => {
  throw notImplemented("headless");
};
