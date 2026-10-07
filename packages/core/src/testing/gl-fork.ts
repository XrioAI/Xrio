import type {
  ForkFacts,
  GlPersona,
  HostCapabilities,
  KnobRegistry,
  RefusedGlArtifact,
} from "../humanizer/contracts.ts";
import { HARDWARE_KNOBS } from "./hardware-fork.ts";

export const SWIFTSHADER_RENDERER =
  "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";

export const RENOIR_RENDERER =
  "ANGLE (AMD, Vulkan 1.3.255 (AMD Radeon Graphics (RADV RENOIR) (0x0000164C)), radv)";

export const HIDE_ONLY: GlPersona = {
  chromeVersion: "154.0.8037.57",
  digest: `sha256:${"1".repeat(64)}`,
  formFactor: "desktop",
  hiddenExtensions: [
    "WEBGL_compressed_texture_astc",
    "WEBGL_compressed_texture_etc",
    "WEBGL_compressed_texture_etc1",
  ],
  kind: "hide-only",
  maxThreads: 16,
  name: "basharsx4-swiftshader-hidden",
  renderer: SWIFTSHADER_RENDERER,
  vendor: "Google Inc. (Google)",
};

export const RENOIR: GlPersona = {
  chromeVersion: "154.0.8037.57",
  digest: `sha256:${"2".repeat(64)}`,
  formFactor: "laptop",
  hiddenExtensions: [
    "WEBGL_clip_cull_distance",
    "WEBGL_compressed_texture_astc",
    "WEBGL_compressed_texture_etc",
    "WEBGL_compressed_texture_etc1",
  ],
  kind: "hardware",
  maxThreads: 16,
  name: "basharsx4-amd-renoir",
  renderer: RENOIR_RENDERER,
  vendor: "Google Inc. (AMD)",
};

interface GlForkOptions {
  readonly knobs?: KnobRegistry;
  readonly refusedGl?: readonly RefusedGlArtifact[];
}

export const forkWithGl = (
  gl: readonly GlPersona[],
  { knobs = HARDWARE_KNOBS, refusedGl = [] }: GlForkOptions = {},
): ForkFacts => ({
  buildUnreadable: false,
  commit: null,
  dialect: "xrio",
  dirty: null,
  knobs,
  packageDir: "/opt/xrio-chrome",
  personas: { gl, refusedGl, speech: [] },
  version: "154.0.8037.57",
});

export const swiftShaderHost = (fork: ForkFacts): HostCapabilities => ({
  fork,
  permittedCpus: 32,
  platform: "linux",
});

export const gpuHost = (fork: ForkFacts, renderer?: string): HostCapabilities => {
  const host: HostCapabilities = {
    fork,
    permittedCpus: 32,
    platform: "linux",
    readableRenderNode: true,
  };

  return renderer === undefined
    ? host
    : { ...host, hostRenderer: { renderer, vendor: "Google Inc. (AMD)" } };
};
