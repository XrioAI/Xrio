import type {
  GlPersona,
  GlPersonaKind,
  GpuChoice,
  HostCapabilities,
  HostRenderer,
} from "./contracts.ts";
import { MACHINE_CLASSES } from "./owned-inputs.ts";

export interface EligiblePersona {
  readonly persona: GlPersona;
  readonly gpu: GpuChoice;
}

export interface GlLineup {
  readonly drawable: readonly EligiblePersona[];
  readonly pinnable: readonly EligiblePersona[];
  readonly skewed: boolean;
}

type Verdict =
  | ({ readonly kind: "eligible" } & EligiblePersona)
  | { readonly kind: "skewed"; readonly persona: GlPersona; readonly reason: string }
  | { readonly kind: "ineligible"; readonly persona: GlPersona; readonly reason: string };

interface Launch {
  readonly backend: GpuChoice["backend"];
  readonly version: string;
  readonly hostRenderer: HostRenderer | undefined;
}

const HARDWARE_OVER_SWIFTSHADER =
  "it is a hardware persona, and the matched policy presents one only on a GPU whose own renderer equals it, never over SwiftShader";

const HIDE_ONLY_ON_NATIVE = "it claims SwiftShader, and this launch renders on the host GPU";

const UNKNOWN_HOST_RENDERER = "this host's own renderer is unknown";

const FEWEST_CLASS_CORES = Math.min(...MACHINE_CLASSES.map(({ cores }) => cores));

const ANGLE_OPENING = "ANGLE (";

const ANGLE_CLOSING = ")";

const DRIVER_VERSION_SUFFIX = /-\d[\d.]*$/u;

const RENDERER_STRUCTURE = /[(),]/gu;

const DEPTH_STEPS: ReadonlyMap<string, number> = new Map([
  ["(", 1],
  [")", -1],
]);

interface RendererHalves {
  readonly adapter: string;
  readonly driver: string;
}

const lastTopLevelComma = (inner: string): number | undefined => {
  let depth = 0;
  let cut: number | undefined;

  for (const { 0: character, index } of inner.matchAll(RENDERER_STRUCTURE)) {
    depth += DEPTH_STEPS.get(character) ?? 0;

    if (depth < 0) {
      return undefined;
    }

    if (character === "," && depth === 0) {
      cut = index;
    }
  }

  return depth === 0 ? cut : undefined;
};

const halvesOf = (renderer: string): RendererHalves | undefined => {
  const text = renderer.trim();

  if (!text.startsWith(ANGLE_OPENING) || !text.endsWith(ANGLE_CLOSING)) {
    return undefined;
  }

  const inner = text.slice(ANGLE_OPENING.length, -ANGLE_CLOSING.length);
  const cut = lastTopLevelComma(inner);

  return cut === undefined
    ? undefined
    : { adapter: inner.slice(0, cut).trim(), driver: inner.slice(cut + 1).trim() };
};

const withoutDriverVersion = (driver: string): string =>
  driver.replace(DRIVER_VERSION_SUFFIX, "").trim();

const sameAdapter = (real: string, reference: string): boolean => {
  if (real.trim() === reference.trim()) {
    return real.trim() !== "";
  }

  const left = halvesOf(real);
  const right = halvesOf(reference);

  if (left === undefined || right === undefined || left.adapter !== right.adapter) {
    return false;
  }

  const driver = withoutDriverVersion(left.driver);

  return driver !== "" && driver === withoutDriverVersion(right.driver);
};

const ineligible = (persona: GlPersona, reason: string): Verdict => ({
  kind: "ineligible",
  persona,
  reason,
});

const backendVerdict = (backend: GpuChoice["backend"], persona: GlPersona): Verdict => {
  const { kind, name } = persona;

  if (backend === "swiftshader") {
    return kind === "hide-only"
      ? { gpu: { backend, persona: { kind, name } }, kind: "eligible", persona }
      : ineligible(persona, HARDWARE_OVER_SWIFTSHADER);
  }

  return kind === "hardware"
    ? { gpu: { backend, persona: { kind, name } }, kind: "eligible", persona }
    : ineligible(persona, HIDE_ONLY_ON_NATIVE);
};

const adapterMismatch = (
  { renderer }: GlPersona,
  host: HostRenderer | undefined,
): string | undefined => {
  if (host === undefined) {
    return UNKNOWN_HOST_RENDERER;
  }

  return sameAdapter(host.renderer, renderer)
    ? undefined
    : `its renderer ${JSON.stringify(renderer)} names another adapter than this host's own ${JSON.stringify(host.renderer)}`;
};

const verdictOf = (persona: GlPersona, launch: Launch): Verdict => {
  const verdict = backendVerdict(launch.backend, persona);

  if (verdict.kind !== "eligible") {
    return verdict;
  }

  const mismatch =
    launch.backend === "native" ? adapterMismatch(persona, launch.hostRenderer) : undefined;

  if (mismatch !== undefined) {
    return ineligible(persona, mismatch);
  }

  if (persona.maxThreads < FEWEST_CLASS_CORES) {
    return ineligible(
      persona,
      `its max_threads of ${persona.maxThreads} is below ${FEWEST_CLASS_CORES}, the fewest cores of any machine class Xrio draws`,
    );
  }

  return persona.chromeVersion === launch.version
    ? verdict
    : {
        kind: "skewed",
        persona,
        reason: `it was captured on Chrome ${persona.chromeVersion}, and this browser is Chrome ${launch.version}`,
      };
};

const DRAWN_KINDS: ReadonlySet<GlPersonaKind> = new Set(["hardware"]);

const isDrawable = ({ persona }: EligiblePersona): boolean => DRAWN_KINDS.has(persona.kind);

const eligibleOf = (verdict: Verdict): EligiblePersona[] =>
  verdict.kind === "eligible" ? [{ gpu: verdict.gpu, persona: verdict.persona }] : [];

export const glLineupOf = (
  backend: GpuChoice["backend"],
  { fork, hostRenderer }: HostCapabilities,
): GlLineup => {
  if (fork === undefined) {
    return { drawable: [], pinnable: [], skewed: false };
  }

  const launch = { backend, hostRenderer, version: fork.version };
  const verdicts = fork.personas.gl.map((persona) => verdictOf(persona, launch));

  const pinnable = verdicts.flatMap(eligibleOf);

  return {
    drawable: pinnable.filter(isDrawable),
    pinnable,
    skewed: fork.personas.refusedGl.length > 0 || verdicts.some(({ kind }) => kind === "skewed"),
  };
};
