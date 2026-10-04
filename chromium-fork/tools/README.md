# tools

Generate the persona files the browser reads from `personas/` beside its binary. A persona makes the browser report another machine's GPU, video decode support or voice list. None ship with the kit, so each operator generates their own. Python 3; `capture_media.py` also needs Patchright, which `scripts/setup.sh` installs into `.venv`, so run it as `.venv/bin/python tools/capture_media.py`.

| Tool | Purpose |
| --- | --- |
| `capture_gl.py` | Launches the fork and records what WebGL reports. Run it twice on the same build: `--swiftshader` (what a GPU-less server shows) and `--headed` on the real GPU you want to claim. |
| `gen_gl_persona.py` | Turns those two captures into `<name>.xrio-gl.json`, named after the claimed capture. |
| `capture_media.py` | Records one browser's video decode/encode answers (`mediaCapabilities`, WebCodecs, WebRTC). |
| `gen_media_persona.py` | Turns a claimed-GPU capture and a SwiftShader capture into `<name>.xrio-media.json`. |
| `gen_speech_persona.py` | Builds `<name>.xrio-speech.json`, the voice list, from the speech manifest in `src`. |
| `xrio_cdp.py`, `xrio_devtools.py`, `xrio_launch.py` | Shared helpers for the tools above (DevTools connection, process cleanup, launch flags and window size). Not run directly. |

A GL persona, for example:

```sh
python3 tools/capture_gl.py --chrome src/out/Default/chrome --swiftshader --out personas/mybox-swiftshader.json
python3 tools/capture_gl.py --chrome src/out/Default/chrome --headed --out personas/mybox-gpu.json
python3 tools/gen_gl_persona.py personas/mybox-swiftshader.json personas/mybox-gpu.json --form-factor desktop --max-threads 16
```

Without a display, run `--headed` captures under `xvfb-run`. `scripts/build.sh linux` packages every `*.xrio-*.json` in `personas/`.
