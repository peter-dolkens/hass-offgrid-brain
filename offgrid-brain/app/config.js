/* Add-on options + policy loading.

   The Supervisor writes the user's options to /data/options.json, so no bashio
   dependency is needed. The DISPATCH POLICY deliberately does NOT live in add-on
   options: it is a structured list with expressions, which the options UI handles
   badly, and it wants to be diffable against the simulator's defaults(). It lives
   at /config/policy.json (the add-on's own config dir, addon_config:rw). */
"use strict";
const fs = require("fs");
const path = require("path");
const log = require("./log.js");

const OPTIONS_PATH = process.env.OPTIONS_PATH || "/data/options.json";
const POLICY_PATH = process.env.POLICY_PATH || "/config/policy.json";
const DEFAULT_POLICY = path.join(__dirname, "policy", "policy.default.json");

function loadOptions() {
  try {
    return JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf8"));
  } catch (e) {
    log.warn(`could not read ${OPTIONS_PATH} (${e.message}) — using built-in defaults`);
    return {};
  }
}

function loadPolicy() {
  try {
    const p = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8"));
    log.info(`policy loaded from ${POLICY_PATH}: ${p.devices.length} devices, ${p.list.length} entries`);
    return p;
  } catch (e) {
    if (e.code !== "ENOENT") log.error(`policy at ${POLICY_PATH} is unreadable (${e.message}) — falling back to default`);
    const def = JSON.parse(fs.readFileSync(DEFAULT_POLICY, "utf8"));
    try {
      fs.mkdirSync(path.dirname(POLICY_PATH), { recursive: true });
      fs.writeFileSync(POLICY_PATH, JSON.stringify(def, null, 2));
      log.info(`seeded a starter policy at ${POLICY_PATH} — edit it to suit, then restart`);
    } catch (w) { log.warn(`could not seed policy file: ${w.message}`); }
    return def;
  }
}

/** Validate that every device referenced by the list actually exists. */
function validate(policy, devicesOption) {
  const problems = [];
  const ids = new Set(policy.devices.map((d) => d.id));
  for (const [i, e] of policy.list.entries()) {
    if (e.type === "load" && !ids.has(e.dev)) problems.push(`list[${i}] references unknown device "${e.dev}"`);
    if (e.type === "charge" && !(e.to >= 0 && e.to <= 100)) problems.push(`list[${i}] charge rung "to" must be 0-100`);
  }
  // Devices configured in add-on options but absent from the policy would never be dispatched.
  for (const d of devicesOption || []) {
    if (!ids.has(d.id)) problems.push(`configured device "${d.id}" has no entry in policy.json — it will never be dispatched`);
  }
  return problems;
}

module.exports = { loadOptions, loadPolicy, validate, POLICY_PATH, OPTIONS_PATH };
