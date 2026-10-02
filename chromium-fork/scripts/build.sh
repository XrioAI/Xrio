#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
. "$root/VERSIONS"
SRC="${SRC:-$root/src}"
export PATH="$HOME/depot_tools:$PATH"

die() { echo "$*" >&2; exit 1; }
need() { for t in "$@"; do command -v "$t" >/dev/null || die "$t is not installed on this host"; done; }

target="${1:-}"
host="$(uname -s) $(uname -m)"
case "$target" in
  linux)
    [ "$host" = "Linux x86_64" ] || die "a Linux build needs a Linux x86_64 host; this is $host"
    need curl dpkg-deb strip zstd
    os=linux cpu=x64 out="${OUT:-out/Default}" ;;
  windows)
    case "$host" in
      "Linux x86_64" | Darwin\ *) ;;
      *) die "a Windows build cross-compiles from a Linux x86_64 or macOS host; this is $host" ;;
    esac
    os=win cpu=x64 out="${OUT:-out/Win}" ;;
  mac)
    [ "$(uname -s)" = Darwin ] || die "a Mac build needs a macOS host; this is $host"
    xcodebuild -version >/dev/null 2>&1 \
      || die "a Mac build needs full Xcode selected: sudo xcode-select -s /Applications/Xcode.app"
    need ditto
    os=mac out="${OUT:-out/Mac}"
    case "$(uname -m)" in arm64) cpu=arm64 ;; *) cpu=x64 ;; esac ;;
  *) die "usage: scripts/build.sh linux|windows|mac" ;;
esac
need git python3 gn autoninja

case "${JOBS:-1}" in 0 | *[!0-9]*) die "JOBS must be a positive number" ;; esac
if [ -z "${JOBS:-}" ] && [ "$(uname -s)" = Darwin ]; then
  JOBS=$(( $(sysctl -n hw.memsize) / 8589934592 ))
  [ "$JOBS" -ge 2 ] || JOBS=2
  echo "jobs: $JOBS compile jobs on this Mac (one per 8 GB of RAM); set JOBS to change it"
fi

[ -d "$SRC/.git" ] || die "no Chromium checkout at $SRC"
[ "$os" != win ] || [ -f "$SRC/build/win_toolchain.json" ] \
  || die "no Windows toolchain in $SRC: add 'win' to target_os in .gclient, export DEPOT_TOOLS_WIN_TOOLCHAIN_BASE_URL and GYP_MSVS_HASH_<hash> (src/docs/win_cross.md), then run scripts/sync.sh"

"$root/scripts/check.sh"
"$root/scripts/apply.sh"
if [ "$os" = linux ] && [ "$(cat "$root/.widevine-staged" 2>/dev/null)" != "$CHROMIUM_VERSION" ]; then
  "$root/scripts/stage_widevine.sh"
fi

args="target_os=\"$os\" target_cpu=\"$cpu\" is_debug=false is_official_build=true"
args="$args symbol_level=0 blink_symbol_level=0 v8_symbol_level=0"
args="$args proprietary_codecs=true ffmpeg_branding=\"Chrome\" enable_widevine=true"
args="$args disable_fieldtrial_testing_config=true"
[ "$os" != linux ] || args="$args bundle_widevine_cdm=true"
[ -z "${JOBS:-}" ] || args="$args thin_lto_jobs=\"$JOBS\""

tests="base_unittests services_unittests components_unittests"

run_tests() {
  "$out/base_unittests" --gtest_filter='Xrio*'
  "$out/services_unittests" --gtest_filter='XrioBattery*'
  "$out/components_unittests" --gtest_filter='UserAgentUtilsTest.*'
}

check_knob_template() {
  diff <("$1" --xrio-dump-config 2>&1 | sed -n 's/^\[[a-z]*\] \([a-z0-9-]*\) = .*/\1/p' | sort) \
       <(sed -nE 's#^ *// ("([a-z0-9-]+)":|([a-z0-9-]+): DERIVED).*#\2\3#p' "$root/xrio-config.example.jsonc" | sort) \
    || die "xrio-config.example.jsonc does not list this build's knobs (< build, > template)"
  echo "xrio-config.example.jsonc lists all $("$1" --xrio-dump-config 2>&1 | grep -c '^\[') knobs"
}

package_linux() {
  local pkg="$root/dist/$name"
  rm -rf "$pkg"
  mkdir -p "$pkg/personas"
  cp "$out/chrome" "$pkg/"
  strip "$pkg/chrome"
  for f in icudtl.dat resources.pak chrome_100_percent.pak chrome_200_percent.pak \
           v8_context_snapshot.bin snapshot_blob.bin libEGL.so libGLESv2.so \
           libvk_swiftshader.so vk_swiftshader_icd.json locales resources WidevineCdm; do
    cp -a "$out/$f" "$pkg/"
  done
  for f in chrome_crashpad_handler libvulkan.so.1 MEIPreload angledata \
           PrivacySandboxAttestationsPreloaded IwaKeyDistribution; do
    [ ! -e "$out/$f" ] || cp -a "$out/$f" "$pkg/"
  done
  shopt -s nullglob
  local personas=("$root"/personas/*.xrio-*.json) speech=("$root"/personas/*.xrio-speech.json)
  shopt -u nullglob
  [ ${#personas[@]} = 0 ] || cp "${personas[@]}" "$pkg/personas/"
  if [ ${#speech[@]} = 1 ]; then
    printf '{\n "speech-persona": "%s"\n}\n' "$(basename "${speech[0]}" .xrio-speech.json)" > "$pkg/xrio-config.json"
  fi
  echo "packaged ${#personas[@]} persona file(s) from personas/"
  cp "$root/VERSIONS" "$pkg/"
  tar -C "$root/dist" -I 'zstd -T0' -cf "$pkg.tar.zst" "$name"
  echo "packaged $pkg.tar.zst"
}

cd "$SRC"
gn gen "$out" --args="$args"
name="xrio-chrome-$CHROMIUM_VERSION-v$FORK_VERSION-$target"
mkdir -p "$root/dist"
case "$os" in
  linux)
    autoninja ${JOBS:+-j "$JOBS"} -C "$out" chrome $tests
    run_tests
    check_knob_template "$out/chrome"
    package_linux ;;
  win)
    autoninja ${JOBS:+-j "$JOBS"} -C "$out" mini_installer
    echo "unit tests not run: Windows binaries cannot run on this host"
    cp "$out/mini_installer.exe" "$root/dist/$name.exe"
    echo "packaged $root/dist/$name.exe" ;;
  mac)
    autoninja ${JOBS:+-j "$JOBS"} -C "$out" chrome $tests
    run_tests
    check_knob_template "$out/Chromium.app/Contents/MacOS/Chromium"
    rm -f "$root/dist/$name.zip"
    ditto -c -k --keepParent "$out/Chromium.app" "$root/dist/$name.zip"
    echo "packaged $root/dist/$name.zip" ;;
esac
