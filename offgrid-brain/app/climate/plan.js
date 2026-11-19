/* Planning one zone for one moment: which side (heat / cool), the comfort band, and
   what each comfort level would ask of the ladder.

   A pure function of its inputs, so the projection can call it for future steps
   and the tests can call it with synthetic zones. The ladder (ladder.js) decides
   which level the battery can afford; resolve() turns that into a setpoint.

   Setpoints follow the simulator's `sp` convention: an offset from the comfort
   setpoint toward ambient. Heating holds `heat - sp`, cooling holds `cool + sp`;
   sp < 0 goes past the comfort setpoint (soak, thermal storage). */
"use strict";
const { LEVELS } = require("./levels.js");

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : x);
const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * @param {object} o
 * @param {object} o.zone        normalised zone (zones.js)
 * @param {object} o.cfg         climate settings (protect, setback, soak, ...)
 * @param {object} o.cap         capability(zone): { heat kW, cool kW }
 * @param {object} o.model       ThermalModel to plan with (the fit, or its prior below the gate)
 * @param {number} o.temp        room °C (NaN unknown)
 * @param {number} o.humidity    %RH (NaN unknown)
 * @param {boolean} [o.humid]    muggy, with hysteresis decided by the caller (default: humidity > 70)
 * @param {number} o.tout        outdoor °C now (NaN unknown: never assumed)
 * @param {object} [o.toutLater] { min, max } outdoor °C over the next 12 h
 * @param {object} o.comfort     { heat, cool, confidence } learned/configured setpoints
 * @param {boolean} o.occupied   occupied now
 * @param {boolean} o.away       the house is away
 * @param {number|null} o.nextOccMin  minutes until likely occupied (0: expected now; null: not soon)
 * @param {boolean} [o.precondLatched] pre-conditioning already under way for an expected arrival
 * @param {boolean} o.expectOcc  occupied now or likely within 12 h
 * @param {boolean} o.windowOpen a window/door has been open long enough
 * @param {object|null} o.override  { mode, setpoint, until } a person's setting being respected
 * @param {object} o.outlook     { fullSoon, shedSoon, tight } from the low-case projection
 * @param {boolean} o.sun        solar is producing now
 * @param {number} o.soc         battery %
 * @param {string|null} o.prevSide
 * @param {boolean} [o.noReading] live planning with no room temperature: fall back to the
 *                               unit's own thermostat at the setback/protection setpoint
 */
function planZone(o) {
  const { zone, cfg, cap, model } = o;
  const outlook = o.outlook || {};
  const temp = o.temp, tout = o.tout;
  const hasTout = Number.isFinite(tout);
  const val = (k) => (zone[k] != null ? zone[k] : cfg[k]);
  const protectMin = val("protect_min_c"), protectMax = val("protect_max_c");

  // ---- comfort band ----
  let heat = o.comfort.heat, cool = o.comfort.cool;
  const humid = o.humid != null ? !!o.humid : Number.isFinite(o.humidity) && o.humidity > 70;
  if (humid) cool -= 1;                                    // muggy air feels warmer
  const manual = o.override && o.override.until > (o.now || 0) ? o.override : null;
  if (manual && Number.isFinite(manual.setpoint)) {
    if (manual.mode === "heat") heat = manual.setpoint;
    if (manual.mode === "cool") cool = manual.setpoint;
  }
  if (cool - heat < 1) { const mid = (heat + cool) / 2; heat = mid - 0.5; cool = mid + 0.5; }
  const inBand = Number.isFinite(temp) && temp >= heat && temp <= cool;

  // ---- side ----
  let side = null;
  if (Number.isFinite(temp)) {
    if (temp < heat - 0.3) side = "heat";
    else if (temp > cool + 0.3) side = "cool";
    else if (hasTout) {
      const drift = model.rate(temp, tout);
      side = Math.abs(drift) < 0.1 && o.prevSide ? o.prevSide : drift < 0 ? "heat" : "cool";
    } else side = o.prevSide || (temp < (heat + cool) / 2 ? "heat" : "cool");
  } else if (hasTout) side = tout < heat ? "heat" : tout > cool ? "cool" : o.prevSide || (tout < (heat + cool) / 2 ? "heat" : "cool");
  else side = o.prevSide || "heat";
  if (manual && (manual.mode === "heat" || manual.mode === "cool")) side = manual.mode;
  if (side && !(cap[side] > 0)) side = null;        // e.g. heat-only hydronic in summer

  // Which side surplus should be banked toward: the one the next 12 h will need.
  let soakSide = null;
  const later = o.toutLater;
  if (later && Number.isFinite(later.max) && Number.isFinite(later.min)) {
    const hot = later.max - (cool + 1), cold = (heat - 1) - later.min;
    if (hot > 0 && cap.cool > 0 && hot >= cold) soakSide = "cool";
    else if (cold > 0 && cap.heat > 0) soakSide = "heat";
  }

  // ---- level offsets (the shared table's meaning, with this zone's numbers) ----
  const setbackSp = (o.away ? cfg.away_c : val("setback_c")) + (outlook.tight ? 1 : 0);
  const comfortSet = (s) => (s === "cool" ? cool : heat);
  const setpointFor = (s, sp) => (s === "cool" ? cool + sp : heat - sp);
  const spFor = (level, s) => {
    switch (level) {
      case "protect": return Math.max(setbackSp, s === "cool" ? protectMax - cool : heat - protectMin);
      case "setback": return setbackSp;
      case "soak": return s === "cool" ? -(cool - Math.max(cool - cfg.soak_c, heat + 0.5)) : -(Math.min(heat + cfg.soak_c, cool - 0.5) - heat);
      default: return 0;
    }
  };

  /** kW (electrical) the zone needs to bring the room to the setpoint for `sp`. */
  const kwFor = (sp, s = side, hours = 1) => {
    if (!s || !(cap[s] > 0)) return 0;
    const set = setpointFor(s, sp);
    const wrong = (T) => (s === "cool" ? T - set : set - T);   // > 0: on the wrong side
    if (!hasTout) {
      // No outdoor reading: no model. Full power while well short, nothing past it;
      // unknown room: a third of the rating to hold a setback, nothing for protection
      // (which is never shed, so a guess there would be a standing false deficit).
      if (!Number.isFinite(temp)) return r3(sp > setbackSp ? 0 : cap[s] / 3);
      return r3(clamp(wrong(temp) / 2, 0, 1) * cap[s]);
    }
    if (!Number.isFinite(temp)) return r3(clamp(model.holdKw(set, tout, s), 0, cap[s]));
    const reach = model.kwToReach(temp, set, tout, hours, s);
    const near = wrong(temp) > -0.5;
    return r3(clamp(Math.max(reach, near ? model.holdKw(set, tout, s) : 0), 0, cap[s]));
  };

  // ---- pre-conditioning lead: how long the room takes to reach comfort ----
  let leadMin = 30;
  if (side && Number.isFinite(temp) && hasTout) {
    const h = model.hoursToReach(temp, comfortSet(side), tout, cap[side] * 0.8, side);
    leadMin = Number.isFinite(h) ? h * 60 * 1.25 + 10 : cfg.precondition_max_min;
  }
  leadMin = Math.round(clamp(leadMin, 10, cfg.precondition_max_min));

  const fallback = !!o.noReading;
  const blocked = o.windowOpen ? "window" : manual && manual.mode === "off" ? "manual-off" : !side && !soakSide ? "no-side" : null;
  const levels = {};
  for (const level of LEVELS) {
    const s = level === "soak" ? soakSide : side;
    const sp = s ? spFor(level, s) : 0;
    let active = !blocked && !!s, why = "";
    if (level === "protect") why = `hold ${r1(setpointFor(s, sp))} °C (protection)`;
    else if (level === "setback") why = o.away ? "house away: widest comfort band" : "outside occupied hours";
    else if (level === "comfort") {
      active = active && !fallback && (o.occupied || !!manual);
      why = manual ? "your setting" : "occupied";
    } else if (level === "precondition") {
      // 0 = the learned pattern says people are due now: keep going for the grace period.
      const soon = (o.nextOccMin != null && o.nextOccMin <= leadMin) || !!o.precondLatched;
      active = active && !fallback && !o.occupied && !manual && !o.away && soon && !(outlook.tight && leadMin > 30 && !o.precondLatched);
      why = o.nextOccMin === 0 ? "usually occupied by now" : o.nextOccMin != null ? `likely occupied in ${o.nextOccMin} min; reaching comfort takes ~${leadMin} min` : o.precondLatched ? "arrival expected" : "";
    } else if (level === "soak") {
      const reason = outlook.fullSoon ? "surplus forecast" : outlook.shedSoon ? "comfort projected to shed later" : o.soc >= 98 ? "battery full" : null;
      // Never against the side the room needs now, unless the room is already comfortable.
      const sideOk = s === side || inBand;
      active = active && !!cfg.soak_enabled && !fallback && !manual && !!o.sun && !!reason && !!o.expectOcc && sideOk;
      why = !cfg.soak_enabled ? "soak is off" : s ? `bank ${s === "cool" ? "cooling" : "heat"} for later (${reason || "no surplus"})` : "";
    }
    const hours = level === "precondition" && o.nextOccMin ? Math.max(0.25, o.nextOccMin / 60) : 1;
    levels[level] = { sp: r1(sp), side: s, setpoint: s ? r1(setpointFor(s, sp)) : null, kw: s ? kwFor(sp, s, hours) : 0, active, why };
  }
  // Tighter levels never ask for less than looser ones (the ladder tops up).
  let floorKw = 0;
  for (const level of ["protect", "setback", "comfort", "precondition"]) {
    levels[level].kw = Math.max(levels[level].kw, floorKw);
    floorKw = levels[level].kw;
  }
  if (levels.soak.side === side) levels.soak.kw = Math.max(levels.soak.kw, levels.comfort.kw);

  return {
    id: zone.id, name: zone.name, side, soakSide, temp: r1(temp), humidity: o.humidity, tout: r1(tout),
    comfort: { heat: r1(heat), cool: r1(cool), confidence: o.comfort.confidence, humid }, inBand,
    occupied: !!o.occupied, away: !!o.away, nextOccMin: o.nextOccMin, leadMin, blocked, fallback, manual,
    levels, cap, ratedKw: Math.max(cap.heat || 0, cap.cool || 0),
    gap: side && hasTout ? r1(Math.abs(tout - comfortSet(side))) : 0,
    setpointFor, spFor, kwFor,
    coastHours: (limit) => (Number.isFinite(temp) && hasTout ? model.coastHours(temp, limit, tout) : NaN),
    band: (level) => (level ? { low: r1(setpointFor("heat", spFor(level, "heat"))), high: r1(setpointFor("cool", spFor(level, "cool"))) } : null),
  };
}

/** A plan without its functions, for the panel and MQTT. */
function plain(plan) {
  const { setpointFor, spFor, kwFor, band, coastHours, ...rest } = plan;
  return rest;
}

module.exports = { planZone, plain };
