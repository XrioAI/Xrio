#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
. "$root/VERSIONS"
SRC="${SRC:-$root/src}"
dest="$SRC/third_party/widevine/cdm/linux/x64"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --retry 5 -o "$tmp/chrome.deb" \
  "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROMIUM_VERSION}-1_amd64.deb"
dpkg-deb -x "$tmp/chrome.deb" "$tmp/x"
cdm="$tmp/x/opt/google/chrome/WidevineCdm"
install -D -m 644 "$cdm/_platform_specific/linux_x64/libwidevinecdm.so" "$dest/libwidevinecdm.so"
install -D -m 644 "$cdm/manifest.json" "$dest/manifest.json"
echo "$CHROMIUM_VERSION" > "$root/.widevine-staged"
echo "staged Widevine $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$dest/manifest.json") from Chrome $CHROMIUM_VERSION"
