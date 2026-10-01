#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
. "$root/VERSIONS"
SRC="${SRC:-$root/src}"
export PATH="$HOME/depot_tools:$PATH"

"$root/scripts/unapply.sh"
git -C "$SRC" fetch --no-tags origin "refs/tags/$CHROMIUM_VERSION:refs/tags/$CHROMIUM_VERSION"
git -C "$SRC" checkout -B "fork-$CHROMIUM_VERSION" "$CHROMIUM_VERSION"
cd -P "$SRC/.."
gclient sync --with_tags -D --jobs 8
