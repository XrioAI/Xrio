#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
. "$root/VERSIONS"
SRC="${SRC:-$root/src}"
CHROMIUM_DIR="${CHROMIUM_DIR:-$HOME/chromium}"
export PATH="$HOME/depot_tools:$PATH"

die() { echo "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux)
    command -v apt-get >/dev/null || die "setup.sh supports Debian and Ubuntu hosts only"
    sudo apt-get update -q
    sudo apt-get install -y -q git curl python3 python3-venv zstd binutils xvfb x11-utils lsof procps ;;
  Darwin)
    xcodebuild -version >/dev/null 2>&1 \
      || die "install Xcode from the App Store, then run: sudo xcode-select -s /Applications/Xcode.app"
    xcrun metal --version >/dev/null 2>&1 || xcodebuild -downloadComponent MetalToolchain ;;
  *) die "unsupported host: $(uname -s)" ;;
esac

[ -d "$HOME/depot_tools" ] \
  || git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git "$HOME/depot_tools"

[ -x "$root/.venv/bin/python" ] || python3 -m venv "$root/.venv"
"$root/.venv/bin/pip" install -q --disable-pip-version-check --upgrade patchright

if [ ! -e "$SRC" ]; then
  if [ ! -d "$CHROMIUM_DIR/src/.git" ]; then
    mkdir -p "$CHROMIUM_DIR"
    (cd "$CHROMIUM_DIR" && fetch --nohooks chromium)
  fi
  ln -s "$CHROMIUM_DIR/src" "$SRC"
fi

python3 - "$(cd -P "$SRC/.." && pwd)/.gclient" <<'EOF'
import pprint, sys
path = sys.argv[1]
spec = {}
exec(open(path).read(), spec)
src = next(s for s in spec["solutions"] if s["name"] == "src")
if src.get("custom_vars", {}).get("checkout_pgo_profiles") is True:
    sys.exit()
src.setdefault("custom_vars", {})["checkout_pgo_profiles"] = True
with open(path, "w") as f:
    for key, value in spec.items():
        if not key.startswith("__"):
            f.write(f"{key} = {pprint.pformat(value)}\n")
EOF

if [ "$(git -C "$SRC" rev-parse HEAD)" != "$(git -C "$SRC" rev-parse -q --verify "$CHROMIUM_VERSION^{commit}" || true)" ]; then
  "$root/scripts/sync.sh"
fi

[ "$(uname -s)" != Linux ] || "$SRC/build/install-build-deps.sh" --no-prompt

echo "ready: run scripts/build.sh linux|windows|mac"
