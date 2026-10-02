// Combine bloom levels, tone map, vignette, and convert to display output.

struct Composite {
  params: vec4f,
  // Duotone endpoints, sRGB. The tonemap below is monochrome (SATURATION = 0), so the whole
  // image is one luma ramp and the theme is just the two colours that ramp runs between:
  // ground at luma 0, ink at luma 1. Dark themes keep the original polarity (near-black ground,
  // near-white disk); light themes invert it for free — the void lands on paper and the disk
  // darkens it, which is how the three.js version carried the light palettes.
  ground: vec4f,
  ink: vec4f,
}

// params.y — exponent on the ink ramp. 1.0 is the straight ramp the dark palettes want. Light
// palettes need more: the same luma reads as a faint glow against black but as flat mid-grey on
// paper, and the disk's haze covers enough of the frame to wash the whole hero out. Measured on
// light Mono, 70% of pixels are already below 0.05 and another 12% sit in 0.05-0.20 — it is that
// second group, plus the 0.2-0.5 band, that greys the paper. The exponent pushes them back to
// paper and leaves the bright core (which never exceeds ~0.94) essentially where it was.
//
// params.z — gain on that ramp, applied after the exponent and clamped at 1. Without it the ramp
// never reaches its own endpoint: the tonemapped scene peaks near 0.94 rather than 1.0, and the
// exponent pulls that down further, so the darkest ink the disk can print lands well short of
// --xrio-fg. On a dark palette that is invisible (the shortfall is at the bright end, against
// black). On paper it is the difference between a grey-black disk and one as dark as the body
// text. The gain is 1 / peak^exponent, so it tracks the exponent instead of being re-tuned
// beside it.
//
// params.w — edge fade, 0 off, 1 full. The raymarcher fills every pixel it is handed, so in a
// container that is not full-bleed it paints a hard rectangle: on mobile this canvas is a square
// figure in flow, and without this the disk ran to all four sides and stopped dead against a
// near-black page (luma 8 outside, ~126 inside), reading as a photo in a frame. The Canvas 2D
// figure it replaced had no such edge because it drew sparks that thinned out on their own.
//
// It fades luma rather than alpha, because the ramp's ground IS --xrio-bg: driving luma to 0 at
// the rim lands on exactly the page colour, on light palettes as well as dark, with nothing to
// blend against. Off on desktop, where the canvas is full-bleed and should reach the edges.

@group(0) @binding(0) var<uniform> composite: Composite;
@group(0) @binding(1) var scene: texture_2d<f32>;
@group(0) @binding(2) var bloomNear: texture_2d<f32>;
@group(0) @binding(3) var bloomMedium: texture_2d<f32>;
@group(0) @binding(4) var bloomFar: texture_2d<f32>;
@group(0) @binding(5) var linearSampler: sampler;

const EXPOSURE: f32 = 1.15;
const SATURATION: f32 = 0.0;

fn aces(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + vec3f(b))) / (x * (c * x + vec3f(d)) + vec3f(e)), vec3f(0.0), vec3f(1.0));
}

fn tonemap(linearColor: vec3f, uv: vec2f) -> vec3f {
  var color = aces(linearColor * EXPOSURE);

  let centered = uv - vec2f(0.5);
  let vignette = 1.0 - smoothstep(0.55, 1.15, length(centered) * 1.6);
  color *= mix(0.72, 1.0, vignette);

  color = pow(color, vec3f(1.0 / 2.2));
  let luma = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  return mix(vec3f(luma), color, SATURATION);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let sceneColor = textureSample(scene, linearSampler, uv).rgb;
  let bloom =
    textureSample(bloomNear, linearSampler, uv).rgb * 0.50 +
    textureSample(bloomMedium, linearSampler, uv).rgb * 0.32 +
    textureSample(bloomFar, linearSampler, uv).rgb * 0.18;
  let hdr = sceneColor + bloom * composite.params.x;
  let ramp = min(pow(tonemap(hdr, uv).r, composite.params.y) * composite.params.z, 1.0);
  // 1 out to 0.26 of the frame, gone by 0.5 — which is the edge midpoint, so the fade completes
  // before the border rather than at it. Corners sit at 0.707 and are long gone.
  let edge = smoothstep(0.5, 0.26, length(uv - vec2f(0.5)));
  let luma = ramp * mix(1.0, edge, composite.params.w);
  return vec4f(mix(composite.ground.rgb, composite.ink.rgb, luma), 1.0);
}
