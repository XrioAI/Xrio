import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { publishInternalEvent } from "../../diagnostics.ts";
import type { HostRenderer } from "../../humanizer/contracts.ts";
import { NATIVE_GL_SWITCHES } from "../../humanizer/owned-inputs.ts";
import { writeAtomically } from "./browser-process.ts";
import { fileIdentityOf } from "./file-identity.ts";

const RENDERER_MARKER = "xrio-gl";

const RENDERER_PAYLOAD = /xrio-gl (?<payload>[^\s"<]+)/u;

const RENDERER_PAGE_SCRIPT = `
const gl = document.createElement("canvas").getContext("webgl");
const debug = gl && gl.getExtension("WEBGL_debug_renderer_info");
const strings = debug ? {
  vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),
  renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
} : null;
document.body.textContent = "${RENDERER_MARKER} " + encodeURIComponent(JSON.stringify(strings));
`;

const RENDERER_PAGE_URL = `data:text/html,${encodeURIComponent(
  `<body><script>${RENDERER_PAGE_SCRIPT}</script>`,
)}`;

const NATIVE_GL_ARGS = NATIVE_GL_SWITCHES.map(({ name, value }) => `${name}=${value}`);

const READ_ARGS = [...NATIVE_GL_ARGS, "--dump-dom", RENDERER_PAGE_URL];

const RENDERER_FORMAT = 1;

const LEARNED_TTL_MS = 24 * 60 * 60 * 1000;

const FAILED_TTL_MS = 60_000;

const PCI_ID_FILES = ["vendor", "device"] as const;

type StoredRenderer =
  | {
      readonly format: typeof RENDERER_FORMAT;
      readonly kind: "learned";
      readonly learnedAt: number;
      readonly vendor: string;
      readonly renderer: string;
    }
  | {
      readonly format: typeof RENDERER_FORMAT;
      readonly kind: "failed";
      readonly failedAt: number;
      readonly reason: string;
    };

type RendererReading = { readonly renderer: HostRenderer } | { readonly reason: string };

interface Learned {
  readonly renderer: HostRenderer | undefined;
  readonly expiresAt: number;
}

interface RendererEntry {
  readonly learned: Promise<Learned>;
  expiresAt?: number;
}

export interface HostRendererOptions {
  readonly drmDirectory: string;
  readonly now: () => number;
  readonly root: string;
  readonly signal: AbortSignal;
  readonly runHeadless: (binary: string, args: readonly string[]) => Promise<string>;
}

export type HostRendererReader = (
  binary: string,
  renderNodes: readonly string[],
) => Promise<HostRenderer | undefined>;

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string";

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isHostRenderer = (value: unknown): value is HostRenderer =>
  isObject(value) &&
  "vendor" in value &&
  isText(value.vendor) &&
  "renderer" in value &&
  isText(value.renderer);

const isStoredRenderer = (value: unknown): value is StoredRenderer => {
  if (!isObject(value) || !("format" in value) || value.format !== RENDERER_FORMAT) {
    return false;
  }

  const isLearned =
    "kind" in value &&
    value.kind === "learned" &&
    "learnedAt" in value &&
    isTime(value.learnedAt) &&
    isHostRenderer(value);

  const isFailed =
    "kind" in value &&
    value.kind === "failed" &&
    "failedAt" in value &&
    isTime(value.failedAt) &&
    "reason" in value &&
    isText(value.reason);

  return isLearned || isFailed;
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const rendererIn = (stdout: string): RendererReading => {
  const payload = RENDERER_PAYLOAD.exec(stdout)?.groups?.payload;

  if (payload === undefined) {
    return { reason: "the page printed no WebGL payload" };
  }

  let strings: unknown;

  try {
    strings = JSON.parse(decodeURIComponent(payload));
  } catch {
    return { reason: "the WebGL payload is malformed" };
  }

  return isHostRenderer(strings)
    ? { renderer: { renderer: strings.renderer, vendor: strings.vendor } }
    : { reason: "the page reported no WebGL renderer" };
};

const pciIdOf = async (drmDirectory: string, node: string, file: string) => {
  try {
    const id = await readFile(path.join(drmDirectory, node, "device", file), "utf-8");

    return id.trim();
  } catch {
    return null;
  }
};

const renderNodeIdentitiesOf = async (drmDirectory: string, renderNodes: readonly string[]) =>
  await Promise.all(
    renderNodes
      .toSorted()
      .map(async (node) => [
        node,
        ...(await Promise.all(
          PCI_ID_FILES.map(async (file) => await pciIdOf(drmDirectory, node, file)),
        )),
      ]),
  );

const rendererKeyOf = async (
  drmDirectory: string,
  binary: string,
  renderNodes: readonly string[],
): Promise<string> => {
  const [identity, nodes] = await Promise.all([
    fileIdentityOf(binary),
    renderNodeIdentitiesOf(drmDirectory, renderNodes),
  ]);

  return createHash("sha256")
    .update(JSON.stringify([identity, nodes, NATIVE_GL_ARGS]))
    .digest("hex");
};

const readStoredRenderer = async (file: string): Promise<StoredRenderer | undefined> => {
  let stored: unknown;

  try {
    stored = JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return undefined;
  }

  return isStoredRenderer(stored) ? stored : undefined;
};

const storeRenderer = async (file: string, stored: StoredRenderer): Promise<boolean> => {
  try {
    await writeAtomically(file, JSON.stringify(stored));

    return true;
  } catch {
    return false;
  }
};

const eventDetailOf = (
  binary: string,
  renderNodes: readonly string[],
  reading: RendererReading,
): string =>
  JSON.stringify(
    "renderer" in reading
      ? { binary, renderNodes, ...reading.renderer }
      : { binary, reason: reading.reason, renderNodes, renderer: null, vendor: null },
  );

export const createHostRendererReader = (options: HostRendererOptions): HostRendererReader => {
  const entries = new Map<string, RendererEntry>();

  const isFresh = (at: number, ttlMs: number): boolean => options.now() - at < ttlMs;

  const learnedOf = (stored: StoredRenderer | undefined): Learned | undefined =>
    stored?.kind === "learned" && isFresh(stored.learnedAt, LEARNED_TTL_MS)
      ? {
          expiresAt: stored.learnedAt + LEARNED_TTL_MS,
          renderer: { renderer: stored.renderer, vendor: stored.vendor },
        }
      : undefined;

  const failedOf = (stored: StoredRenderer | undefined): Learned | undefined =>
    stored?.kind === "failed" && isFresh(stored.failedAt, FAILED_TTL_MS)
      ? { expiresAt: stored.failedAt + FAILED_TTL_MS, renderer: undefined }
      : undefined;

  const readRenderer = async (binary: string): Promise<RendererReading> => {
    try {
      return rendererIn(await options.runHeadless(binary, READ_ARGS));
    } catch (error) {
      return { reason: messageOf(error) };
    }
  };

  const keepFailure = async (file: string, reason: string): Promise<Learned> => {
    const current = learnedOf(await readStoredRenderer(file));

    if (current !== undefined) {
      return current;
    }

    const failedAt = options.now();

    if (!options.signal.aborted) {
      await storeRenderer(file, { failedAt, format: RENDERER_FORMAT, kind: "failed", reason });
    }

    return { expiresAt: failedAt + FAILED_TTL_MS, renderer: undefined };
  };

  const learn = async (
    binary: string,
    renderNodes: readonly string[],
    file: string,
  ): Promise<Learned> => {
    const stored = await readStoredRenderer(file);
    const known = learnedOf(stored) ?? failedOf(stored);

    if (known !== undefined) {
      return known;
    }

    const reading = await readRenderer(binary);

    publishInternalEvent({
      detail: eventDetailOf(binary, renderNodes, reading),
      event: "host-renderer-probed",
    });

    if ("reason" in reading) {
      return await keepFailure(file, reading.reason);
    }

    const { renderer, vendor } = reading.renderer;
    const learnedAt = options.now();

    await storeRenderer(file, {
      format: RENDERER_FORMAT,
      kind: "learned",
      learnedAt,
      renderer,
      vendor,
    });

    return { expiresAt: learnedAt + LEARNED_TTL_MS, renderer: reading.renderer };
  };

  return async (binary, renderNodes) => {
    const key = await rendererKeyOf(options.drmDirectory, binary, renderNodes);
    const known = entries.get(key);

    if (known !== undefined && (known.expiresAt === undefined || options.now() < known.expiresAt)) {
      const { renderer } = await known.learned;

      return renderer;
    }

    const file = path.join(options.root, `host-renderer-${key}.json`);
    const entry: RendererEntry = { learned: learn(binary, renderNodes, file) };

    entries.set(key, entry);

    const { expiresAt, renderer } = await entry.learned;

    entry.expiresAt = expiresAt;

    return renderer;
  };
};
