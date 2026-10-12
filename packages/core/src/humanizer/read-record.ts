/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- This module parses the persisted JSON boundary into DeviceRecord. */
import { invalidOptions, sessionUnavailable } from "../errors.ts";
import { parseBrowserArgs } from "../sources/browser/launch-plan.ts";
import type {
  DeviceRecord,
  GpuChoice,
  HostCapabilities,
  PresentedDevice,
  TimezonePolicy,
  WindowState,
} from "./contracts.ts";
import { DeviceRecordRefusedError, refuseUnreplayable } from "./contracts.ts";

const refused = (cause?: unknown): never => {
  throw sessionUnavailable("record-refused", "The stored device record cannot be read.", cause);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!isObject(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    return refused();
  }

  return value;
};

const string = (value: unknown): string => (typeof value === "string" ? value : refused());

const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : refused();

const windowOf = (value: unknown): WindowState => {
  const row = object(value, ["kind", "width", "height", "x", "y"]);

  if (row.kind === "chrome-default" || row.kind === "maximized") {
    object(row, ["kind"]);

    return { kind: row.kind };
  }

  if (row.kind !== "floating") {
    return refused();
  }

  return {
    height: number(row.height),
    kind: "floating",
    width: number(row.width),
    x: number(row.x),
    y: number(row.y),
  };
};

const gpuOf = (value: unknown): GpuChoice => {
  const row = object(value, ["backend", "persona", "policy"]);

  if (row.backend !== "native" && row.backend !== "swiftshader") {
    return refused();
  }

  if (row.persona === null) {
    object(row, ["backend", "persona"]);

    return row.backend === "native"
      ? { backend: "native", persona: null }
      : { backend: "swiftshader", persona: null };
  }

  const persona = object(row.persona, ["kind", "name"]);
  const name = string(persona.name);

  if (persona.kind === "hide-only" && row.backend === "swiftshader" && row.policy === undefined) {
    return { backend: "swiftshader", persona: { kind: "hide-only", name } };
  }

  if (persona.kind !== "hardware") {
    return refused();
  }

  if (row.backend === "native" && row.policy === undefined) {
    return { backend: "native", persona: { kind: "hardware", name } };
  }

  if (row.backend === "swiftshader" && row.policy === "announce") {
    return { backend: "swiftshader", persona: { kind: "hardware", name }, policy: "announce" };
  }

  return refused();
};

const timezoneOf = (value: unknown): TimezonePolicy => {
  const row = object(value, ["kind", "zone"]);

  if (row.kind !== "host" && row.kind !== "pinned" && row.kind !== "exit") {
    return refused();
  }

  return { kind: row.kind, zone: string(row.zone) };
};

const fontsOf = (value: unknown): PresentedDevice["fonts"] => {
  const row = object(value, ["kind", "digest"]);

  if (row.kind === "system") {
    object(row, ["kind"]);

    return { kind: "system" };
  }

  if (row.kind === "stack") {
    return { digest: string(row.digest), kind: "stack" };
  }

  return refused();
};

const voicesOf = (value: unknown): PresentedDevice["voices"] => {
  const row = object(value, ["kind", "name"]);

  if (row.kind === "system") {
    object(row, ["kind"]);

    return { kind: "system" };
  }

  if (row.kind === "persona") {
    return { kind: "persona", name: string(row.name) };
  }

  return refused();
};

const recordFields = (stored: string): Record<string, unknown> => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stored);
  } catch (error) {
    return refused(error);
  }

  return object(parsed, ["schema", "seed", "device", "policy"]);
};

const replayable = (record: DeviceRecord): DeviceRecord => {
  try {
    return refuseUnreplayable(record);
  } catch (error) {
    if (!(error instanceof DeviceRecordRefusedError)) {
      throw error;
    }

    const { field, reason } = error.refusal;

    throw sessionUnavailable(
      "record-refused",
      `The stored device record cannot replay its ${field}: ${reason}.`,
      error,
    );
  }
};

const readDeviceRecord = (stored: string): DeviceRecord => {
  const row = recordFields(stored);

  if (row.schema !== 1) {
    return refused();
  }

  const seed = string(row.seed);

  if (!/^[0-9a-f]{16}$/u.test(seed)) {
    return refused();
  }

  const device = object(row.device, [
    "screen",
    "window",
    "cores",
    "memoryGb",
    "gpu",
    "fonts",
    "voices",
  ]);

  const screen = object(device.screen, ["width", "height", "workArea"]);
  const area = object(screen.workArea, ["top", "right", "bottom", "left"]);
  const policy = object(row.policy, ["locale", "timezone"]);

  return replayable({
    device: {
      cores: number(device.cores),
      fonts: fontsOf(device.fonts),
      gpu: gpuOf(device.gpu),
      memoryGb: number(device.memoryGb),
      screen: {
        height: number(screen.height),
        width: number(screen.width),
        workArea: {
          bottom: number(area.bottom),
          left: number(area.left),
          right: number(area.right),
          top: number(area.top),
        },
      },
      voices: voicesOf(device.voices),
      window: windowOf(device.window),
    },
    policy: { locale: string(policy.locale), timezone: timezoneOf(policy.timezone) },
    schema: 1,
    seed,
  });
};

const canPresent = (record: DeviceRecord, capabilities: HostCapabilities): boolean => {
  const { persona } = record.device.gpu;

  return (
    persona === null ||
    capabilities.fork?.personas.gl.some(
      (available) => available.name === persona.name && available.kind === persona.kind,
    ) === true
  );
};

interface StoredDevice {
  readonly record: string;
  readonly platform: string | undefined;
  readonly browserArgs: readonly string[] | undefined;
}

interface PresentingScrape {
  readonly mode: "headless" | "headed";
  readonly capabilities: HostCapabilities;
  readonly browserArgs: readonly string[];
}

const recordedMode = ({ device }: DeviceRecord): PresentingScrape["mode"] =>
  device.window.kind === "chrome-default" ? "headed" : "headless";

const keepsBrowserArgs = (stored: readonly string[], resolved: readonly string[]): boolean =>
  resolved.length === 0 ||
  (resolved.length === stored.length && resolved.every((arg, index) => arg === stored[index]));

const replayableBrowserArgs = (stored: readonly string[] | undefined): void => {
  if (stored === undefined) {
    return;
  }

  try {
    parseBrowserArgs(stored, "The stored browserArgs");
  } catch (error) {
    throw sessionUnavailable(
      "record-refused",
      "The session's stored browserArgs cannot be replayed.",
      error,
    );
  }
};

export const presentableRecord = (stored: StoredDevice, scrape: PresentingScrape): DeviceRecord => {
  const record = readDeviceRecord(stored.record);

  replayableBrowserArgs(stored.browserArgs);

  if (recordedMode(record) !== scrape.mode) {
    throw invalidOptions("The session's device record fixes its mode.");
  }

  if (
    stored.browserArgs !== undefined &&
    !keepsBrowserArgs(stored.browserArgs, scrape.browserArgs)
  ) {
    throw invalidOptions(
      `The session's device record fixes its browserArgs to ${JSON.stringify(stored.browserArgs)}.`,
    );
  }

  if (
    stored.platform !== scrape.capabilities.platform ||
    !canPresent(record, scrape.capabilities)
  ) {
    throw sessionUnavailable("cannot-present", "This host cannot present the session's device.");
  }

  return record;
};
