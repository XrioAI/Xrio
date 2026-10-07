import { describe, expect, it } from "vite-plus/test";

import {
  CHROME_ACCEPT_LANGUAGES,
  chromeAcceptLanguages,
  isChromeBadFlag,
  isOwnedSwitch,
  OWNED_SWITCHES,
  XRIO_SENT_BAD_FLAG_SWITCHES,
} from "./owned-inputs.ts";

describe(isOwnedSwitch, () => {
  it.each([
    "--lang",
    "--accept-lang",
    "--use-gl",
    "--use-angle",
    "--enable-unsafe-swiftshader",
    "--window-size",
    "--window-position",
    "--screen-info",
    "--use-fake-device-for-media-stream",
  ])("owns %s", (name) => {
    expect(isOwnedSwitch(name)).toBeTruthy();
  });

  it.each([
    "--force-device-scale-factor",
    "--device-scale-factor",
    "--high-dpi-support",
    "--start-maximized",
    "--start-fullscreen",
    "--user-agent",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-webgl",
    "--disable-3d-apis",
    "--hide-scrollbars",
    "--enable-automation",
    "--test-type",
    "--disable-component-extensions-with-background-pages",
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

describe(chromeAcceptLanguages, () => {
  it.each([
    { languages: ["en-US", "en"], tag: "en-US" },
    { languages: ["de-DE", "de", "en-US", "en"], tag: "de-DE" },
    { languages: ["pt-BR", "pt", "en-US", "en"], tag: "pt-BR" },
    { languages: ["en-AU", "en-US", "en"], tag: "en-AU" },
    { languages: ["ja", "en-US", "en"], tag: "ja-JP" },
  ])("lists $languages for $tag", ({ languages, tag }) => {
    expect(chromeAcceptLanguages(tag)).toStrictEqual(languages);
  });

  it.each(["sw-KE", "de", "toString", "__proto__", ""])("has no list for %j", (tag) => {
    expect(chromeAcceptLanguages(tag)).toBeUndefined();
  });

  it("leads each list with its tag, or with the bare language Chrome uses for it", () => {
    for (const [tag, [first, ...rest]] of Object.entries(CHROME_ACCEPT_LANGUAGES)) {
      const [language] = tag.split("-");

      expect([tag, language]).toContain(first);
      expect(new Set([first, ...rest]).size).toBe(rest.length + 1);
    }
  });
});

describe(isChromeBadFlag, () => {
  it.each(["--no-sandbox", "--host-resolver-rules", "--log-net-log", "--disable-blink-features"])(
    "lists %s on every platform",
    (name) => {
      expect(isChromeBadFlag(name, "linux")).toBeTruthy();
      expect(isChromeBadFlag(name, "darwin")).toBeTruthy();
    },
  );

  it("lists the speech dispatcher switch on Linux only", () => {
    expect(isChromeBadFlag("--enable-speech-dispatcher", "linux")).toBeTruthy();
    expect(isChromeBadFlag("--enable-speech-dispatcher", "darwin")).toBeFalsy();
  });

  it("lists the bad switches and leaves out the ones Xrio manages or Chrome does not flag", () => {
    expect(isChromeBadFlag("--no-sandbox", "linux")).toBeTruthy();

    for (const name of ["--lang", "--window-size", "--proxy-server", "--disable-features"]) {
      expect(isChromeBadFlag(name, "linux")).toBeFalsy();
    }
  });

  it("never lists a switch Xrio's identity owns, so an identity input cannot raise the infobar", () => {
    expect(isChromeBadFlag("--no-sandbox", "linux")).toBeTruthy();

    for (const name of OWNED_SWITCHES) {
      expect(isChromeBadFlag(name, "linux")).toBeFalsy();
    }
  });

  it("lists every bad switch Xrio's own launch sends", () => {
    for (const name of XRIO_SENT_BAD_FLAG_SWITCHES) {
      expect(isChromeBadFlag(name, "darwin")).toBeTruthy();
    }
  });
});
