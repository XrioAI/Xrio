#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
. "$root/VERSIONS"
SRC="${SRC:-$root/src}"

[ -d "$SRC/.git" ] || { echo "no Chromium checkout at $SRC" >&2; exit 1; }
[ "$(git -C "$SRC" rev-parse HEAD)" = "$(git -C "$SRC" rev-parse "$CHROMIUM_VERSION^{commit}" 2>/dev/null)" ] || {
  echo "src is not at $CHROMIUM_VERSION; run scripts/sync.sh" >&2
  exit 1
}

while read -r p; do
  [ -n "$p" ] || continue
  if git -C "$SRC" apply --check --reverse "$root/patches/$p" 2>/dev/null; then
    echo "  already  $p"
  elif out="$(git -C "$SRC" apply --3way --whitespace=nowarn "$root/patches/$p" 2>&1)"; then
    echo "  applied  $p"
  else
    echo "$out" >&2
    echo "  FAILED   $p (run scripts/unapply.sh, then retry)" >&2
    exit 1
  fi
done < "$root/patches/series"
