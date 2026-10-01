#!/usr/bin/env python3
"""Capture what one browser on one GPU answers about video decode, everywhere a
page can ask.

`fork/ROADMAP.md` item 7 orders this before any hook, and item 7.2 is why:
`decodingInfo()` is not the only API reading the GPU video factories.
`video_decoder.cc` routes `hardwareAcceleration: "prefer-hardware"` through the
same factories, and `VideoEncoder.isConfigSupported()` and
`RTCRtpReceiver.getCapabilities("video")` read them too. A media persona that
fixes `decodingInfo` alone would make three APIs describing one GPU disagree,
which is a sharper contradiction than the one it set out to remove. So all four
are captured together, and the artifact is generated from the capture rather
than from a decision about what ought to be true.

Two captures make a persona: one on the GPU we CLAIM (the reference machine) and
one on the GPU we PRODUCE (SwiftShader on the render host).
`tools/gen_media_persona.py` diffs them.

    tools/capture_media.py --browser PATH --out capture.json [--mode headless]

The output is provenance plus answers, and nothing else: no thresholds, no
verdicts. Reading it is `gen_media_persona.py`'s job and comparing two of them is
the roadmap's.
"""

import argparse
import functools
import http.server
import json
import pathlib
import platform
import socketserver
import subprocess
import sys
import threading

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import xrio_launch  # noqa: E402

from patchright.sync_api import sync_playwright  # noqa: E402

PAGE = "<!doctype html><meta charset=utf-8><title>media</title><body>x</body>"

# One representative codec string per family, and they are the strings a real
# page uses -- decodingInfo answers per codec string, not per family name, and a
# profile nobody ships would measure a capability nobody has.
FAMILIES = {
    "h264": {"mime": "video/mp4", "codec": "avc1.42E01E",
             "webrtc": "video/H264", "webcodecs": "avc1.42E01E"},
    "hevc": {"mime": "video/mp4", "codec": "hvc1.1.6.L93.B0",
             "webrtc": "video/H265", "webcodecs": "hvc1.1.6.L93.B0"},
    "vp8": {"mime": "video/webm", "codec": "vp8",
            "webrtc": "video/VP8", "webcodecs": "vp8"},
    "vp9": {"mime": "video/webm", "codec": "vp09.00.10.08",
            "webrtc": "video/VP9", "webcodecs": "vp09.00.10.08"},
    "av1": {"mime": "video/mp4", "codec": "av01.0.04M.08",
            "webrtc": "video/AV1", "webcodecs": "av01.0.04M.08"},
}

PROBE = r"""
async (families) => {
  const out = {decoding: {}, webcodecs: {}, webrtc: null, gl: null, errors: []};

  const video = (f) => ({
    contentType: `${f.mime}; codecs="${f.codec}"`,
    width: 1920, height: 1080, bitrate: 4000000, framerate: 30,
  });

  // 1. mediaCapabilities.decodingInfo, every type the API defines. `webrtc` is
  //    a separate type and reads a different path than `file`, which is exactly
  //    the coverage gap item 7.3 lists.
  for (const [name, f] of Object.entries(families)) {
    out.decoding[name] = {};
    for (const type of ['file', 'media-source', 'webrtc']) {
      try {
        const r = await navigator.mediaCapabilities.decodingInfo(
          {type, video: video(f)});
        out.decoding[name][type] = {
          supported: r.supported, smooth: r.smooth,
          powerEfficient: r.powerEfficient,
        };
      } catch (e) {
        out.decoding[name][type] = {error: e.name + ': ' + e.message};
      }
    }
    // Key-system decode, where the browser grants one at all. Widevine is the
    // one branded Chrome grants and a self-build without a CDM does not, so
    // this row is also how a media capture notices a package missing its CDM.
    try {
      const r = await navigator.mediaCapabilities.decodingInfo({
        type: 'media-source', video: video(f),
        keySystemConfiguration: {keySystem: 'com.widevine.alpha'},
      });
      out.decoding[name]['widevine'] = {
        supported: r.supported, smooth: r.smooth,
        powerEfficient: r.powerEfficient,
        keySystemAccess: !!r.keySystemAccess,
      };
    } catch (e) {
      out.decoding[name]['widevine'] = {error: e.name};
    }
  }

  // 2. WebCodecs, both preferences. 'prefer-hardware' is the one that reaches
  //    the GPU video factories; 'no-preference' is the control.
  if (typeof VideoDecoder !== 'undefined') {
    for (const [name, f] of Object.entries(families)) {
      out.webcodecs[name] = {};
      for (const pref of ['no-preference', 'prefer-hardware']) {
        const config = {codec: f.webcodecs, codedWidth: 1920, codedHeight: 1080,
                        hardwareAcceleration: pref};
        try {
          const d = await VideoDecoder.isConfigSupported(config);
          out.webcodecs[name]['decode:' + pref] = {supported: d.supported};
        } catch (e) {
          out.webcodecs[name]['decode:' + pref] = {error: e.name};
        }
        try {
          const e2 = await VideoEncoder.isConfigSupported(
            {...config, width: 1920, height: 1080, bitrate: 4000000,
             framerate: 30});
          out.webcodecs[name]['encode:' + pref] = {supported: e2.supported};
        } catch (e) {
          out.webcodecs[name]['encode:' + pref] = {error: e.name};
        }
      }
    }
  } else {
    out.errors.push('no WebCodecs');
  }

  // 3. WebRTC receive capabilities: the same factories again, and the one API
  //    of the three that answers with a LIST rather than a boolean.
  try {
    const caps = RTCRtpReceiver.getCapabilities('video');
    out.webrtc = {
      codecs: caps.codecs.map(c => ({mimeType: c.mimeType,
                                     sdpFmtpLine: c.sdpFmtpLine || null})),
      headerExtensions: caps.headerExtensions.map(h => h.uri),
    };
  } catch (e) {
    out.errors.push('getCapabilities: ' + e.name);
  }

  // 4. The GPU string, so a capture can never be attributed to the wrong
  //    machine after the fact.
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    out.gl = {
      vendor: gl.getParameter(info ? info.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
      renderer: gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL
                                     : gl.RENDERER),
    };
  } catch (e) {
    out.errors.push('gl: ' + e.name);
  }
  return out;
}
"""


def serve(root):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler,
                                directory=str(root))

    class Quiet(socketserver.TCPServer):
        allow_reuse_address = True

        def handle_error(self, *args):
            pass

    server = Quiet(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def browser_version(path):
    try:
        return subprocess.run([path, "--version"], capture_output=True,
                              text=True, timeout=60).stdout.strip()
    except (OSError, subprocess.SubprocessError) as error:
        return f"unknown ({error})"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--browser", required=True)
    ap.add_argument("--out", type=pathlib.Path, required=True)
    ap.add_argument("--mode", default="headless",
                    choices=("headed", "headless"))
    ap.add_argument("--label", default=None,
                    help="what this capture IS, e.g. 'mybox-amd-renoir'. "
                         "Defaults to the output file's stem.")
    ap.add_argument("--chrome-flag", action="append", default=[],
                    help="extra switch, repeatable; recorded in the capture")
    args = ap.parse_args()
    # This capture's whole job is to be comparable with another one, and a
    # --chrome-flag that carries --enable-features REPLACES the paint-holding
    # enable below rather than merging with it (CommandLine is a map), while a
    # --disable-features=PaintHolding simply beats it. Either would make one
    # capture differ from its pair by a feature nobody recorded, silently.
    xrio_launch.assert_no_feature_conflict(args.chrome_flag)

    root = pathlib.Path(__file__).resolve().parent / "mroot"
    root.mkdir(exist_ok=True)
    (root / "index.html").write_text(PAGE, encoding="utf-8")
    server, port = serve(root)
    url = f"http://127.0.0.1:{port}/index.html"
    headless = args.mode == "headless"
    if not headless:
        xrio_launch.check_headed_display()

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                executable_path=args.browser,
                headless=headless,
                args=[
                    "--window-size=1920,1080",
                    *([f"--screen-info={xrio_launch.screen_info()}"]
                      if headless else []),
                    f"--enable-features={xrio_launch.PAINT_HOLDING}",
                    *args.chrome_flag,
                ],
                ignore_default_args=["--disable-background-networking"],
            )
            try:
                page = browser.new_context().new_page()
                page.goto(url, wait_until="load", timeout=30_000)
                answers = page.evaluate(PROBE, FAMILIES)
            finally:
                browser.close()
    finally:
        server.shutdown()

    capture = {
        "schema": "xrio-media-capture/v1",
        "label": args.label or args.out.stem,
        "browser": browser_version(args.browser),
        "browser_path": str(args.browser),
        "mode": args.mode,
        "host": platform.node(),
        "flags": args.chrome_flag,
        "families": {k: v["codec"] for k, v in FAMILIES.items()},
        **answers,
    }
    args.out.write_text(json.dumps(capture, indent=2, sort_keys=True) + "\n",
                        encoding="utf-8")

    print(f"{args.out}: {capture['browser']}  {capture['host']}/{args.mode}")
    print(f"  gl: {(capture.get('gl') or {}).get('renderer', '?')}")
    for name in FAMILIES:
        row = capture["decoding"].get(name, {})
        got = row.get("file", {})
        wc = (capture.get("webcodecs", {}).get(name, {})
              .get("decode:prefer-hardware", {}))
        print(f"  {name:5s} file supported={got.get('supported')} "
              f"smooth={got.get('smooth')} "
              f"powerEfficient={got.get('powerEfficient')}   "
              f"webcodecs hw={wc.get('supported', wc.get('error'))}")
    if capture.get("errors"):
        print("  errors: " + "; ".join(capture["errors"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
