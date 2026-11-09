#!/bin/sh
# Supervisor writes the add-on options to /data/options.json; main.js reads it directly,
# so no bashio dependency is needed.
set -e
echo "[offgrid-brain] starting"
exec node /app/main.js
