import type { Gpu } from "vgpu";
import type * as Vgpu from "vgpu";

// Deterministic tiled value-noise lattice shared by the disk shader and Node rendering.
export const NOISE_VOLUME_SIZE = 64;

const FORMAT = "r8unorm";

const SEED = 13;

const fr = Math.fround;

const fract = (value: number) => fr(value - Math.floor(value));

const K0 = fr(0.1031);

const K1 = fr(0.103);

const K2 = fr(0.0973);

const K3 = fr(33.33);

const hash31 = (x: number, y: number, z: number) => {
  let qx = fract(fr(x * K0));
  let qy = fract(fr(y * K1));
  let qz = fract(fr(z * K2));

  const d = fr(fr(fr(qx * fr(qy + K3)) + fr(qy * fr(qz + K3))) + fr(qz * fr(qx + K3)));

  qx = fr(qx + d);
  qy = fr(qy + d);
  qz = fr(qz + d);

  return fract(fr(fr(qx + qy) * qz));
};

/** Use signed coordinates so the disk's angular axes match the original analytic noise. */
const latticeCoord = (index: number, size: number) => (index < size / 2 ? index : index - size);

const buildNoiseVolume = (size: number, seed: number) => {
  const data = new Uint8Array(size * size * size);
  const offset = seed * 1024;
  let cursor = 0;

  for (let z = 0; z < size; z += 1) {
    const pz = latticeCoord(z, size) + offset;

    for (let y = 0; y < size; y += 1) {
      const py = latticeCoord(y, size);

      for (let x = 0; x < size; x += 1) {
        data[cursor] = Math.min(255, Math.round(hash31(latticeCoord(x, size), py, pz) * 255));
        cursor += 1;
      }
    }
  }

  return data;
};

const cache = new Map<string, Uint8Array<ArrayBuffer>>();

const noiseVolumeData = (size: number, seed: number) => {
  const key = `${size}:${seed}`;
  let data = cache.get(key);

  if (!data) {
    data = buildNoiseVolume(size, seed);
    cache.set(key, data);
  }

  return data;
};

export const createNoiseVolume = (
  gpu: Gpu,
  size = NOISE_VOLUME_SIZE,
  label = "black-hole-noise",
) => {
  const texture = gpu.device.createTexture({
    format: FORMAT,
    kind: "3d",
    label,
    size: [size, size, size],
    usage: ["texture_binding", "copy_dst"],
  });

  try {
    gpu.gpu.queue.writeTexture(
      { texture: texture.gpu },
      noiseVolumeData(size, SEED),
      { bytesPerRow: size, offset: 0, rowsPerImage: size },
      { depthOrArrayLayers: size, height: size, width: size },
    );

    return texture;
  } catch (error) {
    try {
      texture.destroy();
    } catch {
      // Preserve the upload failure that made this texture unusable.
    }

    throw error;
  }
};

export const noiseVolumeSampler = (vgpu: typeof Vgpu, gpu: Gpu) =>
  vgpu.sampler(gpu, {
    addressModeU: "repeat",
    addressModeV: "repeat",
    addressModeW: "repeat",
    magFilter: "linear",
    minFilter: "linear",
  });
