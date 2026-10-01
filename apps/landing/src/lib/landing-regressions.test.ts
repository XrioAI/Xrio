import { init } from "vgpu/mock";
import { describe, expect, it, vi } from "vite-plus/test";

import { createNoiseVolume } from "../components/canvas/blackhole-gpu/noise-volume";
import { createRandom } from "./random";
import { hexToRgb } from "./utils";

describe("landing migration", () => {
  it("preserves renderer noise, seeded geometry, and palette parsing from the source app", async () => {
    const random = createRandom();
    expect(Array.from({ length: 5 }, () => random())).toStrictEqual([
      0.3588899802416563, 0.10590326134115458, 0.675290479324758, 0.9179345588199794,
      0.10157715040259063,
    ]);
    expect(createRandom()()).toBe(0.3588899802416563);
    expect(hexToRgb(" #aB12EF ")).toBe("171,18,239");
    expect(hexToRgb("invalid")).toBe("255,255,255");

    const gpu = await init();
    let uploaded: number[] = [];

    const upload = vi
      .spyOn(gpu.gpu.queue, "writeTexture")
      .mockImplementation((_destination, data) => {
        if (!(data instanceof Uint8Array)) {
          throw new TypeError("Expected byte noise data");
        }

        uploaded = [...new Uint8Array(data.buffer, data.byteOffset, data.byteLength)];
      });

    try {
      createNoiseVolume(gpu, 4);
      // Golden bytes captured from xrio-landing-page main at 9d94102.
      expect(uploaded).toStrictEqual([
        209, 195, 250, 187, 153, 216, 253, 84, 241, 152, 200, 10, 67, 127, 28, 73, 43, 172, 3, 122,
        118, 175, 203, 70, 18, 139, 230, 47, 14, 138, 53, 216, 20, 181, 14, 48, 161, 184, 85, 51,
        212, 166, 2, 8, 159, 46, 52, 73, 201, 113, 84, 162, 83, 219, 214, 77, 50, 76, 40, 167, 30,
        96, 198, 196,
      ]);
    } finally {
      upload.mockRestore();
      gpu.dispose();
    }
  });
});
