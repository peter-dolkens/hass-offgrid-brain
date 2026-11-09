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
const Expr = require("./policy/expr.js");
const { VARS } = require("./policy/dispatch.js");

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

/** Problems that make a policy unusable: bad shape, unknown devices, expressions
    that don't compile. The web editor refuses to apply a policy with any of these. */
function check(policy) {
  if (!policy || typeof policy !== "object") return ["policy must be a JSON object"];
  if (!Array.isArray(policy.devices)) return ['"devices" must be an array'];
  if (!Array.isArray(policy.list)) return ['"list" must be an array'];
  const problems = [];
  const ids = new Set();
  for (const [i, d] of policy.devices.entries()) {
    if (!d || typeof d.id !== "string" || !d.id) { problems.push(`devices[${i}] needs a string "id"`); continue; }
    if (ids.has(d.id)) problems.push(`devices[${i}] duplicate id "${d.id}"`);
    ids.add(d.id);
    if (!(typeof d.kw === "number" && d.kw >= 0)) problems.push(`device "${d.id}" needs "kw" >= 0`);
    if (d.switch) {
      if (!ENTITY_RE.test(d.switch)) problems.push(`device "${d.id}" switch "${d.switch}" isn't an entity id`);
      else if (!SWITCHABLE.includes(d.switch.split(".")[0])) {
        problems.push(`device "${d.id}" switch "${d.switch}": the brain can only turn ${SWITCHABLE.join("/")} entities on and off`);
      }
    }
    if (d.power_sensor && !ENTITY_RE.test(d.power_sensor)) problems.push(`device "${d.id}" power sensor "${d.power_sensor}" isn't an entity id`);
    if (d.min_dwell_seconds != null && !(typeof d.min_dwell_seconds === "number" && d.min_dwell_seconds >= 0 && d.min_dwell_seconds <= 86400)) {
      problems.push(`device "${d.id}" min dwell must be 0-86400 s`);
    }
    if (d.important != null && typeof d.important !== "boolean") problems.push(`device "${d.id}" "important" must be true or false`);
  }
  for (const [i, e] of policy.list.entries()) {
    if (!e || (e.type !== "load" && e.type !== "charge")) { problems.push(`list[${i}] "type" must be "load" or "charge"`); continue; }
    if (e.type === "charge" && !(typeof e.to === "number" && e.to >= 0 && e.to <= 100)) problems.push(`list[${i}] charge rung "to" must be 0-100`);
    if (e.type === "load") {
      if (!ids.has(e.dev)) problems.push(`list[${i}] references unknown device "${e.dev}"`);
      if (e.important != null && typeof e.important !== "boolean") problems.push(`list[${i}] (${e.dev}) "important" must be true or false`);
      const c = Expr.compile(e.cond == null ? "0" : String(e.cond), VARS);
      if (!c.ok) problems.push(`list[${i}] (${e.dev}) condition: ${c.error}`);
    }
  }
  return problems;
}

/** check() plus warnings that don't make a policy unusable. */
function validate(policy) {
  const problems = check(policy);
  if (problems.length) return problems;
  const used = new Set(policy.list.filter((e) => e.type === "load").map((e) => e.dev));
  for (const d of policy.devices) {
    if (!used.has(d.id)) problems.push(`device "${d.id}" has no entry in the list — it will never be dispatched`);
  }
  return problems;
}

/** Devices used to be split: kW in policy.json, switch/sensor/dwell in the add-on
    options. Fold any old option entries into the policy's devices (adding the
    device if it's missing). Returns true when the policy changed. */
function mergeDeviceOptions(policy, optionDevices) {
  let changed = false;
  for (const od of optionDevices || []) {
    if (!od || !od.id) continue;
    let d = policy.devices.find((x) => x.id === od.id);
    if (!d) { d = { id: od.id, name: od.name || od.id, kw: od.kw || 0 }; policy.devices.push(d); changed = true; }
    for (const k of ["switch", "power_sensor", "min_dwell_seconds"]) {
      if (od[k] != null && od[k] !== "" && d[k] == null) { d[k] = od[k]; changed = true; }
    }
  }
  return changed;
}

/** Entity domains the actuator can switch with <domain>.turn_on / turn_off. */
const SWITCHABLE = ["switch", "input_boolean", "light", "fan", "climate", "water_heater", "humidifier"];
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;

module.exports = { loadOptions, loadPolicy, check, validate, mergeDeviceOptions, SWITCHABLE, POLICY_PATH, OPTIONS_PATH };
