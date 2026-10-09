#!/usr/bin/env bash
set -euo pipefail

revision="$(git rev-parse HEAD:chromium-fork)"
cache="${XDG_CACHE_HOME:-$HOME/.cache}/xrio-browser-builds"
build="$cache/$revision"
if [[ -d "$build" ]]; then
  (cd "$build" && sha256sum -c SHA256SUMS)
  exit 0
fi

export SRC="${XRIO_CHROMIUM_SRC:-$HOME/chromium/src}"
test -d "$SRC/.git"
mkdir -p "$cache"
staging="$(mktemp -d "$cache/.building-XXXXXX")"
trap 'rm -rf "$staging"' EXIT

cd chromium-fork
scripts/sync.sh
rm -rf dist
scripts/build.sh linux
archives=(dist/*.tar.zst)
test "${#archives[@]}" -eq 1
test -f "${archives[0]}"
cp "${archives[0]}" "$staging/"
tar --zstd -xOf "${archives[0]}" --wildcards '*/VERSIONS' > "$staging/BROWSER_VERSIONS"
test -s "$staging/BROWSER_VERSIONS"
printf '\nBuildKitTree=%s\n' "$revision" >> "$staging/BROWSER_VERSIONS"
(cd "$staging" && sha256sum ./*.tar.zst BROWSER_VERSIONS > SHA256SUMS)
mv "$staging" "$build"
