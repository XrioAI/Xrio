// Browser lifecycle for the baked black-hole pipeline. VGPU stays dynamically imported.

import type { Frame, Gpu, Surface } from "vgpu";

import type { VgpuApi, Effects, Targets } from "./pipeline";
import {
  createEffects,
  createTargets,
  destroyTargets,
  prewarm,
  renderChain,
  setBakeUniforms,
  setBindings,
  setPostUniforms,
  setShadeUniforms,
} from "./pipeline";
import { defaultHeroSettings } from "./settings";
import type { HeroSettings, Rgb } from "./settings";

/* Ink ramp exponent for light palettes — see composite.wgsl. 2.2 measured against light Mono:
   it drops the 0.05-0.20 haze band (12% of the frame) to within a couple of levels of paper and
   leaves the disk's bright core, which tops out near 0.94, almost untouched. Raise it if the
   disk still smudges the paper; lower it if the outer disk loses too much body. */
const LIGHT_INK_GAMMA = 2.2;

/* Brightest luma the tonemapped scene actually produces, measured off the rendered frame. The
   ACES curve plus the vignette leave the peak here rather than at 1.0, so the duotone ramp stops
   short of its ink endpoint; params.z divides it back out. Re-measure if the disk or bloom
   settings change materially. */
const SCENE_PEAK_LUMA = 0.94;

/* fov at scale 1 — see the framing note in settings.ts for how it was picked. */
const BASE_FOV = 2.5;

/* How long the canvas box has to hold still before the render targets are rebuilt. Every rebuild
   allocates the whole set — ~68 MB at 1440x900, the G-buffer being four full-res attachments — so
   doing it per animation frame while a window edge is dragged churns that ~60x a second. The
   stale targets keep rendering in the meantime; they are only the wrong resolution, which is a
   soft frame during a drag against an allocator stall. */
const RESIZE_SETTLE_MS = 120;

const SCENE_YAW_TAU_S = 0.325;

const MAX_FRAME_DT_S = 0.1;

const TARGET_FPS = 60;

const FRAME_PACING_EPSILON_MS = 2;

const MIN_FRAME_INTERVAL_MS = 1000 / TARGET_FPS - FRAME_PACING_EPSILON_MS;

const MOBILE_QUERY = "(max-width: 767px)";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/* ── MOBILE ──
   Below md the hero does not run full-bleed behind the copy: it is a square figure in flow under
   the CTA, which is the slot BlackholeFigure (Canvas 2D) used to fill. These are that figure's
   own constants converted to this camera, so the replacement lands where the old one did rather
   than on numbers invented for it:

     centerY   0.18  <- CENTER_Y_FRAC 0.41, the figure's vertical anchor as a fraction of box
                        height, through the same ndc.y = 1 - 2f the desktop side uses. The figure
                        anchors above centre because a tilted ellipse does not fill its own square
                        bounding box; that reasoning applies here unchanged.
     cameraY   0.456 <- SQUASH 0.44, its projected minor/major ratio. A circle viewed from
                        elevation e projects to sin(e), so e = asin(0.44) = 26.1 deg.
     roll      -0.6  <- TILT, already the disk's on-screen major axis in radians.
     fov       1.41   solved, not guessed: the void's angular radius is fixed by `distance`, and
                        the desktop framing (fov 2.4, void radius ~230px against a 450px
                        half-height) pins tan(theta) = 0.213. HORIZON 0.15 of a square side is
                        0.30 of its half-height, so fov = 0.30 / 0.213. It is far below the
                        desktop value because the square's aspect is 1 against the viewport's
                        1.6, and screenPlane scales x by aspect — the same fov reads much larger
                        in a square. This was briefly raised to 2.2 because 1.41 looked sparse,
                        which it did only because centerFade was still hollowing out the middle
                        of the figure at the time; with that fixed the solved value is right.
   centerX stays 0 (the figure is centred in its box) and mouseYaw 0 (no pointer on a phone).

   centerFade is 0, NOT the 1 the example ships for mobile. That uniform drives centeredCopyFade
   in shade.wgsl, which multiplies the disk to black in a band through the canvas's vertical
   middle — it exists to punch a hole for copy laid over the canvas, which is how the example's
   own mobile layout works. Here the canvas is a standalone square under the copy with nothing on
   top of it, so at 1 it just hollows out the middle of the figure. */
const MOBILE_LAYOUT = {
  cameraRoll: -0.6,
  cameraY: 0.456,
  centerFade: 0,
  centerX: 0,
  centerY: 0.18,
  /* The canvas is a square in flow here, not full-bleed, so the render has to stop being a
     rectangle before it reaches the border. See composite.wgsl. */
  edgeFade: 1,
  fov: 1.41,
  mouseYaw: 0,
} as const;

interface RendererOptions {
  canvas: HTMLCanvasElement;
  /** Called if the GPU goes away — at init, mid-frame, or on device loss. The host swaps in the
      Canvas 2D figure. Distinct from the `ready` rejection, which can only fire before init
      finishes; device loss happens long after that promise has settled. */
  onFailure?: (error: Error) => void;
}

interface RenderSize {
  width: number;
  height: number;
}

const relativeLuma = ([r, g, b]: Rgb): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const clockMs = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

const startPacedLoop = (render: () => void) => {
  let stopped = false;

  let frameHandle = 0;
  let lastPresentedAt: number | undefined;

  const tick = (timestamp: number): void => {
    if (stopped) {
      return;
    }

    if (lastPresentedAt === undefined || timestamp - lastPresentedAt >= MIN_FRAME_INTERVAL_MS) {
      lastPresentedAt = timestamp;

      render();
    }

    if (!stopped) {
      frameHandle = requestAnimationFrame(tick);
    }
  };

  frameHandle = requestAnimationFrame(tick);

  return {
    stop(): void {
      stopped = true;
      cancelAnimationFrame(frameHandle);
    },
  };
};

const readPaletteColor = (paletteProbe: HTMLSpanElement, token: string, fallback: string): Rgb => {
  paletteProbe.style.color = fallback;
  paletteProbe.style.color = `var(${token}, ${fallback})`;
  const parts = getComputedStyle(paletteProbe).color.match(/[\d.]+/gu);

  if (!parts || parts.length < 3) {
    return [0, 0, 0];
  }

  return [Number(parts[0]) / 255, Number(parts[1]) / 255, Number(parts[2]) / 255];
};

const applyPalette = (settings: HeroSettings, paletteProbe: HTMLSpanElement) => {
  settings.ground = readPaletteColor(paletteProbe, "--xrio-bg", "#000000");
  settings.ink = readPaletteColor(paletteProbe, "--xrio-fg", "#ffffff");
  /* Which scheme is live, read off the two colours rather than off data-scheme: the exponent
       exists to compensate for a bright ground, so deriving it from the ground means it cannot
       disagree with the colours it is correcting. */
  const lightScheme = relativeLuma(settings.ground) > relativeLuma(settings.ink);
  settings.inkGamma = lightScheme ? LIGHT_INK_GAMMA : 1;
  settings.inkGain = lightScheme ? 1 / SCENE_PEAK_LUMA ** LIGHT_INK_GAMMA : 1;
};

const rad = (deg: number) => (deg * Math.PI) / 180;

const applyResponsiveLayout = (
  settings: HeroSettings,
  mobileQuery: MediaQueryList,
  desktopLayout: Pick<HeroSettings, keyof typeof MOBILE_LAYOUT>,
) => {
  Object.assign(settings, mobileQuery.matches ? MOBILE_LAYOUT : desktopLayout);
};

export const createRenderer = ({ canvas, onFailure }: RendererOptions) => {
  const settings = defaultHeroSettings();

  /* Every key MOBILE_LAYOUT sets has to appear here too, or switching to mobile and back would
     leave the mobile value behind on whatever this omits. */
  const desktopLayout = {
    cameraRoll: settings.cameraRoll,
    cameraY: settings.cameraY,
    centerFade: settings.centerFade,
    centerX: settings.centerX,
    centerY: settings.centerY,
    edgeFade: settings.edgeFade,
    fov: settings.fov,
    mouseYaw: settings.mouseYaw,
  };

  const mobileQuery = window.matchMedia(MOBILE_QUERY);
  /* The Canvas 2D figure this replaced printed once and stood still under reduced motion rather
     than freezing a moving frame. Same contract here: the paced loop never starts, and the scene
     is drawn a single time per change (init, resize, palette, framing). Time never advances, so
     what lands is the settled disk, not a paused animation. */
  const reducedMotionQuery = window.matchMedia(REDUCED_MOTION_QUERY);

  /* ── PALETTE ──
     The composite pass is a duotone ramp between these two colours (composite.wgsl), so tracking
     the theme is just re-reading two tokens: the ground the void and empty sky sit on, and the
     ink the disk burns in. Dark palettes land near black/near-white — the original look, with the
     deepest black lifted to match the section behind the canvas. Light palettes invert it by
     themselves, because --xrio-bg is paper and --xrio-fg is dark.

     getComputedStyle on a throwaway element does the parsing: assigning the var() to `color` and
     reading it back normalises hex, rgb(), rgba() and color-mix() to "rgb(r, g, b)", so this
     follows the palettes wherever they are authored without carrying a colour parser. The
     fallback is written first, so an invalid or missing token leaves it in place. */
  const paletteProbe = document.createElement("span");
  paletteProbe.style.cssText =
    "position:absolute;width:0;height:0;visibility:hidden;pointer-events:none";
  document.body.append(paletteProbe);

  applyResponsiveLayout(settings, mobileQuery, desktopLayout);
  applyPalette(settings, paletteProbe);
  const bloomScale = Math.min(Math.max(window.devicePixelRatio, 1), 2) / 2;
  settings.bloom.radius *= bloomScale;
  settings.bloom.strength *= bloomScale;

  const events = new AbortController();
  let disposed = false;
  let notified = false;

  let api: VgpuApi | undefined;
  let gpu: Gpu | undefined;
  let surface: Surface | undefined;
  let effects: Effects | undefined;
  let targets: Targets | undefined;
  let loop: { stop: () => void } | undefined;
  let observer: ResizeObserver | undefined;
  let intersection: IntersectionObserver | undefined;
  let palette: MutationObserver | undefined;

  let documentVisible = !document.hidden;

  let canvasIntersecting = true;

  let started = false;
  let animationTime = 0;
  let lastFrameAt: number | undefined;
  let resizeTimer = 0;
  let pendingSize: RenderSize | undefined;
  let forceBake = true;
  let pointerXNormalized = 0;
  let currentSceneYaw = 0;
  let lastYawAt: number | undefined;

  const dispose = () => {
    if (disposed) {
      return;
    }

    disposed = true;
    loop?.stop();

    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }

    observer?.disconnect();
    intersection?.disconnect();
    palette?.disconnect();
    paletteProbe.remove();

    events.abort();
    gpu?.dispose();
  };

  const reportFailure = (error: Error): void => {
    if (disposed || notified) {
      return;
    }

    notified = true;
    dispose();
    onFailure?.(error);
  };

  const handleFailure = (error: Error): never => {
    reportFailure(error);
    throw error;
  };

  const advanceAnimationTime = (now: number): number => {
    animationTime += lastFrameAt === undefined ? 0 : Math.max(0, (now - lastFrameAt) / 1000);
    lastFrameAt = now;

    return animationTime;
  };

  const advanceSceneYaw = (now: number): number => {
    if (settings.mouseYaw <= 0) {
      currentSceneYaw = 0;
      lastYawAt = now;

      return 0;
    }

    const dt =
      lastYawAt === undefined ? 0 : Math.min(Math.max((now - lastYawAt) / 1000, 0), MAX_FRAME_DT_S);

    lastYawAt = now;
    const target = pointerXNormalized * Math.max(0, settings.mouseYaw);
    currentSceneYaw += (target - currentSceneYaw) * (1 - Math.exp(-dt / SCENE_YAW_TAU_S));

    return currentSceneYaw;
  };

  const renderFrame = (frame: Frame): void => {
    if (disposed || !effects || !targets || !surface) {
      return;
    }

    const now = clockMs();
    const runBake = forceBake;
    forceBake = false;

    if (runBake) {
      setBakeUniforms(effects, targets, settings);
    }

    setShadeUniforms(effects, targets, settings, advanceAnimationTime(now), advanceSceneYaw(now));
    renderChain(frame, effects, targets, surface, runBake);
  };

  /** One frame, outside the loop. Used for the reduced-motion path and after every change that
      would otherwise wait for a tick that never comes. */
  const renderOnce = (): void => {
    if (disposed || !gpu || !api) {
      return;
    }

    try {
      api.frame(gpu, renderFrame);
    } catch (error) {
      handleFailure(
        error instanceof Error ? error : new Error("WebGPU rendering failed", { cause: error }),
      );
    }
  };

  const reconcileLoop = (): void => {
    if (!started || !gpu || !api) {
      return;
    }

    if (reducedMotionQuery.matches) {
      loop?.stop();
      loop = undefined;

      if (!disposed && documentVisible && canvasIntersecting) {
        renderOnce();
      }

      return;
    }

    const shouldRun = !disposed && documentVisible && canvasIntersecting;

    if (shouldRun === Boolean(loop)) {
      return;
    }

    if (shouldRun) {
      lastFrameAt = undefined;
      lastYawAt = undefined;
      loop = startPacedLoop(renderOnce);
    } else {
      loop?.stop();
      loop = undefined;
    }
  };

  const applyResize = () => {
    resizeTimer = 0;
    const size = pendingSize;
    pendingSize = undefined;

    if (disposed || !size || !gpu || !api || !effects || !targets || !surface) {
      return;
    }

    try {
      const previousTargets = targets;

      const nextTargets = createTargets(api, gpu, [
        Math.max(1, Math.round(size.width)),
        Math.max(1, Math.round(size.height)),
      ]);

      try {
        setBindings(effects, nextTargets);
        setPostUniforms(effects, nextTargets, settings);
      } catch (error) {
        destroyTargets(nextTargets);
        throw error;
      }

      targets = nextTargets;
      destroyTargets(previousTargets);
      forceBake = true;

      if (reducedMotionQuery.matches) {
        renderOnce();
      }
    } catch (error) {
      handleFailure(
        error instanceof Error ? error : new Error("WebGPU rendering failed", { cause: error }),
      );
    }
  };

  const resize = (size: RenderSize) => {
    if (disposed || size.width <= 0 || size.height <= 0) {
      return;
    }

    pendingSize = size;
    /* Trailing, not leading: restart the timer on every observation so the rebuild lands once,
       after the size settles. */
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(applyResize, RESIZE_SETTLE_MS);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") {
      return;
    }

    const width = Math.max(window.innerWidth, 1);
    pointerXNormalized = Math.min(1, Math.max(-1, (event.clientX / width) * 2 - 1));
  };

  const recenterPointer = () => {
    pointerXNormalized = 0;
  };

  const initialize = async () => {
    const onLayoutChange = () => {
      applyResponsiveLayout(settings, mobileQuery, desktopLayout);

      /* edgeFade and the bloom live in the composite pass, which the bake does not touch — without
       this, crossing the breakpoint would keep the old frame's edge treatment. */
      if (effects && targets) {
        setPostUniforms(effects, targets, settings);
      }

      forceBake = true;

      if (reducedMotionQuery.matches) {
        renderOnce();
      }
    };

    mobileQuery.addEventListener("change", onLayoutChange, { signal: events.signal });

    const onMotionPrefChange = () => {
      reconcileLoop();
    };

    reducedMotionQuery.addEventListener("change", onMotionPrefChange, { signal: events.signal });

    const onPointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) {
        recenterPointer();
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        recenterPointer();
      }

      documentVisible = !document.hidden;
      reconcileLoop();
    };

    const vgpu = await import("vgpu");
    const { init } = vgpu;

    if (disposed) {
      return;
    }

    const nextGpu = await init();

    if (disposed) {
      nextGpu.dispose();

      return;
    }

    gpu = nextGpu;
    api = vgpu;

    /* Device loss lands here, not on `ready` — that promise has already resolved by the time a
       driver reset, a laptop wake or a tab-level GPU eviction takes the device away. Without this
       the loop stops on a dead device and the canvas keeps its last frame forever, and on mobile
       that frame IS the figure. Routed through the same path as an init failure so the host swaps
       in the Canvas 2D fallback either way. */
    const watchDeviceLoss = async () => {
      const info = await nextGpu.gpu.lost;

      if (!disposed) {
        reportFailure(new Error(`WebGPU device lost: ${info.reason} — ${info.message}`));
      }
    };

    void watchDeviceLoss();
    nextGpu.onError(reportFailure);
    surface = vgpu.surface(gpu, canvas, { dpr: 1 });
    effects = createEffects(vgpu, gpu);
    targets = createTargets(vgpu, gpu, surface.size);
    setBakeUniforms(effects, targets, settings);
    setShadeUniforms(effects, targets, settings, animationTime, currentSceneYaw);
    setBindings(effects, targets);
    setPostUniforms(effects, targets, settings);
    await prewarm(effects, targets, surface);

    if (disposed) {
      return;
    }

    observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            resize({ height: canvas.clientHeight, width: canvas.clientWidth });
          });
    observer?.observe(canvas);
    /* The theme switch writes --xrio-* as inline style on <html> and flips data-scheme, so
       watching those attributes keeps this decoupled from whatever flips them. Only the composite
       uniforms move, so no re-bake is needed — the next frame picks the new colours up. */
    palette = new MutationObserver(() => {
      applyPalette(settings, paletteProbe);

      if (effects && targets) {
        setPostUniforms(effects, targets, settings);
      }

      if (reducedMotionQuery.matches) {
        renderOnce();
      }
    });
    palette.observe(document.documentElement, {
      attributeFilter: ["style", "data-scheme", "data-palette"],
      attributes: true,
    });
    window.addEventListener("pointermove", onPointerMove, { passive: true, signal: events.signal });
    window.addEventListener("pointerout", onPointerOut, { passive: true, signal: events.signal });
    window.addEventListener("blur", recenterPointer, { signal: events.signal });
    document.addEventListener("visibilitychange", onVisibilityChange, { signal: events.signal });

    if (typeof IntersectionObserver !== "undefined") {
      intersection = new IntersectionObserver(
        (entries) => {
          canvasIntersecting = entries.at(-1)?.isIntersecting ?? canvasIntersecting;
          reconcileLoop();
        },
        { threshold: 0 },
      );
      intersection.observe(canvas);
    }

    resize({ height: canvas.clientHeight, width: canvas.clientWidth });
    started = true;
    documentVisible = !document.hidden;
    reconcileLoop();
  };

  /** Tear down and tell the host once. `notified` guards against the second report a lost device
      usually produces: the loss resolves, and the in-flight frame throws on the dead device. */

  const start = async () => {
    try {
      await initialize();
    } catch (error) {
      if (!disposed) {
        handleFailure(
          error instanceof Error
            ? error
            : new Error("WebGPU initialization failed", { cause: error }),
        );
      }
    }
  };

  const ready = start();

  /* Framing, driven from the GPU-hero controls in BlackholeContext (see BlackholeGpuCanvas).
     Those are deliberately separate from that context's shift/anchorY/scale, which belong to the
     three.js BlackholeCanvas and are expressed in its camera's terms; these are in screen units
     and map onto what geodesic.wgsl's cameraRay actually reads:

       x, y     the void's centre as a percentage of the viewport. cameraRay puts the void at
                exactly ndc == (centerX, centerY), and ndc is x-right / y-up over -1..1, so this
                is a straight rescale of each axis.
       size     zoom. A LARGER fov narrows the field and enlarges the object, so this multiplies.
     and the three rotations, all in degrees, one per axis of the camera:

       pitchDeg  X. Elevation above the disk plane — how edge-on the disk is. Clamped by the
                 shader at +-75.6 deg, where the camera is nearly overhead.
       yawDeg    Y. Orbit around the disk's vertical axis. A real change of viewpoint, so it
                 re-lights the disk and swings the void's surroundings, and it forces a re-bake.
       rollDeg   Z. The lean, positive counter-clockwise. This one rotates the screen plane before
                 the ray is built, so it spins the picture without moving the void or changing
                 what is lit.

     Writing through desktopLayout keeps the mobile override, which flattens all of this, in
     charge at narrow widths. */
  const setFraming = ({
    x,
    y,
    size,
    pitchDeg,
    yawDeg,
    rollDeg,
  }: {
    x: number;
    y: number;
    size: number;
    pitchDeg: number;
    yawDeg: number;
    rollDeg: number;
  }) => {
    desktopLayout.centerX = (x / 100) * 2 - 1;
    desktopLayout.centerY = 1 - (y / 100) * 2;
    desktopLayout.cameraRoll = rad(rollDeg);
    desktopLayout.cameraY = rad(pitchDeg);
    desktopLayout.fov = BASE_FOV * Math.max(0.05, size);
    /* Yaw has no mobile override, so it is not part of the layout swap. */
    settings.cameraYaw = rad(yawDeg);
    applyResponsiveLayout(settings, mobileQuery, desktopLayout);

    if (effects && targets) {
      setBakeUniforms(effects, targets, settings);
    }

    forceBake = true;

    if (reducedMotionQuery.matches) {
      renderOnce();
    }
  };

  return { dispose, ready, setFraming };
};
