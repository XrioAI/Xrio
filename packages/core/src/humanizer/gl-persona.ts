import type {
  GlPersona,
  GlPersonaKind,
  GpuChoice,
  GpuPolicy,
  HostCapabilities,
  HostRenderer,
  PersonaClaims,
} from "./contracts.ts";
import { MACHINE_CLASSES } from "./owned-inputs.ts";

export interface EligiblePersona {
  readonly persona: GlPersona;
  readonly gpu: GpuChoice;
}

type PinnedPersona =
  | { readonly kind: "eligible"; readonly choice: EligiblePersona }
  | { readonly kind: "refused"; readonly reason: string };

export interface GlLineup {
  readonly policy: GpuPolicy;
  readonly drawable: readonly EligiblePersona[];
  readonly pinnable: readonly EligiblePersona[];
  readonly skewed: boolean;
  readonly pin: (name: string) => PinnedPersona;
}

type Verdict =
  | ({ readonly kind: "eligible" } & EligiblePersona)
  | { readonly kind: "skewed"; readonly persona: GlPersona; readonly reason: string }
  | { readonly kind: "ineligible"; readonly persona: GlPersona; readonly reason: string };

interface Launch {
  readonly policy: GpuPolicy;
  readonly backend: GpuChoice["backend"];
  readonly version: string;
  readonly hostRenderer: HostRenderer | undefined;
}

const HARDWARE_OVER_SWIFTSHADER =
  "it is a hardware persona, and the matched policy presents one only on a GPU whose own renderer equals it, never over SwiftShader";

const HIDE_ONLY_ON_NATIVE = "it claims SwiftShader, and this launch renders on the host GPU";

const UNKNOWN_HOST_RENDERER = "this host's own renderer is unknown";

const FEWEST_CLASS_CORES = Math.min(...MACHINE_CLASSES.map(({ cores }) => cores));

const NOT_A_FORK = "this browser is not an Xrio fork package, so it has no GL personas";

const UNMASKED_VENDOR_BRAND = /\((?<brand>[^()]+)\)$/u;

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

const swiftshaderVerdict = (persona: GlPersona, policy: GpuPolicy): Verdict => {
  const { name } = persona;

  if (persona.kind === "hide-only") {
    return {
      gpu: { backend: "swiftshader", persona: { kind: persona.kind, name } },
      kind: "eligible",
      persona,
    };
  }

  return policy === "announce"
    ? {
        gpu: {
          backend: "swiftshader",
          persona: { kind: persona.kind, name },
          policy: "announce",
        },
        kind: "eligible",
        persona,
      }
    : ineligible(persona, HARDWARE_OVER_SWIFTSHADER);
};

const backendVerdict = (launch: Launch, persona: GlPersona): Verdict => {
  if (launch.backend === "swiftshader") {
    return swiftshaderVerdict(persona, launch.policy);
  }

  return persona.kind === "hardware"
    ? {
        gpu: { backend: "native", persona: { kind: persona.kind, name: persona.name } },
        kind: "eligible",
        persona,
      }
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
  const verdict = backendVerdict(launch, persona);

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

const refusalOf = (verdict: Verdict): [string, string][] =>
  verdict.kind === "eligible" ? [] : [[verdict.persona.name, verdict.reason]];

const refused = (reason: string): PinnedPersona => ({ kind: "refused", reason });

const brandOf = (vendor: string): string | undefined => {
  const text = vendor.trim();
  const brand = UNMASKED_VENDOR_BRAND.exec(text)?.groups?.brand?.trim() ?? text;

  return brand === "" ? undefined : brand;
};

export const personaClaims = ({ formFactor, vendor }: GlPersona): PersonaClaims => ({
  laptop: formFactor === "laptop",
  vendor: brandOf(vendor),
});

export const hardwareEligibleCount = ({ pinnable }: GlLineup): number =>
  pinnable.filter(({ persona }) => persona.kind === "hardware").length;

export const glLineupOf = (
  backend: GpuChoice["backend"],
  { fork, hostRenderer }: HostCapabilities,
  policy: GpuPolicy,
): GlLineup => {
  if (fork === undefined) {
    return {
      drawable: [],
      pin: () => refused(NOT_A_FORK),
      pinnable: [],
      policy,
      skewed: false,
    };
  }

  const launch = { backend, hostRenderer, policy, version: fork.version };
  const verdicts = fork.personas.gl.map((persona) => verdictOf(persona, launch));
  const pinnable = verdicts.flatMap(eligibleOf);

  const refusals = new Map([
    ...fork.personas.refusedGl.map(({ reason, stem }): [string, string] => [
      stem,
      `its artifact ${reason}`,
    ]),
    ...verdicts.flatMap(refusalOf),
  ]);

  const pin = (name: string): PinnedPersona => {
    const choice = pinnable.find(({ persona }) => persona.name === name);

    return choice === undefined
      ? refused(refusals.get(name) ?? `this browser's package has no GL persona named ${name}`)
      : { choice, kind: "eligible" };
  };

  return {
    drawable: pinnable.filter(isDrawable),
    pin,
    pinnable,
    policy,
    skewed: fork.personas.refusedGl.length > 0 || verdicts.some(({ kind }) => kind === "skewed"),
  };
};
