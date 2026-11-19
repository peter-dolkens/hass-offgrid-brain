/* Climate zones: their configuration, and reading their inputs and outputs.

   A zone is a space with its own temperature: one or more temperature sensors
   (averaged), optional humidity, any number of presence inputs (OR'ed: occupancy,
   motion or presence binary_sensors such as the wasp-in-a-box template sensors,
   person/device_tracker entities, or a count), window/door contacts, and outputs:

     ac        a climate entity that heats and/or cools (modes)
     hydronic  heat only: a climate entity (zone thermostat), or a valve/pump switch,
               optionally with a shared heat source (boiler / heat pump, climate or
               switch) that runs while any of its zones calls

   Settings live in settings.json under `climate`; see DEFAULTS. */
"use strict";
const { ENERGY_CLASSES, DEFAULTS: LEVEL_DEFAULTS } = require("./levels.js");

const DEFAULTS = Object.freeze({
  enabled: false,
  presence_entity: "",      // house-level: someone home (off / not_home = away)
  weather_entity: "",       // weather.* with an hourly (or daily) forecast
  learn_days: 14,           // HA history replayed into the learners on first start
  heat_c: 20, cool_c: 25,   // comfort setpoints until preferences are learned
  ...LEVEL_DEFAULTS,        // setback_c, away_c, soak_c, protect_min_c, protect_max_c
  soak_enabled: false,      // surplus into thermal mass: off until validated on real hardware
  precondition_max_min: 120,
  precondition_grace_min: 90,
  occupancy_threshold: 0.5,
  override_hold_min: 120,
  window_delay_s: 60,
  vacancy_delay_min: 10,
  zones: [],
});

const ZONE_DEFAULTS = Object.freeze({
  id: "", name: "", area: "", area_m2: 20,
  temp_entities: [], humidity_entity: "", presence_entities: [], contact_entities: [],
  // null = the climate-wide value (and, for heat/cool, then learned)
  heat_c: null, cool_c: null, setback_c: null, protect_min_c: null, protect_max_c: null,
  priority: 5, energy_class: "comfort",
  device: "",               // a policy device this zone takes over (legacy sp rules)
  advisory_kw: 1.5,         // modelled rating while the zone has no outputs
  advise_only: false,       // plan and advise, never command (whatever dry_run says)
  auto_ladder: true,
  outputs: [],
});

const OUTPUT_KINDS = ["ac", "hydronic"];
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const SWITCHY = ["switch", "input_boolean", "valve", "fan"];
const num = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const list = (v) => (Array.isArray(v) ? v : typeof v === "string" && v ? v.split(/[\s,]+/) : []).map((x) => String(x).trim()).filter(Boolean);

function normaliseOutput(o) {
  const kind = OUTPUT_KINDS.includes(o && o.kind) ? o.kind : "ac";
  const isPump = kind === "hydronic";
  const modes = list(o && o.modes).filter((m) => m === "heat" || m === "cool");
  return {
    kind,
    entity: (o && o.entity) || "",
    kw: o && Number.isFinite(o.kw) ? o.kw : 1.5,
    modes: kind === "hydronic" ? ["heat"] : modes.length ? modes : ["heat", "cool"],
    min_on_s: o && Number.isFinite(o.min_on_s) ? o.min_on_s : isPump ? 180 : 300,
    min_off_s: o && Number.isFinite(o.min_off_s) ? o.min_off_s : isPump ? 180 : 300,
    // Measured electrical draw (a circuit meter such as a Shelly Pro 3EM): W or kW.
    // Several outputs may name the same meter (a shared circuit); attribution is then
    // approximate (consumption.attribute). An energy counter stands in for power.
    power_entity: (o && o.power_entity) || "",
    energy_entity: (o && o.energy_entity) || "",
    // The meter's circuit carries only climate units (no other loads).
    meter_climate_only: !!(o && o.meter_climate_only),
    source_entity: (o && o.source_entity) || "",
    source_power_entity: (o && o.source_power_entity) || "",
  };
}

function normaliseZone(z) {
  const out = { ...JSON.parse(JSON.stringify(ZONE_DEFAULTS)), ...(z || {}) };
  for (const k of ["temp_entities", "presence_entities", "contact_entities"]) out[k] = list(out[k]);
  out.outputs = (Array.isArray(out.outputs) ? out.outputs : []).map(normaliseOutput);
  if (!ENERGY_CLASSES.includes(out.energy_class)) out.energy_class = "comfort";
  out.advise_only = !!out.advise_only;
  return out;
}

function normalise(from) {
  const out = { ...JSON.parse(JSON.stringify(DEFAULTS)), ...(from && typeof from === "object" ? from : {}) };
  out.zones = (Array.isArray(out.zones) ? out.zones : []).map(normaliseZone);
  return out;
}

/** Problems normalising would hide (it coerces unknown kinds and classes):
    checked on the settings as submitted. */
function checkRaw(c) {
  const p = [];
  if (!c || typeof c !== "object" || !Array.isArray(c.zones)) return p;
  for (const [i, z] of c.zones.entries()) {
    const label = (z && z.name) || `zone ${i + 1}`;
    if (!z || typeof z !== "object") continue;
    if (z.energy_class != null && !ENERGY_CLASSES.includes(z.energy_class)) p.push(`${label}: energy class must be one of ${ENERGY_CLASSES.join(", ")}`);
    if (z.outputs != null && !Array.isArray(z.outputs)) p.push(`${label}: outputs must be a list`);
    for (const [j, o] of (Array.isArray(z.outputs) ? z.outputs : []).entries()) {
      if (!o || typeof o !== "object") { p.push(`${label} output ${j + 1} is malformed`); continue; }
      if (o.kind != null && !OUTPUT_KINDS.includes(o.kind)) p.push(`${label} output ${j + 1}: kind must be ${OUTPUT_KINDS.join(" or ")}`);
      if (o.modes != null && list(o.modes).some((m) => m !== "heat" && m !== "cool")) p.push(`${label} output ${j + 1}: modes may only be heat and cool`);
      if (o.kw != null && !num(o.kw, 0, 100)) p.push(`${label} output ${j + 1}: kW must be 0-100`);
    }
  }
  return p;
}

/** Problems that make the climate settings unusable; empty = OK. */
function check(c) {
  const p = [];
  if (!c || typeof c !== "object") return ["climate settings must be an object"];
  if (typeof c.enabled !== "boolean") p.push("climate: enabled must be true or false");
  if (typeof c.soak_enabled !== "boolean") p.push("climate: soak must be on or off");
  for (const k of ["presence_entity", "weather_entity"]) if (c[k] && !ENTITY_RE.test(c[k])) p.push(`climate: "${c[k]}" isn't an entity id`);
  if (c.weather_entity && !c.weather_entity.startsWith("weather.")) p.push("climate: the weather entity must be a weather.* entity");
  if (!num(c.heat_c, 5, 30)) p.push("climate: heat setpoint must be 5-30 °C");
  if (!num(c.cool_c, 15, 35)) p.push("climate: cool setpoint must be 15-35 °C");
  if (num(c.heat_c, 5, 30) && num(c.cool_c, 15, 35) && !(c.cool_c - c.heat_c >= 1)) p.push("climate: the cool setpoint must be at least 1 °C above the heat setpoint");
  for (const k of ["setback_c", "away_c", "soak_c"]) if (!num(c[k], 0, 15)) p.push(`climate: ${k} must be 0-15 °C`);
  if (!num(c.protect_min_c, 0, 25) || !num(c.protect_max_c, 20, 45) || !(c.protect_max_c > c.protect_min_c)) p.push("climate: protection limits must be 0-25 and 20-45 °C, min below max");
  if (!num(c.learn_days, 0, 60)) p.push("climate: learn days must be 0-60");
  if (!num(c.precondition_max_min, 0, 720)) p.push("climate: pre-conditioning lead must be 0-720 min");
  if (!num(c.precondition_grace_min, 0, 240)) p.push("climate: pre-conditioning grace must be 0-240 min");
  if (!num(c.occupancy_threshold, 0.05, 0.95)) p.push("climate: occupancy threshold must be 0.05-0.95");
  if (!num(c.override_hold_min, 0, 1440)) p.push("climate: override hold must be 0-1440 min");
  if (!num(c.window_delay_s, 0, 3600)) p.push("climate: window delay must be 0-3600 s");
  if (!num(c.vacancy_delay_min, 0, 240)) p.push("climate: vacancy delay must be 0-240 min");
  if (!Array.isArray(c.zones)) return [...p, "climate: zones must be a list"];
  const ids = new Set(), devices = new Set();
  for (const [i, z] of c.zones.entries()) {
    const label = (z && z.name) || `zone ${i + 1}`;
    if (!z || typeof z !== "object") { p.push(`climate zone ${i + 1} is malformed`); continue; }
    if (!z.name) p.push(`climate zone ${i + 1} needs a name`);
    if (typeof z.id !== "string" || !/^[a-z0-9_]+$/.test(z.id)) p.push(`${label}: id must be lowercase letters, digits and _`);
    else if (ids.has(z.id)) p.push(`${label}: another zone has the id "${z.id}"`);
    ids.add(z.id);
    if (!(z.temp_entities || []).length) p.push(`${label}: pick at least one temperature sensor`);
    for (const k of ["temp_entities", "presence_entities", "contact_entities"]) {
      for (const e of z[k] || []) if (!ENTITY_RE.test(e)) p.push(`${label}: "${e}" isn't an entity id`);
    }
    if (z.humidity_entity && !ENTITY_RE.test(z.humidity_entity)) p.push(`${label}: "${z.humidity_entity}" isn't an entity id`);
    for (const k of ["heat_c", "cool_c", "setback_c", "protect_min_c", "protect_max_c"]) {
      if (z[k] != null && !num(z[k], 0, 45)) p.push(`${label}: ${k} must be a temperature or empty`);
    }
    const heat = z.heat_c != null ? z.heat_c : c.heat_c, cool = z.cool_c != null ? z.cool_c : c.cool_c;
    if (!(cool - heat >= 1)) p.push(`${label}: the cool setpoint must be at least 1 °C above the heat setpoint`);
    if (!num(z.priority, 0, 100)) p.push(`${label}: priority must be 0-100`);
    if (!ENERGY_CLASSES.includes(z.energy_class)) p.push(`${label}: energy class must be one of ${ENERGY_CLASSES.join(", ")}`);
    if (!num(z.area_m2, 1, 2000)) p.push(`${label}: floor area must be 1-2000 m²`);
    if (!num(z.advisory_kw, 0, 100)) p.push(`${label}: advisory kW must be 0-100`);
    if (z.device) {
      if (!/^[a-z0-9_]+$/i.test(z.device)) p.push(`${label}: device "${z.device}" isn't a device id`);
      if (devices.has(z.device)) p.push(`${label}: another zone already takes over device "${z.device}"`);
      devices.add(z.device);
    }
    for (const [j, o] of (z.outputs || []).entries()) {
      const ol = `${label} output ${j + 1}`;
      if (!OUTPUT_KINDS.includes(o.kind)) { p.push(`${ol}: kind must be ${OUTPUT_KINDS.join(" or ")}`); continue; }
      if (!o.entity || !ENTITY_RE.test(o.entity)) { p.push(`${ol}: pick its entity`); continue; }
      const dom = o.entity.split(".")[0];
      if (o.kind === "ac" && dom !== "climate") p.push(`${ol}: an A/C output must be a climate entity`);
      if (o.kind === "hydronic" && dom !== "climate" && !SWITCHY.includes(dom)) p.push(`${ol}: a hydronic output must be a climate entity or a switch/valve`);
      if (!num(o.kw, 0, 100)) p.push(`${ol}: kW must be 0-100`);
      if (!num(o.min_on_s, 0, 7200) || !num(o.min_off_s, 0, 7200)) p.push(`${ol}: minimum run/off times must be 0-7200 s`);
      for (const k of ["power_entity", "energy_entity", "source_entity", "source_power_entity"]) if (o[k] && !ENTITY_RE.test(o[k])) p.push(`${ol}: "${o[k]}" isn't an entity id`);
      if (o.source_entity && !["climate", ...SWITCHY].includes(o.source_entity.split(".")[0])) p.push(`${ol}: the heat source must be a climate entity or a switch`);
    }
  }
  return p;
}

/** Every entity a zone reads or drives. */
function zoneEntities(z) {
  return [...z.temp_entities, z.humidity_entity, ...z.presence_entities, ...z.contact_entities,
    ...z.outputs.flatMap((o) => [o.entity, o.power_entity, o.energy_entity, o.source_entity, o.source_power_entity])].filter(Boolean);
}

const UNKNOWN = new Set(["unavailable", "unknown", "", null, undefined]);
const PRESENT = new Set(["on", "home", "occupied", "detected", "true"]);
const SENSOR_STALE_SEC = 3 * 3600;

/** One presence input: true / false, or null when unknown (unavailable is NOT empty). */
function presenceOf(st) {
  if (!st || UNKNOWN.has(st.state)) return null;
  const n = Number(st.state);
  if (Number.isFinite(n) && String(st.state).trim() !== "") return n > 0;
  return PRESENT.has(String(st.state).toLowerCase());
}

/** OR over presence inputs: true if any is present, false if all known are absent
    and at least one is known, null if all are unknown (or none configured). */
function anyPresent(states) {
  let known = false;
  for (const st of states) { const v = presenceOf(st); if (v === true) return true; if (v === false) known = true; }
  return known ? false : null;
}

/** Power in kW from a W/kW entity state; NaN when unknown. */
function powerKwOf(st) {
  if (!st || UNKNOWN.has(st.state) || !Number.isFinite(parseFloat(st.state))) return NaN;
  const unit = String((st.attributes || {}).unit_of_measurement || "W").toLowerCase();
  return parseFloat(st.state) * (unit === "kw" ? 1 : unit === "mw" ? 1000 : 0.001);
}

/** What a unit is doing, by its own account: "heat", "cool" or null. With no
    hvac_action it's inferred from its mode and the room (its own current_temperature,
    else the zone's) against its setpoint, so a unit idling at setpoint isn't "running".
    Dry and fan-only are neither: they don't heat, and aren't the brain's to plan. */
function runningSide(st, roomT = NaN) {
  if (!st || UNKNOWN.has(st.state)) return null;
  const a = st.attributes || {};
  if (a.hvac_action) return a.hvac_action === "heating" || a.hvac_action === "preheating" ? "heat" : a.hvac_action === "cooling" ? "cool" : null;
  const T = Number.isFinite(a.current_temperature) ? a.current_temperature : roomT;
  const sp = a.temperature;
  if (st.state === "heat") return Number.isFinite(T) && Number.isFinite(sp) ? (T < sp ? "heat" : null) : "heat";
  if (st.state === "cool") return Number.isFinite(T) && Number.isFinite(sp) ? (T > sp ? "cool" : null) : "cool";
  if (st.state === "heat_cool" || st.state === "auto") {
    if (Number.isFinite(T) && Number.isFinite(a.target_temp_low) && T < a.target_temp_low) return "heat";
    if (Number.isFinite(T) && Number.isFinite(a.target_temp_high) && T > a.target_temp_high) return "cool";
    return null;
  }
  if (st.state === "on" || st.state === "open") return "heat";   // a valve or pump
  return null;
}
const claimsRunning = (st, roomT) => runningSide(st, roomT) != null;

/** An output's state as the brain sees it. `meteredKw` is its measured draw (NaN:
    no meter), already attributed when the meter is shared. Running power is the
    meter's when there is one, else the configured kW while the unit runs. */
function readOutput(o, get, meteredKw = NaN, roomT = NaN) {
  const st = get(o.entity), dom = o.entity.split(".")[0];
  const metered = Number.isFinite(meteredKw);
  if (!st || UNKNOWN.has(st.state)) {
    return { entity: o.entity, available: false, on: false, mode: null, setpoint: NaN, action: null, running: false,
             heatKw: 0, coolKw: 0, meteredKw, context: st ? st.context : null };
  }
  const a = st.attributes || {};
  const side = runningSide(st, roomT);
  if (dom === "climate") {
    const mode = st.state;   // off / heat / cool / heat_cool / auto / dry / fan_only
    const kw = metered ? meteredKw : side ? o.kw : 0;
    // A metered unit drawing power in dry mode is cooling (dehumidifying); fan-only isn't either.
    const cooling = side === "cool" || (mode === "dry" && metered && meteredKw > 0.08);
    return { entity: o.entity, available: true, on: mode !== "off", mode,
             setpoint: Number.isFinite(a.temperature) ? a.temperature : NaN,
             low: Number.isFinite(a.target_temp_low) ? a.target_temp_low : NaN,
             high: Number.isFinite(a.target_temp_high) ? a.target_temp_high : NaN,
             step: Number.isFinite(a.target_temp_step) && a.target_temp_step > 0 ? a.target_temp_step : 0.5,
             minTemp: Number.isFinite(a.min_temp) ? a.min_temp : 7, maxTemp: Number.isFinite(a.max_temp) ? a.max_temp : 35,
             action: a.hvac_action || null, running: !!side,
             heatKw: side === "heat" ? kw : 0, coolKw: cooling ? (metered ? meteredKw : kw) : 0,
             meteredKw, context: st.context || null, changedMs: st.changedMs };
  }
  const on = st.state === "on" || st.state === "open";
  const kw = metered ? meteredKw : on ? o.kw : 0;
  return { entity: o.entity, available: true, on, running: on, mode: on ? "heat" : "off", setpoint: NaN, action: null,
           heatKw: kw, coolKw: 0, meteredKw, context: st.context || null, changedMs: st.changedMs };
}

/** A zone's readings at a moment. `get(entity)` -> { state, attributes, ageSec } | null.
    A temperature sensor counts while available and reported within 3 h (Home
    Assistant's last_reported, not when the brain heard of it). */
function readZone(z, get, meteredKw = () => NaN) {
  const fresh = z.temp_entities.map((id) => [id, get(id)])
    .filter(([, s]) => s && !UNKNOWN.has(s.state) && !(s.ageSec > SENSOR_STALE_SEC))
    .map(([id, s]) => [id, parseFloat(s.state)]).filter(([, v]) => Number.isFinite(v) && v > -40 && v < 70);
  const temp = fresh.length ? fresh.reduce((a, [, v]) => a + v, 0) / fresh.length : NaN;
  const hum = z.humidity_entity ? get(z.humidity_entity) : null;
  const outputs = z.outputs.map((o, i) => readOutput(o, get, meteredKw(`${z.id}#${i}`), temp));
  return {
    temp, tempIds: fresh.map(([id]) => id).join(","),
    humidity: hum && !UNKNOWN.has(hum.state) ? parseFloat(hum.state) : NaN,
    presence: z.presence_entities.length ? anyPresent(z.presence_entities.map(get)) : null,
    windowOpen: z.contact_entities.some((e) => { const s = get(e); return s && (s.state === "on" || s.state === "open"); }),
    outputs,
    heatKw: outputs.reduce((t, o) => t + o.heatKw, 0),
    coolKw: outputs.reduce((t, o) => t + o.coolKw, 0),
  };
}

/** Which sides a zone can serve, and its rating (kW electrical) on each. A zone
    with no outputs is advisory: both sides at its advisory kW. `rating(o, i, side)`
    gives an output's running draw (the learned consumption curve where metered);
    the configured kW otherwise. */
function capability(z, rating = (o) => o.kw) {
  if (!z.outputs.length) return { heat: z.advisory_kw, cool: z.advisory_kw, advisory: true };
  const sum = (side) => z.outputs.reduce((t, o, i) => t + (o.modes.includes(side) ? rating(o, i, side) : 0), 0);
  return { heat: sum("heat"), cool: sum("cool"), advisory: false };
}

/** A zone with no outputs: planned and shown, but it has nothing real to power. */
const isAdvisory = (z) => !z.outputs.length;

module.exports = { DEFAULTS, ZONE_DEFAULTS, OUTPUT_KINDS, normalise, normaliseZone, check, checkRaw, zoneEntities,
                   readZone, readOutput, presenceOf, anyPresent, capability, isAdvisory, powerKwOf, claimsRunning, runningSide, UNKNOWN };
