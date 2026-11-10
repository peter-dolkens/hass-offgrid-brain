/* Brain settings, edited from the web app (Settings tab) and stored in
   /config/settings.json, next to policy.json.

   The add-on's own options keep only what has to be there: the log level and
   the MQTT credentials, which are never served
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
  // The battery and its inverter, read through one integration (BATTERY_SOURCES).
  battery: {
    name: "Battery", source: "none",
    soc_entity: "", power_entity: "", load_entity: "", energy_in_entity: "", energy_out_entity: "",
    capacity_kwh: 51.8, inverter_kw: 7.5, max_charge_kw: 7.5, reserve_pct: 10,
    // A running load may keep drawing the battery this far below its entry's floor,
    // so loads don't flip on and off at a charge rung (e.g. 99.9% under "charge to 100%").
    hysteresis_pct: 3,
    // Short-term ratings above the continuous one: [{ kw, seconds }], e.g. an SP PRO
    // 7.5 does 8 kW for 60 min, 11.25 for 30 min, 13 for 60 s and 18 for 30 s.
    // Marked on the Live load gauge.
    ratings: [],
  },
  autonomy: { seed_load_kwh: 30, window_days: 7 },
  // Readings that don't belong to the battery or an inverter.
  sources: { outdoor_temp: "", pv_forecast_today: "", irradiance: "" },
  splink: { enabled: false, urls: [], poll_seconds: 15, fast_seconds: 3 },
  ecowitt: { enabled: false, urls: [], poll_seconds: 10 },
  // One entry per AC-coupled solar inverter, each read through its own
  // integration (see INVERTER_SOURCES). kwp null = what the source reports.
  solar: { inverters: [] },
});

const SECTIONS = ["battery", "autonomy", "sources", "splink", "ecowitt", "solar"];

/* How an inverter's output is read:
     bridge  the SP PRO bridge's Fronius readings, by the bridge's inverter key
     fronius the inverter's own Solar API, polled directly
     ha      a Home Assistant power entity (and optionally an energy entity)
     none    no live reading; counts toward available capacity only */
const INVERTER_SOURCES = ["bridge", "fronius", "ha", "none"];

/* How the battery is read:
     bridge  the SP PRO bridge: SoC, battery power, load, energy counters, charger
     ha      Home Assistant entities: SoC (required); power (+ = discharging), load,
             energy in/out (optional)
     none    no SoC: the brain stays in safe mode */
const BATTERY_SOURCES = ["bridge", "ha", "none"];

const slug = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** Before 0.11 the battery had no integration: its SoC and the house load came
    from the bridge when enabled, else from loose sources.battery_soc /
    load_power entities, and solar from sources.pv_power. Fold those in. */
function upgradeBattery(out, from) {
  const oldSources = (from && from.sources) || {};
  const b = out.battery;
  if (!(from && from.battery && from.battery.source)) {
    if (out.splink.enabled) b.source = "bridge";
    else if (oldSources.battery_soc) {
      Object.assign(b, { source: "ha", soc_entity: oldSources.battery_soc, load_entity: oldSources.load_power || "" });
    }
  }
  if (oldSources.pv_power && !out.solar.inverters.length) {
    out.solar.inverters.push({ id: "solar", name: "Solar", source: "ha", power_entity: oldSources.pv_power,
                               energy_entity: "", ac_kw: null, kwp: null });
  }
  for (const k of ["battery_soc", "load_power", "pv_power"]) delete out.sources[k];
  // 0.15.0-0.15.5 had two fixed short-term ratings.
  if ("surge_kw" in b || "peak_kw" in b) {
    if (!(from.battery && Array.isArray(from.battery.ratings) && from.battery.ratings.length)) {
      b.ratings = [[b.surge_kw, 1800], [b.peak_kw, 60]].filter(([kw]) => kw > 0).map(([kw, seconds]) => ({ kw, seconds }));
    }
    delete b.surge_kw; delete b.peak_kw;
  }
  b.ratings = (Array.isArray(b.ratings) ? b.ratings : []).map((r) => ({ kw: r && r.kw, seconds: r && r.seconds }));
}

/** Older shapes of the inverter list, converted without needing live data:
    0.10.0 entries were bridge inverters keyed by `key`; before 0.11 the global
    Fronius polling section listed hosts. */
function upgradeInverters(solar, fronius) {
  const list = (solar.inverters || []).map((x) => (x && x.source ? x : {
    id: x.key, name: x.name || x.key, source: "bridge", bridge_key: x.key,
    ac_kw: x.ac_kw == null ? null : x.ac_kw, kwp: x.kwp == null ? null : x.kwp,
  }));
  if (fronius && fronius.enabled) {
    for (const host of fronius.hosts || []) {
      if (list.some((x) => x.source === "fronius" && x.host === host)) continue;
      list.push({ id: slug(`fronius_${host}`), name: `Fronius ${host}`, source: "fronius", host,
                  poll_seconds: fronius.poll_seconds || 10, ac_kw: null, kwp: null });
    }
  }
  return list;
}

/** Defaults overlaid with whatever `from` provides for the keys settings own. */
function normalise(from) {
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  if (!from || typeof from !== "object") return out;
  if (typeof from.dry_run === "boolean") out.dry_run = from.dry_run;
  if (from.tick_seconds != null) out.tick_seconds = from.tick_seconds;
  for (const k of SECTIONS) {
    if (from[k] && typeof from[k] === "object") Object.assign(out[k], from[k]);
  }
  // Pre-0.13 bridge settings could carry a Cloudflare Access token; it's gone.
  delete out.splink.access_client_id;
  delete out.splink.access_client_secret;
  out.solar.inverters = upgradeInverters(out.solar, from.fronius);
  upgradeBattery(out, from);
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
  if (!b.name) p.push("the battery needs a name");
  if (!BATTERY_SOURCES.includes(b.source)) p.push(`battery integration must be one of ${BATTERY_SOURCES.join(", ")}`);
  if (b.source === "bridge" && !(s.splink && s.splink.enabled)) p.push("the battery reads from the SP PRO bridge, which isn't enabled");
  if (b.source === "ha" && (!b.soc_entity || !ENTITY_RE.test(b.soc_entity))) p.push("battery: pick a SoC entity");
  for (const k of ["soc_entity", "power_entity", "load_entity", "energy_in_entity", "energy_out_entity"]) {
    if (b.source === "ha" && b[k] && !ENTITY_RE.test(b[k])) p.push(`battery: "${b[k]}" isn't an entity id`);
  }
  if (!num(b.capacity_kwh, 0.1, 10000)) p.push("battery capacity must be a positive kWh");
  if (!num(b.inverter_kw, 0.1, 1000)) p.push("battery inverter kW must be positive");
  if (!num(b.max_charge_kw, 0.1, 1000)) p.push("max charge kW must be positive");
  const ratings = Array.isArray(b.ratings) ? b.ratings : [];
  for (const r of ratings) {
    if (!num(r.kw, 0, 1000) || !(r.kw > b.inverter_kw)) p.push(`short-term rating ${r.kw} kW must be above the ${b.inverter_kw} kW continuous rating`);
    if (!num(r.seconds, 1, 86400)) p.push(`short-term rating ${r.kw} kW needs a duration of 1 s to 24 h`);
  }
  const bySec = ratings.filter((r) => num(r.kw, 0, 1000) && num(r.seconds, 1, 86400)).sort((a, z) => a.seconds - z.seconds);
  for (let i = 1; i < bySec.length; i++) {
    if (!(bySec[i].kw < bySec[i - 1].kw)) p.push("short-term ratings: a longer duration must have a lower kW");
  }
  if (!num(b.reserve_pct, 0, 50)) p.push("reserve must be 0-50%");
  if (!num(b.hysteresis_pct, 0, 20)) p.push("hysteresis must be 0-20%");
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
  const inv = (s.solar || {}).inverters;
  if (!Array.isArray(inv)) p.push("solar inverters must be a list");
  else {
    const ids = new Set();
    for (const [i, x] of inv.entries()) {
      const label = (x && x.name) || `Inverter ${i + 1}`;
      if (!x || typeof x !== "object") { p.push(`inverter ${i + 1} is malformed`); continue; }
      if (!x.name) p.push(`inverter ${i + 1} needs a name`);
      if (typeof x.id !== "string" || !/^[a-z0-9_]+$/.test(x.id)) p.push(`${label}: id must be lowercase letters, digits and _`);
      else if (ids.has(x.id)) p.push(`${label}: another inverter has the id "${x.id}"`);
      ids.add(x.id);
      if (!INVERTER_SOURCES.includes(x.source)) { p.push(`${label}: integration must be one of ${INVERTER_SOURCES.join(", ")}`); continue; }
      if (x.source === "bridge" && !x.bridge_key) p.push(`${label}: pick which bridge inverter it is`);
      if (x.source === "bridge" && !(s.splink && s.splink.enabled)) p.push(`${label}: reads from the SP PRO bridge, which isn't enabled`);
      if (x.source === "fronius") {
        if (!x.host || !/^[a-zA-Z0-9.\-:]+$/.test(x.host)) p.push(`${label}: needs the inverter's IP or hostname`);
        if (!num(x.poll_seconds, 2, 300)) p.push(`${label}: poll must be 2-300 s`);
      }
      if (x.source === "ha") {
        if (!x.power_entity || !ENTITY_RE.test(x.power_entity)) p.push(`${label}: pick a power entity`);
        if (x.energy_entity && !ENTITY_RE.test(x.energy_entity)) p.push(`${label}: "${x.energy_entity}" isn't an entity id`);
      }
      if (x.ac_kw != null && !num(x.ac_kw, 0.1, 1000)) p.push(`${label}: AC rating must be positive kW`);
      if (x.kwp != null && !num(x.kwp, 0.1, 10000)) p.push(`${label}: array kWp must be positive (or empty to use what the inverter reports)`);
      if (x.source === "none" && x.kwp == null) p.push(`${label}: with no integration, the array kWp has to be entered`);
    }
  }
  return p;
}

/** Read settings.json, seeding it from the add-on options on first start. */
function loadSettings(options) {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    const s = normalise(raw);
    // An older shape was upgraded in memory: write it back once, so the file
    // matches what runs (the original is kept as .bak).
    if (JSON.stringify(s) !== JSON.stringify(raw)) {
      try { save(s); log.info(`upgraded ${SETTINGS_PATH} to the current format (previous kept as settings.json.bak)`); }
      catch (w) { log.warn(`could not rewrite ${SETTINGS_PATH}: ${w.message}`); }
    }
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

/** Pre-0.10 settings had one AC rating (and kWp override) for every inverter.
    Turn that into a bridge inverter per inverter the bridge reports, once.
    Returns the migrated settings, or null when there's nothing to migrate yet. */
function migrateSolar(s, discovered) {
  const legacy = s.solar || {};
  if ((legacy.inverters || []).length || legacy.inverter_ac_kw == null || !(discovered || []).length) return null;
  const next = JSON.parse(JSON.stringify(s));
  next.solar = {
    inverters: discovered.map((i) => ({
      id: i.key, name: i.name, source: "bridge", bridge_key: i.key,
      ac_kw: legacy.inverter_ac_kw, kwp: legacy.kwp == null ? null : legacy.kwp,
    })),
  };
  return next;
}

module.exports = { DEFAULTS, INVERTER_SOURCES, BATTERY_SOURCES, normalise, check, loadSettings, save, migrateSolar, SETTINGS_PATH };
