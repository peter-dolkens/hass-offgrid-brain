# Node 22 for the built-in fetch and global WebSocket: the control path then has
# zero npm dependencies and cannot be broken by a registry outage.
# Deliberately NOT `FROM ${BUILD_FROM}`: the Supervisor may pass its own s6-overlay
# base, which has no Node, and whose /init starts CMD with a scrubbed environment
# (no SUPERVISOR_TOKEN).
FROM node:22-alpine

WORKDIR /app
COPY app/package.json ./package.json

# Only the optional MQTT bridge needs a package. A registry failure must NOT break
# the image — the brain runs without the bridge and says so at runtime.
RUN npm install --omit=dev --no-audit --no-fund \
    || echo "WARNING: optional dependencies unavailable — MQTT bridge will be disabled at runtime"

COPY app/ /app/
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
