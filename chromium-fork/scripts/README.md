# scripts

Run from the kit root. `src` is the Chromium checkout (a symlink is fine; override with `SRC=`), and `VERSIONS` pins the tag every script works against.

```sh
scripts/setup.sh         # once per machine
scripts/build.sh linux   # or windows / mac
```

| Script | Purpose |
| --- | --- |
| `setup.sh` | Installs what the other scripts and `tools/` need: host packages, depot_tools, Xcode's Metal toolchain on macOS, Patchright in `.venv`. If `src` is missing it fetches Chromium into `CHROMIUM_DIR` (default `~/chromium`) and links it, then pins it with `sync.sh`. Safe to re-run. |
| `sync.sh` | Restores `src`, checks out the `VERSIONS` tag and runs `gclient sync`. Run it after changing `CHROMIUM_VERSION`. |
| `check.sh` | Checks that every patch applies strictly to the pinned tag, on a temporary index without touching `src`. |
| `apply.sh` | Applies `patches/series` to `src`; patches already applied are skipped. |
| `unapply.sh` | Reverts every file the patches touch and deletes the files they add. |
| `stage_widevine.sh` | Downloads the matching Chrome .deb, verifies it against `CHROME_DEB_SHA256` and copies its Widevine CDM into `src` (Linux builds). |
| `build.sh` | `linux`, `windows` or `mac`: checks the host, runs `check.sh` and `apply.sh`, builds, runs the fork's unit tests and the knob-template check, and packages into `dist/`. `JOBS=` caps parallel compile and link jobs (default on macOS: one per 8 GB of RAM). |

A Windows build also needs a Windows toolchain packaged for cross-compiling (`build/win_toolchain.json`); `setup.sh` does not install it.
