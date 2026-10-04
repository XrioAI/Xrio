import { describe, expect, it } from "vite-plus/test";

import { isOwnedSwitch } from "./owned-inputs.ts";

describe(isOwnedSwitch, () => {
  it.each([
    "--lang",
    "--accept-lang",
    "--use-gl",
    "--use-angle",
    "--window-size",
    "--screen-info",
    "--use-fake-device-for-media-stream",
  ])("owns %s", (name) => {
    expect(isOwnedSwitch(name)).toBeTruthy();
  });

  it.each([
    "--force-device-scale-factor",
    "--device-scale-factor",
    "--high-dpi-support",
    "--window-position",
    "--start-maximized",
    "--start-fullscreen",
    "--user-agent",
    "--disable-gpu",
    "--enable-unsafe-swiftshader",
    "--disable-software-rasterizer",
    "--disable-webgl",
    "--disable-3d-apis",
    "--hide-scrollbars",
    "--enable-automation",
    "--enable-blink-features",
    "--force-dark-mode",
    "--force-prefers-reduced-motion",
    "--touch-events",
    "--force-webrtc-ip-handling-policy",
    "--webrtc-ip-handling-policy",
    "--enforce-webrtc-ip-permission-check",
    "--kiosk",
    "--app",
    "--ozone-override-screen-size",
    "--force-prefers-no-reduced-motion",
    "--force-high-contrast",
    "--disable-webgl2",
    "--disable-reading-from-canvas",
    "--use-webgpu-adapter",
    "--enable-unsafe-webgpu",
    "--disable-webgpu",
    "--js-flags",
    "--use-fake-ui-for-media-stream",
    "--use-file-for-fake-audio-capture",
    "--use-file-for-fake-video-capture",
    "--alsa-input-device",
    "--alsa-output-device",
    "--auto-accept-camera-and-microphone-capture",
    "--deny-permission-prompts",
    "--disable-audio-input",
    "--disable-audio-output",
  ])("reserves %s for the Humanizer before any surface emits it", (name) => {
    expect(isOwnedSwitch(name)).toBeTruthy();
  });

  it.each(["--pxr-seed", "--pxr-gl-persona", "--xrio-device-memory"])(
    "owns the fork knob %s by its prefix",
    (name) => {
      expect(isOwnedSwitch(name)).toBeTruthy();
    },
  );

  it.each([
    "--language",
    "--lang-x",
    "--no-sandbox",
    "--disable-gpu-compositing",
    "--pxr",
    "--xrio",
    "--window-position-x",
  ])("leaves %s to the caller", (name) => {
    expect(isOwnedSwitch(name)).toBeFalsy();
  });
});
