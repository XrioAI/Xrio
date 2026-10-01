#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
. "$root/VERSIONS"
SRC="${SRC:-$root/src}"

[ -d "$SRC/.git" ] || { echo "no Chromium checkout at $SRC" >&2; exit 1; }
git -C "$SRC" rev-parse -q --verify "$CHROMIUM_VERSION^{commit}" >/dev/null \
  || { echo "tag $CHROMIUM_VERSION is not in $SRC; run scripts/sync.sh" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_INDEX_FILE="$tmp/index"
git -C "$SRC" read-tree "$CHROMIUM_VERSION"

total=0
drifted=0
while read -r p; do
  [ -n "$p" ] || continue
  total=$((total + 1))
  if ! out="$(git -C "$SRC" apply --cached "$root/patches/$p" 2>&1)"; then
    echo "$out" >&2
    echo "  DRIFTED  $p" >&2
    drifted=$((drifted + 1))
  fi
done < "$root/patches/series"

[ "$drifted" = 0 ] || { echo "$drifted of $total patches no longer apply strictly to $CHROMIUM_VERSION" >&2; exit 1; }
echo "all $total patches apply strictly to $CHROMIUM_VERSION"
