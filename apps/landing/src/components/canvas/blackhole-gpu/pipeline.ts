import type { Effect, Frame, Gpu, Surface, Target } from "vgpu";
import type * as Vgpu from "vgpu";

import bakeWgsl from "./bake.wgsl";
import bloomWgsl from "./bloom.wgsl";
import compositeWgsl from "./composite.wgsl";
import { createNoiseVolume, NOISE_VOLUME_SIZE, noiseVolumeSampler } from "./noise-volume";
import refineWgsl from "./refine.wgsl";
import type { HeroSettings } from "./settings";
import shadeWgsl from "./shade.wgsl";

export type VgpuApi = typeof Vgpu;

type Output = Surface | Target;

type NoiseVolume = ReturnType<typeof createNoiseVolume>;

export interface Effects {
  bake: Effect;
  refine: Effect;
  shade: Effect;
  bloomExtract: Effect;
  bloomBlurH0: Effect;
  bloomBlurV0: Effect;
  bloomDown1: Effect;
  bloomBlurH1: Effect;
  bloomBlurV1: Effect;
  bloomDown2: Effect;
  bloomBlurH2: Effect;
  bloomBlurV2: Effect;
  composite: Effect;
  postSampler: GPUSampler;
  noiseVolume: NoiseVolume;
  noiseSampler: GPUSampler;
}

export interface Targets {
  gbuffer: Target;
  aa: Target;
  scene: Target;
  bloom0: Target;
  bloomPing0: Target;
  bloom1: Target;
  bloomPing1: Target;
  bloom2: Target;
  bloomPing2: Target;
}

const GBUFFER_FORMATS: readonly GPUTextureFormat[] = [
  "rg32float",
  "rg32float",
  "rgba16float",
  "rgba16float",
];

const AA_FORMATS: readonly GPUTextureFormat[] = ["rg8unorm", "rgba16float"];

const CLEAR: readonly [number, number, number, number] = [0, 0, 0, 1];

export const createEffects = (vgpu: VgpuApi, gpu: Gpu): Effects => {
  const postSampler = vgpu.sampler(gpu, {
    magFilter: "linear",
    minFilter: "linear",
  });

  const noiseSampler = noiseVolumeSampler(vgpu, gpu);

  return {
    bake: vgpu.effect(gpu, bakeWgsl),
    bloomBlurH0: vgpu.effect(gpu, bloomWgsl),
    bloomBlurH1: vgpu.effect(gpu, bloomWgsl),
    bloomBlurH2: vgpu.effect(gpu, bloomWgsl),
    bloomBlurV0: vgpu.effect(gpu, bloomWgsl),
    bloomBlurV1: vgpu.effect(gpu, bloomWgsl),
    bloomBlurV2: vgpu.effect(gpu, bloomWgsl),
    bloomDown1: vgpu.effect(gpu, bloomWgsl),
    bloomDown2: vgpu.effect(gpu, bloomWgsl),
    bloomExtract: vgpu.effect(gpu, bloomWgsl),
    composite: vgpu.effect(gpu, compositeWgsl),
    noiseSampler,
    noiseVolume: createNoiseVolume(gpu, NOISE_VOLUME_SIZE),
    postSampler,
    refine: vgpu.effect(gpu, refineWgsl),
    shade: vgpu.effect(gpu, shadeWgsl),
  };
};

const normalizeSize = (size: readonly [number, number]): [number, number] => [
  Math.max(1, Math.floor(size[0])),
  Math.max(1, Math.floor(size[1])),
];

const scaleSize = (size: readonly [number, number], divisor: number): [number, number] => [
  Math.max(1, Math.floor(size[0] / divisor)),
  Math.max(1, Math.floor(size[1] / divisor)),
];

// vgpu.target() returns an OffscreenTarget, while its public Target type omits destroy().
const hasDestroy = (value: Target): value is Target & { destroy: () => void } =>
  "destroy" in value && typeof value.destroy === "function";

const destroyTarget = (value: Target | undefined): void => {
  if (value && hasDestroy(value)) {
    value.destroy();
  }
};

const destroyTargetList = (values: readonly Target[]): void => {
  let failed = false;
  let failure: unknown;

  for (const value of values) {
    try {
      destroyTarget(value);
    } catch (error) {
      if (!failed) {
        failure = error;
      }

      failed = true;
    }
  }

  if (failed) {
    throw failure;
  }
};

export const createTargets = (
  vgpu: VgpuApi,
  gpu: Gpu,
  size: readonly [number, number],
): Targets => {
  const full = normalizeSize(size);
  const half = scaleSize(full, 2);
  const quarter = scaleSize(full, 4);
  const eighth = scaleSize(full, 8);

  const postTarget = (targetSize: readonly [number, number]) =>
    vgpu.target(gpu, {
      colors: [{ format: "rgba16float" }],
      size: targetSize,
    });

  const created: Target[] = [];

  const own = (value: Target) => {
    created.push(value);

    return value;
  };

  try {
    return {
      aa: own(
        vgpu.target(gpu, {
          colors: AA_FORMATS.map((format) => ({ format })),
          size: full,
        }),
      ),
      bloom0: own(postTarget(half)),
      bloom1: own(postTarget(quarter)),
      bloom2: own(postTarget(eighth)),
      bloomPing0: own(postTarget(half)),
      bloomPing1: own(postTarget(quarter)),
      bloomPing2: own(postTarget(eighth)),
      gbuffer: own(
        vgpu.target(gpu, {
          colors: GBUFFER_FORMATS.map((format) => ({ format })),
          size: full,
        }),
      ),
      scene: own(postTarget(full)),
    };
  } catch (error) {
    try {
      destroyTargetList(created.toReversed());
    } catch {
      // The allocation failure remains the primary error.
    }

    throw error;
  }
};

export const destroyTargets = (targets: Targets): void => {
  destroyTargetList([
    targets.gbuffer,
    targets.aa,
    targets.scene,
    targets.bloom0,
    targets.bloomPing0,
    targets.bloom1,
    targets.bloomPing1,
    targets.bloom2,
    targets.bloomPing2,
  ]);
};

export const setBindings = (effects: Effects, targets: Targets): void => {
  const [hit1, hit2, sky, view] = targets.gbuffer.colors;
  const [aa, aaGeom] = targets.aa.colors;
  effects.bake.set({ bake: { resolution: targets.gbuffer.size } });
  effects.refine.set({
    gHit1: hit1,
    gSky: sky,
    refine: { resolution: targets.gbuffer.size },
  });
  effects.shade.set({
    gAa: aa,
    gAaGeom: aaGeom,
    gHit1: hit1,
    gHit2: hit2,
    gSky: sky,
    gView: view,
    noiseSampler: effects.noiseSampler,
    noiseVolume: effects.noiseVolume,
    shade: { resolution: targets.gbuffer.size },
  });

  const [scene] = targets.scene.colors;
  const [bloom0] = targets.bloom0.colors;
  const [bloomPing0] = targets.bloomPing0.colors;
  const [bloom1] = targets.bloom1.colors;
  const [bloomPing1] = targets.bloomPing1.colors;
  const [bloom2] = targets.bloom2.colors;
  const [bloomPing2] = targets.bloomPing2.colors;

  effects.bloomExtract.set({
    linearSampler: effects.postSampler,
    source: scene,
  });
  effects.bloomBlurH0.set({
    linearSampler: effects.postSampler,
    source: bloom0,
  });
  effects.bloomBlurV0.set({
    linearSampler: effects.postSampler,
    source: bloomPing0,
  });
  effects.bloomDown1.set({
    linearSampler: effects.postSampler,
    source: bloom0,
  });
  effects.bloomBlurH1.set({
    linearSampler: effects.postSampler,
    source: bloom1,
  });
  effects.bloomBlurV1.set({
    linearSampler: effects.postSampler,
    source: bloomPing1,
  });
  effects.bloomDown2.set({
    linearSampler: effects.postSampler,
    source: bloom1,
  });
  effects.bloomBlurH2.set({
    linearSampler: effects.postSampler,
    source: bloom2,
  });
  effects.bloomBlurV2.set({
    linearSampler: effects.postSampler,
    source: bloomPing2,
  });
  effects.composite.set({
    bloomFar: bloom2,
    bloomMedium: bloom1,
    bloomNear: bloom0,
    linearSampler: effects.postSampler,
    scene,
  });
};

export const setBakeUniforms = (
  effects: Effects,
  targets: Targets,
  settings: HeroSettings,
): void => {
  const geometry = {
    centerX: settings.centerX,
    centerY: settings.centerY,
    diskOuter: settings.diskRadius,
    fov: settings.fov,
    orbitRadius: settings.distance,
    pitch: settings.cameraY,
    resolution: targets.gbuffer.size,
    roll: settings.cameraRoll,
    yaw: settings.cameraYaw,
  };

  effects.bake.set({ bake: geometry });
  effects.refine.set({ refine: geometry });
};

export const setShadeUniforms = (
  effects: Effects,
  targets: Targets,
  settings: HeroSettings,
  time: number,
  sceneYaw: number,
): void => {
  effects.shade.set({
    disk: settings.disk,
    shade: {
      centerFade: settings.centerFade,
      diskOuter: settings.diskRadius,
      resolution: targets.gbuffer.size,
      sceneYaw,
      time,
    },
    stars: settings.stars,
  });
};

export const setPostUniforms = (
  effects: Effects,
  targets: Targets,
  settings: HeroSettings,
): void => {
  const threshold = Math.max(0, settings.bloom.threshold);
  const knee = Math.max(0.0001, settings.bloom.knee);
  const radius = Math.max(0.1, settings.bloom.radius);

  const downsample = (sourceSize: readonly [number, number], applyThreshold: boolean) => ({
    direction: [0, 0],
    params: [applyThreshold ? threshold : -1, knee, radius, 0],
    sourceSize,
  });

  const blur = (sourceSize: readonly [number, number], x: number, y: number) => ({
    direction: [x, y],
    params: [-1, knee, radius, 1],
    sourceSize,
  });

  effects.bloomExtract.set({ bloom: downsample(targets.scene.size, true) });
  effects.bloomBlurH0.set({ bloom: blur(targets.bloom0.size, 1, 0) });
  effects.bloomBlurV0.set({ bloom: blur(targets.bloomPing0.size, 0, 1) });
  effects.bloomDown1.set({ bloom: downsample(targets.bloom0.size, false) });
  effects.bloomBlurH1.set({ bloom: blur(targets.bloom1.size, 1, 0) });
  effects.bloomBlurV1.set({ bloom: blur(targets.bloomPing1.size, 0, 1) });
  effects.bloomDown2.set({ bloom: downsample(targets.bloom1.size, false) });
  effects.bloomBlurH2.set({ bloom: blur(targets.bloom2.size, 1, 0) });
  effects.bloomBlurV2.set({ bloom: blur(targets.bloomPing2.size, 0, 1) });
  effects.composite.set({
    composite: {
      ground: [...settings.ground, 1],
      ink: [...settings.ink, 1],
      params: [
        Math.max(0, settings.bloom.strength),
        Math.max(0.01, settings.inkGamma),
        Math.max(0.01, settings.inkGain),
        Math.min(1, Math.max(0, settings.edgeFade)),
      ],
    },
  });
};

export const prewarm = async (
  effects: Effects,
  targets: Targets,
  output: Output,
): Promise<void> => {
  const bloomOutput = { colors: [targets.bloom0.format] };
  await Promise.all([
    effects.bake.compile(targets.gbuffer),
    effects.refine.compile(targets.aa),
    effects.shade.compile(targets.scene),
    effects.bloomExtract.compile(bloomOutput),
    effects.bloomBlurH0.compile(bloomOutput),
    effects.bloomBlurV0.compile(bloomOutput),
    effects.bloomDown1.compile(bloomOutput),
    effects.bloomBlurH1.compile(bloomOutput),
    effects.bloomBlurV1.compile(bloomOutput),
    effects.bloomDown2.compile(bloomOutput),
    effects.bloomBlurH2.compile(bloomOutput),
    effects.bloomBlurV2.compile(bloomOutput),
    effects.composite.compile({ colors: [output.format] }),
  ]);
};

export const renderChain = (
  frame: Frame,
  effects: Effects,
  targets: Targets,
  output: Output,
  bake: boolean,
): void => {
  if (bake) {
    frame.pass({ clear: CLEAR, target: targets.gbuffer }, (pass) => {
      pass.draw(effects.bake);
    });
    frame.pass({ clear: CLEAR, target: targets.aa }, (pass) => {
      pass.draw(effects.refine);
    });
  }

  frame.pass({ clear: CLEAR, target: targets.scene }, (pass) => {
    pass.draw(effects.shade);
  });
  frame.pass({ clear: CLEAR, target: targets.bloom0 }, (pass) => {
    pass.draw(effects.bloomExtract);
  });
  frame.pass({ clear: CLEAR, target: targets.bloomPing0 }, (pass) => {
    pass.draw(effects.bloomBlurH0);
  });
  frame.pass({ clear: CLEAR, target: targets.bloom0 }, (pass) => {
    pass.draw(effects.bloomBlurV0);
  });
  frame.pass({ clear: CLEAR, target: targets.bloom1 }, (pass) => {
    pass.draw(effects.bloomDown1);
  });
  frame.pass({ clear: CLEAR, target: targets.bloomPing1 }, (pass) => {
    pass.draw(effects.bloomBlurH1);
  });
  frame.pass({ clear: CLEAR, target: targets.bloom1 }, (pass) => {
    pass.draw(effects.bloomBlurV1);
  });
  frame.pass({ clear: CLEAR, target: targets.bloom2 }, (pass) => {
    pass.draw(effects.bloomDown2);
  });
  frame.pass({ clear: CLEAR, target: targets.bloomPing2 }, (pass) => {
    pass.draw(effects.bloomBlurH2);
  });
  frame.pass({ clear: CLEAR, target: targets.bloom2 }, (pass) => {
    pass.draw(effects.bloomBlurV2);
  });
  frame.pass({ clear: CLEAR, target: output }, (pass) => {
    pass.draw(effects.composite);
  });
};
