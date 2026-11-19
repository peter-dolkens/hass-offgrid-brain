#!/bin/sh
# The expression language and the climate level table are OWNED by the simulator
# (offgrid-sim/web/expr.js, climate-levels.js) and VENDORED into the add-on so the
# Docker build context is self-contained. Run this after changing either in the
# simulator; test/engine-sync.test.js compares the hashes.
set -e
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
vendor() {
  SRC="$ROOT/offgrid-sim/web/$1"
  DST="$ROOT/ha-addon/offgrid-brain/app/policy/$1"
  [ -f "$SRC" ] || { echo "missing $SRC"; exit 1; }
  SUM="$(shasum -a 256 "$SRC" | cut -d' ' -f1)"
  {
    echo "/* VENDORED from offgrid-sim/web/$1 — DO NOT EDIT HERE."
    echo "   Edit the simulator copy, then run ha-addon/offgrid-brain/tools/sync-policy-engine.sh"
    echo "   Source sha256: $SUM */"
    cat "$SRC"
  } > "$DST"
  echo "$SUM" > "$ROOT/ha-addon/offgrid-brain/app/policy/.$(basename "$1" .js).sha256"
  echo "synced $1 -> add-on ($SUM)"
}
vendor expr.js
vendor climate-levels.js
