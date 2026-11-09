#!/bin/sh
# The expression language is OWNED by the simulator (offgrid-sim/web/expr.js) and
# VENDORED into the add-on so the Docker build context is self-contained.
# Run this after changing expr.js in the simulator; CI/startup compares the hash.
set -e
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC="$ROOT/offgrid-sim/web/expr.js"
DST="$ROOT/ha-addon/offgrid-brain/app/policy/expr.js"
[ -f "$SRC" ] || { echo "missing $SRC"; exit 1; }
{
  echo "/* VENDORED from offgrid-sim/web/expr.js — DO NOT EDIT HERE."
  echo "   Edit the simulator copy, then run ha-addon/offgrid-brain/tools/sync-policy-engine.sh"
  echo "   Source sha256: $(shasum -a 256 "$SRC" | cut -d' ' -f1) */"
  cat "$SRC"
} > "$DST"
shasum -a 256 "$SRC" | cut -d' ' -f1 > "$ROOT/ha-addon/offgrid-brain/app/policy/.expr.sha256"
echo "synced expr.js -> add-on ($(shasum -a 256 "$SRC" | cut -d' ' -f1))"
