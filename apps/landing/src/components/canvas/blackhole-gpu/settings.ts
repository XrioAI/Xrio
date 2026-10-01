interface DiskLook {
  brightness: number;
  speed: number;
  stretch: number;
  detail: number;
  turbulence: number;
  density: number;
  doppler: number;
  cloudScale: number;
  cloudSpeed: number;
  cloudStrength: number;
  spare0: number;
  spare1: number;
  spare2: number;
  spare3: number;
}

interface StarLook {
  brightness: number;
  density: number;
  contrast: number;
  warmth: number;
  twinkle: number;
}

interface BloomLook {
  strength: number;
  threshold: number;
  knee: number;
  radius: number;
}

/** sRGB 0-1. */
export type Rgb = [number, number, number];

export interface HeroSettings {
  /** Elevation above the disk plane, radians. The shader clamps it to +-1.319 (+-75.6 deg). */
  cameraY: number;
  /** Orbit around the disk's vertical axis, radians. Moves the camera, so it re-lights the disk
      and swings the void; unlike roll this is a real change of viewpoint, not an image spin. */
  cameraYaw: number;
  distance: number;
  diskRadius: number;
  fov: number;
  centerX: number;
  centerY: number;
  cameraRoll: number;
  mouseYaw: number;
  centerFade: number;
  /** Duotone endpoints for the composite pass — see composite.wgsl. Defaults reproduce the
      original black-ground / white-disk look; the browser renderer overwrites both from the
      live palette's --xrio-bg / --xrio-fg. */
  ground: Rgb;
  ink: Rgb;
  /** Exponent on the duotone ramp — see composite.wgsl. 1 is the straight ramp; the browser
      renderer raises it on light palettes, where mid lumas read as grey wash rather than glow. */
  inkGamma: number;
  /** Gain on the duotone ramp, applied after inkGamma — see composite.wgsl. 1 leaves the ramp
      short of its endpoint; the browser renderer raises it on light palettes so the disk's
      darkest point prints at --xrio-fg rather than a washed-out fraction of it. */
  inkGain: number;
  /** Radial fade to the page colour at the frame's rim — see composite.wgsl. 0 on desktop, where
      the canvas is full-bleed; 1 on mobile, where it is a square figure in flow. */
  edgeFade: number;
  bloom: BloomLook;
  disk: DiskLook;
  stars: StarLook;
}

/** Shared deterministic production defaults for the browser and headless renderer. */
export const defaultHeroSettings = (): HeroSettings => ({
  bloom: { knee: 0.18, radius: 1.5, strength: 1, threshold: 0 },
  cameraRoll: -0.4,
  /* ── FRAMING, ported from the three.js hero this replaced ──
       cameraY  0.367 rad = 21 deg, the elevation that hero viewed the disk from: its camera sat
                at (2000, 1170, 2300) looking at the disk plane, so atan(1170 / hypot(2000, 2300)).
                The example shipped 0.16 (9 deg), which is far enough edge-on that the disk reads
                as a flat bar rather than a swept ellipse.
       fov      2.5, tuned so the void's widest chord is 31.9% of viewport width against the old
                hero's measured 31.5%. Larger fov narrows the field and enlarges the object.
       roll     -0.4. The old hero's disk leans: its swirl runs lower-left to upper-right at
                roughly 33 degrees, and the void sits in the crook of it. Matched by eye against
                that render rather than derived -- the argument that neither camera can roll
                (both build `right` from world up, so a horizontal plane keeps a level horizon)
                is true of the camera basis and still wrong about the picture, because the old
                hero's strands are not the disk plane's horizon. Setting this to 0 produced an
                upright, level disk that read as a different object. Rotate here to re-aim the
                lean; it turns the image, not the scene, so it does not move the void.
       centerX/centerY are seeds only — BlackholeGpuCanvas overwrites them every render from
       BlackholeContext's shift/anchorY, which is what actually pins the void. See setFraming. */
  cameraY: 0.367,
  cameraYaw: 0,
  centerFade: 0,
  centerX: 0.68,
  centerY: 0.182,
  disk: {
    brightness: 0.75,
    cloudScale: 20,
    cloudSpeed: 0.3,
    cloudStrength: 0.2,
    density: 1.38,
    detail: 3.44,
    doppler: 1.21,
    spare0: 0.43,
    spare1: -0.25,
    spare2: -0.67,
    spare3: 0.69,
    speed: 0.75,
    stretch: 5.75,
    turbulence: 4.46,
  },
  diskRadius: 9,
  distance: 13.5,
  edgeFade: 0,
  fov: 2.5,
  ground: [0, 0, 0],
  ink: [1, 1, 1],
  inkGain: 1,
  inkGamma: 1,
  mouseYaw: 0.15,
  stars: { brightness: 1, contrast: 13, density: 1, twinkle: 0, warmth: 0.5 },
});
