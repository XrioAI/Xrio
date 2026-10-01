#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SRC:-$root/src}"

while read -r p; do
  [ -n "$p" ] || continue
  sed -n 's|^+++ b/||p' "$root/patches/$p"
done < "$root/patches/series" | sort -u | while read -r f; do
  if git -C "$SRC" cat-file -e "HEAD:$f" 2>/dev/null; then
    git -C "$SRC" checkout HEAD -- "$f"
  else
    git -C "$SRC" rm -q --cached --ignore-unmatch -- "$f"
    rm -f "$SRC/$f"
  fi
done
echo "src restored to $(git -C "$SRC" describe --tags --always)"
