import type {
  GlPersona,
  GlPersonaKind,
  KnobRegistry,
  RefusedGlArtifact,
} from "../../humanizer/contracts.ts";
import { GL_PERSONA_MAX_NAME, isGlPersonaName } from "../../humanizer/owned-inputs.ts";

export const GL_ARTIFACT_SCHEMA = "xrio-gl-table/v2";

export type GlArtifactReading =
  | { readonly persona: GlPersona }
  | { readonly refused: RefusedGlArtifact };

export interface GlArtifactLimits {
  readonly maxBytes: number;
  readonly maxNameLength: number;
}

const GL_TABLE_MAX_BYTES = 262_144;

const POSITIVE_INTEGER = /^[1-9]\d*$/u;

const INT_MIN = -2_147_483_648;

const INT_MAX = 2_147_483_647;

const MAX_COMPONENTS = 4;

const DIGEST = /^sha256:[\da-f]{64}$/u;

const SWIFTSHADER_MARKER = "swiftshader";

interface NumericList {
  readonly field: "ints" | "floats" | "float_arrays" | "int_arrays";
  readonly integral: boolean;
  readonly array: boolean;
}

const NUMERIC_LISTS: readonly NumericList[] = [
  { array: false, field: "ints", integral: true },
  { array: false, field: "floats", integral: false },
  { array: true, field: "float_arrays", integral: false },
  { array: true, field: "int_arrays", integral: true },
];

interface GlBody {
  readonly schema?: unknown;
  readonly name?: unknown;
  readonly digest?: unknown;
  readonly chrome_version?: unknown;
  readonly vendor?: unknown;
  readonly renderer?: unknown;
  readonly form_factor?: unknown;
  readonly max_threads?: unknown;
  readonly hidden_extensions?: unknown;
  readonly not_added?: unknown;
  readonly ints?: unknown;
  readonly floats?: unknown;
  readonly float_arrays?: unknown;
  readonly int_arrays?: unknown;
}

type Envelope = Omit<GlPersona, "hiddenExtensions" | "kind" | "name">;

type EnvelopeReading = { readonly envelope: Envelope } | { readonly reason: string };

const isRecord = (value: unknown): value is GlBody =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string";

const isFilledText = (value: unknown): value is string => isText(value) && value !== "";

const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isText);

const isEmptyList = (value: unknown): value is readonly [] =>
  Array.isArray(value) && value.length === 0;

const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= INT_MIN && value <= INT_MAX;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isFormFactor = (value: unknown): value is GlPersona["formFactor"] =>
  value === "laptop" || value === "desktop";

const isThreadCount = (value: unknown): value is number => isInt(value) && value >= 1;

const isPname = (value: unknown): value is number => isInt(value) && value >= 0;

const isList = (value: unknown): value is unknown[] => Array.isArray(value);

const isComponentList = (value: unknown): value is unknown[] =>
  Array.isArray(value) && value.length > 0 && value.length <= MAX_COMPONENTS;

const isNumericEntry = (
  { array, integral }: NumericList,
  entry: unknown,
): entry is [number, unknown] => {
  if (!isList(entry) || entry.length !== 2 || !isPname(entry[0])) {
    return false;
  }

  const isScalar = integral ? isInt : isFiniteNumber;
  const [, value] = entry;

  return array ? isComponentList(value) && value.every(isScalar) : isScalar(value);
};

const numericListDefect = (body: GlBody, list: NumericList): string | undefined => {
  const entries = body[list.field];

  if (!isList(entries)) {
    return `has no ${list.field} list`;
  }

  const pairs = entries.filter((entry) => isNumericEntry(list, entry));

  if (pairs.length !== entries.length) {
    return `has a malformed ${list.field} entry`;
  }

  const pnames = new Set(pairs.map(([pname]) => pname));

  return pnames.size === pairs.length ? undefined : `repeats a pname in ${list.field}`;
};

const namesSwiftShader = (renderer: string): boolean =>
  renderer.replaceAll(" ", "").toLowerCase().includes(SWIFTSHADER_MARKER);

const removesExtensionsOnly = (body: GlBody, renderer: string): boolean =>
  namesSwiftShader(renderer) &&
  NUMERIC_LISTS.every(({ field }) => isEmptyList(body[field])) &&
  isEmptyList(body.not_added) &&
  Array.isArray(body.hidden_extensions) &&
  body.hidden_extensions.length > 0;

const glKindOf = (body: GlBody, renderer: string): GlPersonaKind =>
  removesExtensionsOnly(body, renderer) ? "hide-only" : "hardware";

const envelopeOf = (body: GlBody, stem: string, maxNameLength: number): EnvelopeReading => {
  if (body.schema !== GL_ARTIFACT_SCHEMA) {
    return { reason: `has schema ${JSON.stringify(body.schema)}, not ${GL_ARTIFACT_SCHEMA}` };
  }

  if (body.name !== stem) {
    return { reason: `is named ${JSON.stringify(body.name)}, not its file stem ${stem}` };
  }

  if (!isGlPersonaName(stem, maxNameLength)) {
    return { reason: "has a name the fork cannot select" };
  }

  if (!isText(body.digest) || !DIGEST.test(body.digest)) {
    return { reason: "lacks a sha256 digest" };
  }

  if (
    !isFilledText(body.chrome_version) ||
    !isFilledText(body.vendor) ||
    !isFilledText(body.renderer)
  ) {
    return { reason: "lacks a non-empty chrome_version, vendor or renderer" };
  }

  if (!isFormFactor(body.form_factor)) {
    return { reason: "has a form_factor that is not laptop or desktop" };
  }

  if (!isThreadCount(body.max_threads)) {
    return { reason: "has a max_threads that is not an integer of at least 1" };
  }

  return {
    envelope: {
      chromeVersion: body.chrome_version,
      digest: body.digest,
      formFactor: body.form_factor,
      maxThreads: body.max_threads,
      renderer: body.renderer,
      vendor: body.vendor,
    },
  };
};

const refused = (stem: string, reason: string): GlArtifactReading => ({
  refused: { reason, stem },
});

const readingOf = (body: GlBody, stem: string, maxNameLength: number): GlArtifactReading => {
  const reading = envelopeOf(body, stem, maxNameLength);

  if ("reason" in reading) {
    return refused(stem, reading.reason);
  }

  const { envelope } = reading;

  const listDefect = NUMERIC_LISTS.map((list) => numericListDefect(body, list)).find(
    (defect) => defect !== undefined,
  );

  if (listDefect !== undefined) {
    return refused(stem, listDefect);
  }

  if (!isTextList(body.hidden_extensions)) {
    return refused(stem, "has hidden_extensions that is not an array of strings");
  }

  return {
    persona: {
      ...envelope,
      hiddenExtensions: body.hidden_extensions,
      kind: glKindOf(body, envelope.renderer),
      name: stem,
    },
  };
};

const knobLimitOf = (knobs: KnobRegistry, knob: string, unset: number): number => {
  const value = knobs[knob]?.value ?? "";

  return POSITIVE_INTEGER.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : unset;
};

export const glArtifactLimitsOf = (knobs: KnobRegistry): GlArtifactLimits => ({
  maxBytes: knobLimitOf(knobs, "gl-table-max-bytes", GL_TABLE_MAX_BYTES),
  maxNameLength: knobLimitOf(knobs, "gl-persona-max-name", GL_PERSONA_MAX_NAME),
});

export const parseGlArtifact = (
  stem: string,
  contents: string,
  maxNameLength: number,
): GlArtifactReading => {
  let body: unknown;

  try {
    body = JSON.parse(contents);
  } catch {
    return refused(stem, "is not JSON");
  }

  return isRecord(body)
    ? readingOf(body, stem, maxNameLength)
    : refused(stem, "is not a JSON object");
};
