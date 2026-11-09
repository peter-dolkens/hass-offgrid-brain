/* Brain settings, edited from the web app (Settings tab) and stored in
   /config/settings.json, next to policy.json.

   The add-on's own options keep only what has to be there: the log level and
   secrets (MQTT credentials, the Cloudflare Access token), which are never served
   back to the web app. Everything else lives here so it can be edited with entity
   pickers and applied without a restart.

   On first start the file is seeded from the add-on options, so an existing
   install carries its configuration over. */
"use strict";
const fs = require("fs");
const path = require("path");
const log = require("./log.js");

const SETTINGS_PATH = process.env.SETTINGS_PATH || "/config/settings.json";

const DEFAULTS = Object.freeze({
  dry_run: true,
  tick_seconds: 5,
  battery: { capacity_kwh: 51.8, inverter_kw: 7.5, max_charge_kw: 7.5, reserve_pct: 10 },
  autonomy: { seed_load_kwh: 30, window_days: 7 },
  sources: { battery_soc: "", pv_power: "", load_power: "", outdoor_temp: "", pv_forecast_today: "", irradiance: "" },
  splink: { enabled: false, urls: [], poll_seconds: 15, fast_seconds: 3 },
  ecowitt: { enabled: false, urls: [], poll_seconds: 10 },
  solar: { inverter_ac_kw: 10, kwp: null },
  fronius: { enabled: false, hosts: [], poll_seconds: 10 },
});

const SECTIONS = ["battery", "autonomy", "sources", "splink", "ecowitt", "solar", "fronius"];

/** Defaults overlaid with whatever `from` provides for the keys settings own. */
function normalise(from) {
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  if (!from || typeof from !== "object") return out;
  if (typeof from.dry_run === "boolean") out.dry_run = from.dry_run;
  if (from.tick_seconds != null) out.tick_seconds = from.tick_seconds;
  for (const k of SECTIONS) {
    if (from[k] && typeof from[k] === "object") Object.assign(out[k], from[k]);
  }
  // Secrets never live here, even if the source had them (add-on options do).
  delete out.splink.access_client_id;
  delete out.splink.access_client_secret;
  return out;
}

const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const num = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/** Problems that make settings unusable; empty = OK. */
function check(s) {
  if (!s || typeof s !== "object") return ["settings must be a JSON object"];
  const p = [];
  if (typeof s.dry_run !== "boolean") p.push("dry_run must be true or false");
  if (!num(s.tick_seconds, 2, 300)) p.push("tick_seconds must be 2-300");
  const b = s.battery || {};
  if (!num(b.capacity_kwh, 0.1, 10000)) p.push("battery capacity must be a positive kWh");
  if (!num(b.inverter_kw, 0.1, 1000)) p.push("battery inverter kW must be positive");
  if (!num(b.max_charge_kw, 0.1, 1000)) p.push("max charge kW must be positive");
  if (!num(b.reserve_pct, 0, 50)) p.push("reserve must be 0-50%");
  const a = s.autonomy || {};
  if (!num(a.seed_load_kwh, 0, 10000)) p.push("autonomy seed load must be >= 0 kWh");
  if (!num(a.window_days, 1, 30) || !Number.isInteger(a.window_days)) p.push("autonomy window must be 1-30 whole days");
  for (const [k, v] of Object.entries(s.sources || {})) {
    if (v && !ENTITY_RE.test(v)) p.push(`source ${k}: "${v}" isn't an entity id`);
  }
  const urls = (label, list) => {
    if (!Array.isArray(list)) return p.push(`${label} urls must be a list`);
    for (const u of list) {
      try { const x = new URL(u); if (!/^https?:$/.test(x.protocol)) throw new Error(); }
      catch { p.push(`${label}: "${u}" isn't an http(s) URL`); }
    }
  };
  const sp = s.splink || {};
  urls("splink", sp.urls);
  if (sp.enabled && !(sp.urls || []).length) p.push("splink is enabled but has no URLs");
  if (!num(sp.poll_seconds, 5, 300)) p.push("splink poll must be 5-300 s");
  if (!num(sp.fast_seconds, 0, 60)) p.push("splink fast window must be 0-60 s");
  const ec = s.ecowitt || {};
  urls("ecowitt", ec.urls);
  if (ec.enabled && !(ec.urls || []).length) p.push("ecowitt is enabled but has no URLs");
  if (!num(ec.poll_seconds, 5, 300)) p.push("ecowitt poll must be 5-300 s");
  const so = s.solar || {};
  if (!num(so.inverter_ac_kw, 0.1, 1000)) p.push("inverter AC rating must be positive");
  if (so.kwp != null && !num(so.kwp, 0.1, 10000)) p.push("array kWp override must be positive or empty");
  const fr = s.fronius || {};
  if (!Array.isArray(fr.hosts)) p.push("fronius hosts must be a list");
  if (!num(fr.poll_seconds, 5, 300)) p.push("fronius poll must be 5-300 s");
  return p;
}

/** Read settings.json, seeding it from the add-on options on first start. */
function loadSettings(options) {
  try {
    const s = normalise(JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")));
    log.info(`settings loaded from ${SETTINGS_PATH}`);
    return s;
  } catch (e) {
    if (e.code !== "ENOENT") log.error(`settings at ${SETTINGS_PATH} are unreadable (${e.message}); using the add-on options`);
    const s = normalise(options);
    try {
      save(s);
      log.info(`seeded ${SETTINGS_PATH} from the add-on options; edit settings in the Off-Grid Brain panel from now on`);
    } catch (w) { log.warn(`could not write ${SETTINGS_PATH}: ${w.message}`); }
    return s;
  }
}

/** Atomic write, keeping the previous file as .bak. */
function save(s, file = SETTINGS_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(tmp, file);
}

module.exports = { DEFAULTS, normalise, check, loadSettings, save, SETTINGS_PATH };
