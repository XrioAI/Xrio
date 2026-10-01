"use client";

import { useEffect, useRef } from "react";
import type {
  Scene,
  WebGLRenderer,
  PerspectiveCamera,
  Group,
  Object3D,
  Material,
  MeshBasicMaterial,
  Mesh,
} from "three";

import { useBlackhole } from "@/context/blackhole-context";
import { useCorona } from "@/context/corona-context";
import { createRandom } from "@/lib/random";

const loadThree = async () => {
  const [THREE, { LineSegmentsGeometry }, { LineMaterial }, { LineSegments2 }] = await Promise.all([
    import("three"),
    import("three/examples/jsm/lines/LineSegmentsGeometry.js"),
    import("three/examples/jsm/lines/LineMaterial.js"),
    import("three/examples/jsm/lines/LineSegments2.js"),
  ]);

  return { LineMaterial, LineSegments2, LineSegmentsGeometry, THREE };
};

const cl = (v: number) => Math.max(-1, Math.min(1, v));

const disposeScene = (scene: Scene, THREE: Awaited<ReturnType<typeof loadThree>>["THREE"]) => {
  const isMesh = (object: Object3D): object is Mesh => object instanceof THREE.Mesh;
  scene.traverse((obj) => {
    if (!isMesh(obj)) {
      return;
    }

    obj.geometry.dispose();
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];

    for (const material of materials) {
      material.dispose();
    }
  });

  if (scene.background instanceof THREE.Texture) {
    scene.background.dispose();
  }
};

const resizeCanvas = (canvas: HTMLCanvasElement, width: number, height: number) => {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
};

export const BlackholeCanvas = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { shift, anchorY, opacity, scale } = useBlackhole();
  const { equators } = useCorona();

  /* build() and frame() run outside React's render pass and need whatever these values are NOW,
     not the ones captured when the mount effect closed over them. Four refs assigned during
     render did that, but a render React discards still leaves its write behind, so the sync
     happens in an effect instead. Safe here because every consumer is downstream of a commit:
     the rebuild that reads them is debounced 300ms behind the state change, and per-frame reads
     only ever want the newest value. */
  const rebuildRef = useRef<(() => void) | null>(null);
  const live = useRef({ anchorY, equators, scale, shift });
  useEffect((): ReturnType<React.EffectCallback> => {
    const previous = live.current;
    live.current = { anchorY, equators, scale, shift };

    if (previous.anchorY === anchorY && previous.scale === scale && previous.shift === shift) {
      return;
    }

    const timer = setTimeout(() => {
      rebuildRef.current?.();
    }, 300);

    return () => {
      clearTimeout(timer);
    };
  }, [shift, anchorY, scale, equators]);

  useEffect((): ReturnType<React.EffectCallback> => {
    const canvas = canvasRef.current;

    const host = canvas?.parentElement;

    if (!canvas || !host) {
      return;
    }

    let raf: number;
    let renderer: WebGLRenderer | null = null;
    let _cleanupFn: (() => void) | null = null;
    let disposed = false;

    const init = async () => {
      const { THREE, LineSegmentsGeometry, LineMaterial, LineSegments2 } = await loadThree();

      if (disposed) {
        return;
      }

      const TAU = Math.PI * 2;
      let srnd = createRandom();

      const rnd = (a: number, b: number) => a + srnd() * (b - a);

      const MASS_WR = 250;
      const BASE_OMEGA = 0.000055;
      const N_BANDS = 18;
      const ARCS_PB = 82;
      const BASE_FOV = 17;
      /* scale > 1 narrows FOV to zoom the whole scene in; recomputed in build() from the live slider */
      let CAM_FOV = BASE_FOV;
      const CAM_Z = 2300;
      const CAM_Y = 1170;
      const CAM_X = 2000;
      const DISK_TILT = 1.15;

      const PLANES = [
        { exp: 8, rScale: 0.98, scale: 0.58, y: -10 },
        { exp: 5.5, rScale: 1, scale: 1, y: 0 },
        { exp: 3, rScale: 1.02, scale: 0.72, y: 10 },
      ];

      let scene = new THREE.Scene();
      let camera: PerspectiveCamera;
      let diskRoot: Group;
      /* Un-rolled parent of diskRoot used only for the mouse tilt. diskRoot carries the big
         DISK_TILT roll; tilting it directly mixed pitch into that roll, so up/down came out
         sideways. This parent sits at the same pivot with no base rotation, and the tilt is applied
         about the camera's own right/up axes (below), so screen-up maps to pitch and screen-right to
         yaw regardless of the disk's roll or the camera's diagonal view. */
      let diskTilt: Group;
      let bands: { lines: Object3D; omega: number }[] = [];
      let lineMaterials: Material[] = [];
      let ts0 = 0;
      const taperExp = 7.5;
      const spanMult = 0.9;

      /* Mouse parallax, driven into the actual 3D scene (not a CSS skew of the flat render). The
         disk is three stacked planes, so rotating diskRoot re-projects them with real
         foreshortening and inter-plane parallax; the mass sphere and the sky backdrop are separate
         and hold still, so the void stays put and the disk tilts about it. tiltT* is the live mouse
         target (-1..1), tilt* the eased value applied each frame. TILT_RAD keeps it subtle. */
      /* Sign sets direction: positive tilts the disk toward the cursor, negative away. Kept tiny on
         purpose — a whisper of reorientation reads as scale; more just looks like a wobble. Yaw
         (horizontal mouse) gets a bigger amount than pitch: on a disk this edge-on, a rotation about
         the screen-vertical axis moves the image less than one about the horizontal axis, and the
         viewport is wider than tall so horizontal mouse travel maps to a smaller normalized value. */
      // vertical mouse → pitch about camera right
      const TILT_PITCH = 0.014;
      // horizontal mouse → yaw about camera up (1.5× pitch)
      const TILT_YAW = 0.021;

      let tiltTX = 0;
      let tiltTY = 0;
      let tiltVX = 0;
      let tiltVY = 0;
      let tiltX = 0;
      let tiltY = 0;

      /* Settle time (s) for the spring below. Bigger = slower overall. */
      const TILT_SMOOTH = 1.6;

      // 2D glow overlay
      const glowCanvas = document.createElement("canvas");
      glowCanvas.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1";
      const glowCtx = glowCanvas.getContext("2d");

      const eqAccumCanvas = document.createElement("canvas");
      const eqAccumCtx = eqAccumCanvas.getContext("2d");
      /* screen-space origin of the equator scratch surface, set each frame by drawCorona and
         consumed by the composite that stamps it back into the glow canvas */
      let eqAccumOx = 0;
      let eqAccumOy = 0;
      const eqWorkCanvas = document.createElement("canvas");
      const eqWorkCtx = eqWorkCanvas.getContext("2d");

      if (!glowCtx || !eqAccumCtx || !eqWorkCtx) {
        return;
      }

      const activeRenderer = new THREE.WebGLRenderer({
        antialias: true,
        canvas,
        powerPreference: "high-performance",
        preserveDrawingBuffer: true,
      });

      renderer = activeRenderer;
      host.append(glowCanvas);

      const massWorldPos = new THREE.Vector3();
      let jetScreenR = 0;
      let massSx = 0;
      let massSy = 0;

      /* Camera right/up axes in world space, extracted once per build (the camera is fixed). The
         tilt rotates diskTilt about these so it reads as screen-aligned pitch/yaw. */
      const camRight = new THREE.Vector3();
      const camUp = new THREE.Vector3();
      /* Void centre as viewport fractions — the tilt control's zero point, so the disk sits flat
         when the cursor is on it and tilts as the cursor moves away. Set in build() from the
         projected mass; seeded to screen centre for the first frame before build runs. */
      let diskFx = 0.5;
      let diskFy = 0.5;
      const _camDir = new THREE.Vector3();
      const _qTilt = new THREE.Quaternion();
      const _qTmp = new THREE.Quaternion();

      /* reusable vectors — allocated once, never re-allocated per frame */
      const _ndcVec = new THREE.Vector3();
      const _poleVec = new THREE.Vector3();
      const _ndcPole = new THREE.Vector3();

      /* tracked so the glow canvas resizes only on viewport change, not every frame */
      let _lastCh = 0;
      let _lastCw = 0;

      const pulseDepth = 0.25;
      const pulseSpeed = 1;

      /* halo/hotspot color, rebaked in build() from the live theme's --xrio-accent2 (material accent) */
      let haloRgb = "230,238,250";

      /* true between webglcontextlost and webglcontextrestored — every resume path checks this
         so nothing restarts the RAF loop while there is no live context to render into */
      let contextLost = false;

      /* last --xrio-bg applied to the scene backdrop + mass sphere, so frame() can cheaply detect
         a change (or a stale bake) and re-assert the correct color without re-parsing every frame */
      let lastBgHex = "";
      let massMat: MeshBasicMaterial | null = null;

      const drawCorona = (ts: number) => {
        if (live.current.equators.length === 0) {
          glowCtx.clearRect(0, 0, glowCanvas.width, glowCanvas.height);

          return;
        }

        const cw = canvas.offsetWidth;
        const ch = canvas.offsetHeight;

        if (cw === 0 || ch === 0) {
          return;
        }

        /* only resize when viewport changes — setting width/height clears the canvas */
        if (cw !== _lastCw || ch !== _lastCh) {
          _lastCw = cw;
          _lastCh = ch;
          glowCanvas.width = cw;
          glowCanvas.height = ch;
        }

        _ndcVec.copy(massWorldPos).project(camera);
        const sx = (_ndcVec.x * 0.5 + 0.5) * cw;
        const sy = (-_ndcVec.y * 0.5 + 0.5) * ch;
        massSx = sx;
        massSy = sy;

        const dist = massWorldPos.distanceTo(camera.position);
        const fPx = ch / 2 / Math.tan((camera.fov * Math.PI) / 360);
        const screenR = (fPx * MASS_WR) / Math.sqrt(Math.max(1, dist * dist - MASS_WR * MASS_WR));
        jetScreenR = screenR;

        _poleVec.set(
          massWorldPos.x - Math.sin(DISK_TILT) * MASS_WR * 3,
          massWorldPos.y + Math.cos(DISK_TILT) * MASS_WR * 3,
          massWorldPos.z,
        );
        _ndcPole.copy(_poleVec).project(camera);
        const poleSx = (_ndcPole.x * 0.5 + 0.5) * cw;
        const poleSy = (-_ndcPole.y * 0.5 + 0.5) * ch;
        const poleAngle = Math.atan2(poleSy - sy, poleSx - sx);

        const projPoleDist = Math.hypot(poleSx - sx, poleSy - sy);
        const worldPoleDist = (fPx * (MASS_WR * 3)) / dist;
        const squash = Math.min(0.95, Math.max(0.18, projPoleDist / worldPoleDist));

        const ehRa = screenR * 1.02;
        const ehRb = screenR * 1.02 * squash;
        const ehRot = poleAngle + Math.PI * 0.5;

        const p1 = 0.5 + 0.5 * Math.sin(ts * 0.00042 * pulseSpeed);
        const p2 = 0.5 + 0.5 * Math.sin(ts * 0.00071 * pulseSpeed + 1.3);
        const pulse = 1 - pulseDepth + pulseDepth * (p1 * 0.6 + p2 * 0.4);

        const clipShift = screenR * -0.1;
        const fadeSize = screenR * 0.3;
        const poleUpDx = Math.cos(poleAngle);
        const poleUpDy = Math.sin(poleAngle);
        const gx0 = sx + clipShift * poleUpDx;
        const gy0 = sy + clipShift * poleUpDy;
        const gx1 = sx + (clipShift + fadeSize) * poleUpDx;
        const gy1 = sy + (clipShift + fadeSize) * poleUpDy;

        /* Equators.

           The scratch surfaces are sized to the corona's own bounding box, not to the viewport.
           They used to be padded by `max(cw,ch)*2` on every side so that arcs running off-screen
           still had somewhere to land for the gradient fade — correct, but ruinously expensive:
           at 1512x982 that is a 7560x7030 surface (53 megapixels) cleared, gradient-filled and
           composited once per equator per frame. On the four-ring "full" preset that worked out
           to ~690 megapixels of fill per frame to draw what amounts to a thin ellipse, and it
           dropped the page to ~10fps with ~290ms stalls.

           What actually has to be covered is the ellipse plus its stroke and the fade ramp that
           reaches back behind it — never more than ~1.6x screenR from the centre across every
           preset. So pad by that, and translate by the box origin instead of by a constant: the
           blackhole's screen position is absorbed into the offset rather than into the surface
           size, which keeps the canvas the same modest size no matter how far the shift slider
           pans the horizon off-viewport. Sizes are rounded up to a 128px step so that panning
           and zooming resize the backing store occasionally rather than every frame (setting
           width/height reallocates and clears). */
        const EQ_EXT = screenR * 1.6;
        const eqAccumW = Math.ceil((EQ_EXT * 2) / 128) * 128;
        const eqAccumH = eqAccumW;
        /* origin of the scratch surface in screen space; the stamp at composite time undoes it */
        const eqOx = sx - eqAccumW / 2;
        const eqOy = sy - eqAccumH / 2;
        eqAccumOx = eqOx;
        eqAccumOy = eqOy;

        resizeCanvas(eqAccumCanvas, eqAccumW, eqAccumH);
        resizeCanvas(eqWorkCanvas, eqAccumW, eqAccumH);

        eqAccumCtx.clearRect(0, 0, eqAccumW, eqAccumH);
        const eqOff = eqWorkCanvas;
        const eqCtx = eqWorkCtx;
        const esx = sx - eqOx;
        const esy = sy - eqOy;

        for (const eq of live.current.equators) {
          const eqSpan = Math.PI * eq.span;
          const eqCoreLW = screenR * 0.048 * eq.width;
          const eqRb = ehRb * eq.squash;
          const eqRa = ehRa * (eq.squashX ?? 1);
          const eqOp = eq.opacity;
          const eqPulse = eq.pulse > 0 ? pulse : 1;
          eqCtx.clearRect(0, 0, eqOff.width, eqOff.height);

          for (const eqA of eq.angles) {
            eqCtx.save();
            eqCtx.strokeStyle = `rgba(${haloRgb},${(0.18 * eqPulse * eqOp).toFixed(2)})`;
            eqCtx.lineWidth = eqCoreLW * 2.2;
            eqCtx.beginPath();
            eqCtx.ellipse(esx, esy, eqRa, eqRb, ehRot, eqA - eqSpan, eqA + eqSpan);
            eqCtx.stroke();
            eqCtx.restore();
            eqCtx.save();
            eqCtx.strokeStyle = `rgba(${haloRgb},${(0.55 * eqPulse * eqOp).toFixed(2)})`;
            eqCtx.lineWidth = eqCoreLW * 1.1;
            eqCtx.beginPath();
            eqCtx.ellipse(esx, esy, eqRa, eqRb, ehRot, eqA - eqSpan, eqA + eqSpan);
            eqCtx.stroke();
            eqCtx.restore();
            eqCtx.save();
            eqCtx.strokeStyle = `rgba(${haloRgb},${(0.88 * eqPulse * eqOp).toFixed(2)})`;
            eqCtx.lineWidth = eqCoreLW;
            eqCtx.beginPath();
            eqCtx.ellipse(esx, esy, eqRa, eqRb, ehRot, eqA - eqSpan, eqA + eqSpan);
            eqCtx.stroke();
            eqCtx.restore();
          }

          const fadeStart = {
            x: gx0 - poleUpDx * fadeSize - eqOx,
            y: gy0 - poleUpDy * fadeSize - eqOy,
          };

          const fadeEnd = { x: gx1 - eqOx, y: gy1 - eqOy };
          const fadeDist = Math.hypot(fadeEnd.x - fadeStart.x, fadeEnd.y - fadeStart.y);

          if (fadeDist > 1) {
            const fg = eqCtx.createLinearGradient(fadeStart.x, fadeStart.y, fadeEnd.x, fadeEnd.y);
            fg.addColorStop(0, "rgba(0,0,0,1)");
            fg.addColorStop(1, "rgba(0,0,0,0)");
            eqCtx.save();
            eqCtx.globalCompositeOperation = "destination-in";
            eqCtx.fillStyle = fg;
            eqCtx.fillRect(0, 0, eqOff.width, eqOff.height);
            eqCtx.restore();
          }

          eqAccumCtx.drawImage(eqOff, 0, 0);
        }

        /* The jet-exit hotspot used to render here — a radial gradient at the bottom of the
           horizon ellipse, clipped to the lower half-plane. It read as a bright crescent
           smeared across the sphere rather than as a glow behind it, so it's gone. The
           equator rings alone carry the corona. */

        // Composite
        glowCtx.clearRect(0, 0, cw, ch);
        glowCtx.drawImage(eqAccumCanvas, eqAccumOx, eqAccumOy);

        // Punch out sphere
        glowCtx.save();
        glowCtx.globalCompositeOperation = "destination-out";
        glowCtx.fillStyle = "rgba(0,0,0,1)";
        glowCtx.beginPath();
        glowCtx.arc(massSx, massSy, jetScreenR, 0, Math.PI * 2);
        glowCtx.fill();
        glowCtx.restore();
      };

      const drawSky = (W: number, H: number, bgHex: string, isLightTheme: boolean) => {
        const sky = document.createElement("canvas");
        sky.width = Math.max(2, Math.round(W));
        sky.height = Math.max(2, Math.round(H));
        const sctx = sky.getContext("2d");

        if (!sctx) {
          return null;
        }

        sctx.fillStyle = bgHex;
        sctx.fillRect(0, 0, sky.width, sky.height);
        const area = sky.width * sky.height;

        const cool = "206,223,255";
        const warm = "255,236,205";

        const neutral = isLightTheme ? "70,74,86" : "255,255,255";
        const skyDim = isLightTheme ? 0.5 : 1;

        const skyColor = (h: number) => {
          if (h < 0.12) {
            return warm;
          }

          if (h < 0.24) {
            return cool;
          }

          return neutral;
        };

        const tiers = [
          // anchors
          { n: area / 13_000, opMax: 1, rMax: 1.6, rMin: 0.9 },
          // field
          { n: area / 4200, opMax: 0.6, rMax: 1, rMin: 0.6 },
          // dust
          { n: area / 2100, opMax: 0.32, rMax: 0.7, rMin: 0.4 },
        ];

        for (const t of tiers) {
          for (let i = 0; i < t.n; i += 1) {
            const h = srnd();
            const rgb = skyColor(h);
            const op = (0.35 + srnd() * 0.65) * t.opMax * skyDim;
            sctx.fillStyle = `rgba(${rgb},${op.toFixed(3)})`;
            sctx.beginPath();
            sctx.arc(
              srnd() * sky.width,
              srnd() * sky.height,
              t.rMin + srnd() * (t.rMax - t.rMin),
              0,
              TAU,
            );
            sctx.fill();
          }
        }

        const skyTex = new THREE.CanvasTexture(sky);
        skyTex.colorSpace = THREE.SRGBColorSpace;

        return skyTex;
      };

      const build = () => {
        const W = canvas.offsetWidth;
        const H = canvas.offsetHeight;
        srnd = createRandom();
        CAM_FOV = BASE_FOV / live.current.scale;

        /* The renderer is reused across rebuilds now, so it no longer takes the old scene's GPU
           resources down with it — drop them here instead, or every theme switch leaks a full
           disk's worth of geometries and materials. */
        disposeScene(scene, THREE);

        /* read live theme colors at build time */
        const cs_ = getComputedStyle(document.documentElement);
        const bgHex = cs_.getPropertyValue("--xrio-bg").trim() || "#000000";
        const ac1Hex = cs_.getPropertyValue("--xrio-accent-fill").trim() || "#3B82F6";
        const ac2Hex = cs_.getPropertyValue("--xrio-accent2").trim() || "#F59E0B";
        const bgC = new THREE.Color(bgHex);
        const ac1C = new THREE.Color(ac1Hex);
        const ac2C = new THREE.Color(ac2Hex);
        const fgHex = cs_.getPropertyValue("--xrio-fg").trim() || "#c6d8ee";
        const fgC = new THREE.Color(fgHex);
        const bgLuma = 0.2126 * bgC.r + 0.7152 * bgC.g + 0.0722 * bgC.b;
        const isLightTheme = bgLuma > 0.5;

        /* ── DISK COMPOSITING ───────────────────────────────────────────────────────────────
           The disk's depth comes entirely from *accumulation*: thousands of faint strands
           overlap, and where many pile up the result is denser than where few do. That density
           gradient is the only depth cue in the render — there is no occlusion to lean on,
           because the bands already draw in front of the horizon.

           Additive gives that for free on a dark ground: strands sum toward white, identity is 0
           (black), so a strand contributing nothing is invisible. The light-theme dual is
           MULTIPLY, not subtract: SubtractiveBlending is dst*(1-src) and renders the complement
           of whatever color you feed it (brass would come out blue-grey), whereas
           MultiplyBlending is dst*src, which preserves hue and accumulates *downward* — exactly
           how ink compounds on paper. Identity flips to 1 (white), so the whole dark-theme colour
           path maps over with `c -> 1 - c` and `+ -> *`, sharing one taperExp.

           Two non-obvious requirements, both learned the hard way:

           1. three.js gates MultiplyBlending behind material.premultipliedAlpha. Without it
              WebGLState logs a warning and the blend silently does not apply.

           2. The numeric mirror alone is invisible. Perceptual contrast is not symmetric about
              the two grounds — near black, additive wins large apparent range from tiny deltas,
              while near white 1.0 -> 0.97 reads as nothing at all. So the light path needs a
              gain on top of the mirror. LIGHT_GAIN below is that correction, not a fudge; it is
              the reason the shipped NormalBlending attempt reached for high per-strand opacity
              TIERS instead, which could not work because tier opacity is a per-material constant
              and therefore carries no information about overlap. */
        const diskBlending = isLightTheme ? THREE.MultiplyBlending : THREE.AdditiveBlending;
        /* Tuned by eye. Below ~2 the disk is a ghost; by ~8 the stipple starts closing up and
           the outer field loses its falloff.

           Measured over the disk region at 2 / 2.5 / 3: the densest 2% of pixels carry 37 / 46 /
           55 units of ink while the sparse field's median stays pinned at 0.28 and nothing clips.
           So in this range the gain is a linear *exposure* control, not a contrast shaper — it
           scales how present the disk is without changing its signal-to-noise. Pick it by how
           much the disk should compete with the hero copy. Below ~2 the rim loses definition and
           the void stops reading as a hole; above ~6 the field starts closing up. 3 keeps the rim
           articulated. Re-tune if the framing changes — a different crop puts a different amount
           of dense rim on screen, which shifts what the right exposure is. */
        const LIGHT_GAIN = 3;

        /* Dominant disk colour (94.5% of spawns) is the ink on both themes — under multiply the
           vertex colour carries *darkening power*, so fg is what the 1-(1-c) mapping below turns
           into a near-paper multiplicand. Feeding brass here instead tints the whole field sepia,
           which is a live alternative, but it costs contrast: brass has less darkening power than
           ink, so it needs a higher LIGHT_GAIN to reach the same depth. */
        const diskFg = fgC;
        /* Rare glint spawns. On dark these are accent (gold) and accent2 (near-white) against a
           white field. On light the polarity flips: nothing can darken past the ink field, so the
           glint's job becomes hue rather than weight, and a warm 4% reads as flecks in a grey
           engraving. The fleck is accent-FILL, the CTA's yellow, so the hero's figure carries the
           same yellow as the button below it — the mark accent was tried here first and rendered
           as long olive scratch lines, because a colour held down to 4.5:1 as text has no hue left
           once multiply takes its cut. Zero ACCENT_FLECKS to take the accent out of the art
           entirely. */
        const ACCENT_FLECKS = true;
        const lightAccent = ACCENT_FLECKS ? ac1C : fgC;
        const diskAc1 = isLightTheme ? lightAccent : new THREE.Color("#D6BD82");
        const diskAc2 = isLightTheme ? fgC : ac2C;

        const arcColor = (roll: number) => {
          if (roll < 0.045) {
            return diskAc1;
          }

          if (roll < 0.06) {
            return diskAc2;
          }

          return diskFg;
        };

        /* Halo material color (equator rings) — accent2, the same token the disk uses, so the two
           stay one material. The corona is an opaque 2D stroke while the disk is thousands of
           mixed-toward-bg strands, so identical input color still renders the ring as the more
           saturated gold of the two; this constant is the correction for that.

           Signed: positive pulls toward fg-ink (darker), negative toward the page (lighter), with
           0 meaning straight brass at the disk's 1.61:1 ceiling. Darker was tried first and
           overshot — at +0.45 (2.67:1) the ring stopped reading as metal seen edge-on and became a
           drawn outline around the horizon. Going the other way keeps it unmistakably brass and
           lets it sit as a highlight rather than a border.

           NB: these are linear floats, not sRGB bytes — linear mixing weights the light end, so
           magnitudes here run larger than the sRGB equivalent. Don't port the number across spaces. */
        const HALO_INK_MIX = isLightTheme ? -0.2 : 0;
        const haloTarget = HALO_INK_MIX >= 0 ? fgC : bgC;
        const halo = (isLightTheme ? ac1C : ac2C).clone().lerp(haloTarget, Math.abs(HALO_INK_MIX));
        haloRgb = `${Math.round(halo.r * 255)},${Math.round(halo.g * 255)},${Math.round(halo.b * 255)}`;

        scene = new THREE.Scene();
        /* ── SKY ──
           Static procedural starfield as the backdrop, echoing the GPU hero's sky. Three density
           tiers (bright anchors, mid field, faint dust) over --xrio-bg, with a few warm/cool tints.
           Painted once per build to a CanvasTexture; no per-frame cost and no interaction, by
           request. Re-baked on theme/resize because build() re-runs then (and disposes the old one
           above). Uses the same srnd() stream, so it is deterministic per bake. */
        scene.background = drawSky(W, H, bgHex, isLightTheme);

        /* Record the exact theme this bake was made against, in the same format frame() builds
           its live signature in. If these ever drift apart frame() re-runs build(). Must stay in
           sync with the liveSig construction below or the disk rebuilds on every single frame. */
        lastBgHex = `${bgHex}|${fgHex}|${ac1Hex}|${ac2Hex}`;

        camera = new THREE.PerspectiveCamera(CAM_FOV, W / H, 1, 300_000);

        /* Reuse the renderer across rebuilds. Constructing a fresh WebGLRenderer on the same
           canvas every time is wasteful on a theme change, and outright fragile right after a
           context restore — the old GL context is already gone, and disposing/recreating against
           the new one is a good way to end up with a canvas that never paints again. */
        activeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
        /* updateStyle MUST be false. setSize's default writes inline style.width/height in px on
           the canvas, and an inline style beats the `w-full h-full` classes — so the canvas pinned
           itself to whatever size it first built at and never grew again. build() then reads that
           frozen offsetWidth, so the lock was self-sustaining: resizing the window past the
           initial size left the disk rendering at the old dimensions inside a larger hero, with
           its glow overlay (a plain 2D canvas, correctly sized) sliding out of registration. */
        activeRenderer.setSize(W, H, false);

        const halfW = Math.tan((CAM_FOV * 0.5 * Math.PI) / 180) * CAM_Z * (W / H);
        const DX = halfW * 0.5;
        /* Horizontal framing. shift% of screen width → world units (halfW*2 = full world width
           on screen). Mobile pans the void further into the copy column; folded in here rather
           than recomputed per frame, since it only ever changes on resize — which rebuilds. */
        const mobileShift = W > 0 && W < 768 ? 200 : 0;
        const lookAtX = -((live.current.shift + mobileShift) / 100) * halfW * 2;
        camera.position.set(CAM_X, CAM_Y, CAM_Z);
        camera.lookAt(lookAtX, 0, 0);

        /* ── VERTICAL ANCHOR ────────────────────────────────────────────────────────────────
           Pin the horizon's centre to anchorY (a fraction of canvas height) with a lens shift
           rather than by moving the camera.

           A lens shift adds a constant offset to clip.y proportional to clip.w, which translates
           the projected image in NDC without rotating the camera. That matters: the disk's tilt
           and foreshortening are tuned against this exact camera orientation, and re-aiming the
           camera to hit a vertical target would change the apparent ellipse as a side effect.
           Shifting the frustum moves the image and leaves the perspective alone.

           elements[] is column-major, so index 9 is row 1 / column 2 — the term that multiplies
           view-space z into clip.y. Setting it to k yields ndc.y' = ndc.y - k, hence the negated
           delta below. The projection matrix is built once at construction and nothing else calls
           updateProjectionMatrix(), so this survives for the life of the camera; drawCorona()
           projects through the same matrix, which keeps the glow overlay in registration. */
        camera.updateMatrixWorld(true);
        /* Screen-aligned tilt axes: the camera's own right (X) and up (Y) in world space. Extracted
           here because the camera orientation is fixed for the life of a build. */
        camera.matrixWorld.extractBasis(camRight, camUp, _camDir);
        const horizonNdc = new THREE.Vector3(DX, 50, 0).project(camera);
        const targetNdcY = 1 - 2 * live.current.anchorY;
        camera.projectionMatrix.elements[9] -= targetNdcY - horizonNdc.y;
        massMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(bgHex) });

        const mass = new THREE.Mesh(new THREE.SphereGeometry(MASS_WR, 64, 32), massMat);

        mass.position.set(DX, 50, 0);
        scene.add(mass);
        massWorldPos.copy(mass.position);

        /* Void centre in viewport fractions (through the same camera incl. lens shift), used as the
           tilt control's origin. */
        _ndcVec.copy(massWorldPos).project(camera);
        diskFx = _ndcVec.x * 0.5 + 0.5;
        diskFy = -_ndcVec.y * 0.5 + 0.5;

        lineMaterials = [];
        /* diskTilt holds the pivot and the mouse tilt (identity rotation here, set each frame);
           diskRoot holds the disk's fixed roll. Keeping them on separate groups is what lets the
           tilt stay screen-aligned instead of compounding with DISK_TILT. */
        diskTilt = new THREE.Group();
        diskTilt.position.set(DX, 50, 0);
        scene.add(diskTilt);
        diskRoot = new THREE.Group();
        diskRoot.rotation.z = DISK_TILT;
        diskTilt.add(diskRoot);

        const halfH = halfW / (W / H);
        const maxR = Math.hypot(halfW * 2.2, halfH * 4) * 1.25;

        const bR = Array.from(
          { length: N_BANDS + 1 },
          (_, i) => MASS_WR * 1.04 + (i / N_BANDS) ** 1.6 * (maxR - MASS_WR * 1.04),
        );

        bands = [];

        const addBand = (
          { y: yOff, exp: densExp, scale: opScale, rScale }: (typeof PLANES)[number],
          bi: number,
        ) => {
          const rMin = bR[bi] * rScale;
          const rMax = bR[bi + 1] * rScale;
          const rMid = (rMin + rMax) * 0.5;
          const omega = BASE_OMEGA / (rMid / MASS_WR) ** 2;

          const bandWeight = (1 - bi / N_BANDS) ** 1.4;
          const arcCount = Math.ceil(ARCS_PB * (0.88 + 1.1 * bandWeight));
          const normDist = Math.min(1, (rMid - MASS_WR) / (maxR - MASS_WR));
          const radialFall = (1 - normDist * 0.99) ** 6;
          /* Mid-radius glow bump — the middle rings read brighter than a plain inner→outer
               falloff would give. Gaussian centred at normDist 0.5. */
          const midGlow = 1 + 8.5 * Math.exp(-(((normDist - 0.4) / 0.3) ** 2));

          /* LineMaterial has no true per-vertex alpha (vertex colours are RGB only) and its
               opacity is a flat per-material scalar, so per-strand visibility is baked into the
               vertex colour on both themes — brightness on dark, darkening power on light. */
          const pos: number[] = [];
          const col: number[] = [];

          const appendArc = () => {
            let r = rMin + srnd() ** densExp * (rMax - rMin);
            r += rnd(-0.22, 0.22) * (rMax - rMin);
            r = Math.max(MASS_WR * 1.03, Math.min(maxR * rScale, r));

            const sv = srnd();
            let span;

            if (sv < 0.4) {
              span = rnd(0.07, 0.5);
            } else if (sv < 0.74) {
              span = rnd(0.5, 1.55);
            } else if (sv < 0.91) {
              span = rnd(1.55, 2.55);
            } else {
              span = rnd(2.55, 3.25);
            }

            span = Math.min(span * spanMult, Math.PI * 1.9);

            const theta = rnd(0, TAU);
            /* spark colour: 8% gold accent, +1.5% accent2 (near-white), rest fg. Gold strands get
                 an opacity boost so they ride above the bright white field instead of washing out. */
            const sparkR = srnd();
            const isGold = sparkR < 0.045;

            const baseOp =
              (srnd() < 0.028 ? rnd(0.28, 0.6) : rnd(0.08, 0.22)) *
              opScale *
              radialFall *
              midGlow *
              (isGold ? 1.1 : 1);

            const { r: cr, g: cg, b: cb } = arcColor(sparkR);
            const segs = Math.max(4, Math.min(52, Math.ceil((r * span) / 2)));

            const bPos = pos;
            const bCol = col;

            for (let s = 0; s < segs; s += 1) {
              const t1 = theta + (s / segs) * span;
              const t2 = theta + ((s + 1) / segs) * span;
              bPos.push(
                r * Math.cos(t1),
                0,
                r * Math.sin(t1),
                r * Math.cos(t2),
                0,
                r * Math.sin(t2),
              );
              const f1 = (1 - s / segs) ** taperExp;
              const f2 = (1 - (s + 1) / segs) ** taperExp;

              if (isLightTheme) {
                /* Exact polarity mirror of the dark branch: additive builds up from 0 (black),
                     multiply builds down from 1 (white), so the same taperExp applies and it is
                     the strand's darkening power (1 - c) that gets scaled instead of c itself.
                     LIGHT_GAIN corrects for the asymmetric perceptual range of the two grounds. */
                const k1 = Math.min(1, baseOp * f1 * LIGHT_GAIN);
                const k2 = Math.min(1, baseOp * f2 * LIGHT_GAIN);
                bCol.push(
                  1 - (1 - cr) * k1,
                  1 - (1 - cg) * k1,
                  1 - (1 - cb) * k1,
                  1 - (1 - cr) * k2,
                  1 - (1 - cg) * k2,
                  1 - (1 - cb) * k2,
                );
              } else {
                bCol.push(
                  cr * baseOp * f1,
                  cg * baseOp * f1,
                  cb * baseOp * f1,
                  cr * baseOp * f2,
                  cg * baseOp * f2,
                  cb * baseOp * f2,
                );
              }
            }
          };

          for (let ai = 0; ai < arcCount; ai += 1) {
            appendArc();
          }

          /* Mid-band thickening — strands run slightly fatter through the middle rings, thinning
               back toward the inner rim and the outer field. */
          const midT = 1 - Math.abs(bi - (N_BANDS - 1) / 2) / ((N_BANDS - 1) / 2);
          const bandLineW = (2 - (bi / (N_BANDS - 1)) * 0.8) * (1 + 0.45 * midT);

          const geo = new LineSegmentsGeometry();
          geo.setPositions(new Float32Array(pos));
          geo.setColors(new Float32Array(col));

          const mat = new LineMaterial({
            blending: diskBlending,
            depthTest: true,
            depthWrite: false,
            linewidth: bandLineW,
            opacity: isLightTheme ? 1 : 0.6,
            /* Required for MultiplyBlending — see DISK COMPOSITING above. */
            premultipliedAlpha: isLightTheme,
            resolution: new THREE.Vector2(W, H),
            transparent: true,
            vertexColors: true,
            worldUnits: true,
          });

          const lines = new LineSegments2(geo, mat);
          lines.position.set(0, yOff, 0);
          diskRoot.add(lines);
          bands.push({ lines, omega });
          lineMaterials.push(mat);

          /* One material per band on both themes. Material opacity is not a fade under
               multiply — it lerps the source toward black, which darkens rather than dissolves —
               so light bakes its strength into the vertex colour and leaves this at 1. */
        };

        for (const plane of PLANES) {
          for (let bi = 0; bi < N_BANDS; bi += 1) {
            addBand(plane, bi);
          }
        }
      };

      const frame = (ts: number) => {
        const dt = ts0 ? Math.min(ts - ts0, 40) : 0;
        ts0 = ts;

        /* Everything theme-dependent — blend mode, per-vertex disk colors, opacity tiers — is
           baked into GPU buffers by build(). If build() ever runs while --xrio-bg reads stale or
           empty it falls back to #000000, computes isLightTheme=false, and bakes the whole disk
           in dark-theme mode: additive blending with near-white lines. Additive white over cream
           is a no-op, so the canvas reads as blank/black even once the backdrop is corrected.
           Patching scene.background alone therefore fixes the ellipse but not the disk.
           Compare the live theme signature against what we actually baked, and rebuild on drift
           so the geometry regenerates in the right mode. One getComputedStyle read per frame;
           the string compare means a rebuild only fires when something genuinely changed. */
        const cs__ = getComputedStyle(document.documentElement);
        const liveBg_ = cs__.getPropertyValue("--xrio-bg").trim();
        const liveFg_ = cs__.getPropertyValue("--xrio-fg").trim();
        const liveA1_ = cs__.getPropertyValue("--xrio-accent-fill").trim();
        const liveA2_ = cs__.getPropertyValue("--xrio-accent2").trim();

        /* Only compare when all four actually resolve. build() substitutes hardcoded fallbacks
           for empty vars, so a partially-resolved read here would never equal the stored
           signature and would rebuild the entire disk on every frame.

           EVERY VAR build() BAKES FROM IS LISTED HERE, in build()'s own order. The pair was
           bg|fg|accent2 on both sides until the disk's flecks were re-routed to the fill: the
           live read moved to --xrio-accent-fill and the bake's did not, so the two strings
           could never be equal on any palette and build() ran once per frame. That does not
           look like a slow page — it looks like a STOPPED one, because each rebuild starts the
           bands at rotation 0, so the disk holds still while burning a full rebake per frame. */
        const liveSig =
          liveBg_ && liveFg_ && liveA1_ && liveA2_
            ? `${liveBg_}|${liveFg_}|${liveA1_}|${liveA2_}`
            : "";

        if (liveSig && liveSig !== lastBgHex) {
          lastBgHex = liveSig;
          bands = [];
          _lastCw = 0;
          _lastCh = 0;
          build();
        }

        for (const { lines, omega } of bands) {
          lines.rotation.y += omega * dt;
        }

        /* Ease the disk tilt toward the mouse target with a critically-damped spring (SmoothDamp),
           then rotate diskTilt about the camera's right (vertical mouse → pitch) and up (horizontal
           mouse → yaw) axes. The spring starts from rest and decelerates in — gentle start, clean
           finish — unlike exponential smoothing, which is fastest at the start and drags on a long
           tail. No overshoot. */
        {
          const dts = Math.max(1e-3, dt / 1000);
          const omega = 2 / TILT_SMOOTH;
          const xo = omega * dts;
          const expf = 1 / (1 + xo + 0.48 * xo * xo + 0.235 * xo * xo * xo);
          let ch = tiltX - tiltTX;
          let tmp = (tiltVX + omega * ch) * dts;
          tiltVX = (tiltVX - omega * tmp) * expf;
          tiltX = tiltTX + (ch + tmp) * expf;
          ch = tiltY - tiltTY;
          tmp = (tiltVY + omega * ch) * dts;
          tiltVY = (tiltVY - omega * tmp) * expf;
          tiltY = tiltTY + (ch + tmp) * expf;
          _qTilt.setFromAxisAngle(camUp, tiltX * TILT_YAW);
          _qTmp.setFromAxisAngle(camRight, tiltY * TILT_PITCH);
          diskTilt.quaternion.copy(_qTilt.multiply(_qTmp));
        }

        /* No camera aiming here. build() sets position, lookAt and the vertical lens shift, and
           none of those inputs can change without a rebuild — so re-aiming every frame only
           repeated the same trig, and would now also discard the lens shift's registration. */
        activeRenderer.render(scene, camera);
        drawCorona(ts);
        raf = requestAnimationFrame(frame);
      };

      const observer = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting) {
            if (contextLost) {
              return;
              /* nothing to draw into until the context comes back */
            }

            ts0 = 0;
            raf = requestAnimationFrame(frame);
          } else {
            cancelAnimationFrame(raf);
          }
        },
        { threshold: 0.01 },
      );

      observer.observe(host);

      /* build() rebakes 18 bands x 82 arcs x 3 planes and re-runs setSize, and this used to run
         once per resize event — dozens of full rebuilds per second while a window is dragged.
         It was masked for as long as setSize's inline styles pinned the canvas to its first
         size (see CANVAS SIZING in build()); now that the canvas really does track its box, the
         rebuilds are real. Trailing debounce: the drawing buffer keeps its old size for the
         duration of the gesture, which the browser scales to fit, and exactly one rebuild lands
         when the drag stops. The animation is left running rather than cancelled per event. */
      let resizeTimer: ReturnType<typeof setTimeout> | undefined;

      const onResize = () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (contextLost) {
            return;
          }

          cancelAnimationFrame(raf);
          bands = [];
          _lastCw = 0;
          /* force corona canvas resize on next frame */
          _lastCh = 0;
          build();
          ts0 = 0;
          raf = requestAnimationFrame(frame);
        }, 150);
      };

      window.addEventListener("resize", onResize);

      /* Mouse target for the disk parallax. Window-wide so the tilt tracks the cursor even over the
         copy column. No-op without a mouse (touch never fires it), so no coarse-pointer guard. */
      const onMouseTilt = (e: MouseEvent) => {
        /* Measured from the void, not the screen centre, and clamped — the disk can sit nearer one
           edge than the other, so the far side would otherwise swing past the near side's range. */
        tiltTX = cl((e.clientX / window.innerWidth - diskFx) * 2);
        tiltTY = cl((e.clientY / window.innerHeight - diskFy) * 2);
      };

      window.addEventListener("mousemove", onMouseTilt);

      /* The browser can drop the WebGL context on its own — compositor pressure, GPU memory
         reclaim, or the layer being discarded while scrolled out of view. Every GPU-side buffer,
         program and material goes with it, so rendering afterwards paints default/black state
         (the mass sphere included) and never recovers, because build() only ever runs on mount,
         resize, or a theme change. Catch the loss, stop drawing, and rebuild once it's restored.
         preventDefault() is required — without it the browser never fires contextrestored. */
      const onContextLost = (e: Event) => {
        e.preventDefault();
        contextLost = true;
        cancelAnimationFrame(raf);
      };

      const onContextRestored = () => {
        contextLost = false;
        bands = [];
        _lastCw = 0;
        _lastCh = 0;
        /* re-reads live theme vars, so colors come back correct for the active palette */
        build();
        ts0 = 0;
        raf = requestAnimationFrame(frame);
      };

      canvas.addEventListener("webglcontextlost", onContextLost);
      canvas.addEventListener("webglcontextrestored", onContextRestored);

      build();
      /* IntersectionObserver controls the first RAF start — no unconditional start here */

      /* Rebuild camera geometry when the context inputs change. */
      rebuildRef.current = () => {
        cancelAnimationFrame(raf);

        if (contextLost) {
          return;
          /* onContextRestored will rebuild with the current theme */
        }

        bands = [];
        _lastCw = 0;
        _lastCh = 0;
        build();
        ts0 = 0;
        raf = requestAnimationFrame(frame);
      };

      _cleanupFn = () => {
        cancelAnimationFrame(raf);
        clearTimeout(resizeTimer);
        observer.disconnect();
        window.removeEventListener("resize", onResize);
        window.removeEventListener("mousemove", onMouseTilt);
        canvas.removeEventListener("webglcontextlost", onContextLost);
        canvas.removeEventListener("webglcontextrestored", onContextRestored);
        rebuildRef.current = null;
        disposeScene(scene, THREE);
        glowCanvas.remove();
      };
    };

    void init();

    return () => {
      disposed = true;
      _cleanupFn?.();
      renderer?.dispose();
    };
  }, []);

  return (
    <div
      className="bh-wrap absolute inset-0 pointer-events-none z-0"
      aria-hidden="true"
      style={{ opacity }}
    >
      <canvas
        ref={canvasRef}
        id="hero-canvas"
        aria-hidden="true"
        className="absolute inset-0 w-full h-full pointer-events-none"
      />
    </div>
  );
};
