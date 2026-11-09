/* Ingress web UI: a live view of the last dispatch walk, and a policy editor.

   Served through Home Assistant Ingress, so HA does the authentication (the panel
   is admin-only) and requests reach us from the Supervisor's ingress gateway.
   Anything else is refused: this API can rewrite the policy that controls the
   house. Built on node:http alone, like the rest of the control path.

   Routes (all relative, so they work under the ingress path prefix):
     GET  /                   the UI
     GET  /api/state          last tick: inputs, context, decisions, per-entry trace
     GET  /api/policy         the policy in force
     POST /api/policy/check   validate a candidate and preview it against the last tick
     PUT  /api/policy         validate, save to policy.json, and apply immediately
     GET  /api/settings       the settings in force
     POST /api/settings/check validate candidate settings
     PUT  /api/settings       validate, save to settings.json, and apply immediately;
                              turning dry run OFF also needs { confirm: "LIVE" }
     GET  /api/entities       every HA entity, for the settings pickers */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const log = require("../log.js");

const INGRESS_GATEWAY = "172.30.32.2";
const MAX_BODY = 256 * 1024;
const INDEX = path.join(__dirname, "index.html");

function remoteAllowed(req, allowAny) {
  if (allowAny) return true;
  const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return ip === INGRESS_GATEWAY;
}

function send(res, status, body, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(new Error(`invalid JSON: ${e.message}`)); }
    });
    req.on("error", reject);
  });
}

/** Write via a temp file and rename, keeping the previous file as .bak. */
function savePolicy(file, policy) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(policy, null, 2) + "\n");
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(tmp, file);
}

/**
 * @param {object} o
 * @param {number} o.port
 * @param {() => object} o.getState      snapshot of the last tick
 * @param {() => object} o.getPolicy     policy in force
 * @param {(p: object) => string[]} o.check       problems; empty = usable
 * @param {(p: object) => object} o.preview       dispatch result for p against the last tick
 * @param {(p: object) => void} o.apply           make p the policy in force
 * @param {string} o.policyPath
 * @param {string} o.settingsPath
 * @param {() => object} o.getSettings
 * @param {(s: object) => string[]} o.checkSettings
 * @param {(s: object) => void} o.applySettings
 * @param {() => Promise<object[]>} o.listEntities
 * @param {boolean} [o.allowAny]         accept any client (local development only)
 */
function startServer(o) {
  const server = http.createServer(async (req, res) => {
    if (!remoteAllowed(req, o.allowAny)) return send(res, 403, { error: "forbidden" });
    const url = new URL(req.url, "http://x");
    const route = `${req.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /":
        case "GET /index.html":
          return send(res, 200, fs.readFileSync(INDEX, "utf8"), "text/html");
        case "GET /api/state":
          return send(res, 200, o.getState());
        case "GET /api/policy":
          return send(res, 200, { policy: o.getPolicy(), path: o.policyPath });
        case "POST /api/policy/check": {
          const candidate = await readJson(req);
          const problems = o.check(candidate);
          return send(res, 200, { problems, preview: problems.length ? null : o.preview(candidate) });
        }
        case "PUT /api/policy": {
          const candidate = await readJson(req);
          const problems = o.check(candidate);
          if (problems.length) return send(res, 422, { problems });
          savePolicy(o.policyPath, candidate);
          o.apply(candidate);
          log.info(`policy updated from the web UI: ${candidate.devices.length} devices, ${candidate.list.length} entries (previous kept as ${path.basename(o.policyPath)}.bak)`);
          return send(res, 200, { ok: true });
        }
        case "GET /api/settings":
          return send(res, 200, { settings: o.getSettings(), path: o.settingsPath });
        case "POST /api/settings/check": {
          const candidate = await readJson(req);
          return send(res, 200, { problems: o.checkSettings(candidate) });
        }
        case "PUT /api/settings": {
          const body = await readJson(req);
          const candidate = body && body.settings;
          const problems = o.checkSettings(candidate);
          if (problems.length) return send(res, 422, { problems });
          // Going live starts switching real loads: it must be asked for explicitly,
          // not ride along with an unrelated edit.
          if (o.getSettings().dry_run && candidate.dry_run === false && body.confirm !== "LIVE") {
            return send(res, 409, { problems: ["turning dry run off needs confirmation"] });
          }
          o.applySettings(candidate);
          return send(res, 200, { ok: true });
        }
        case "GET /api/entities":
          return send(res, 200, { entities: await o.listEntities() });
        default:
          return send(res, 404, { error: "not found" });
      }
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  });
  server.listen(o.port, () => log.info(`web UI listening on :${o.port}${o.allowAny ? " (any client — development mode)" : " (ingress only)"}`));
  return server;
}

module.exports = { startServer, savePolicy, remoteAllowed };
