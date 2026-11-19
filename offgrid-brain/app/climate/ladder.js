/* Climate in the dispatch ladder.

   expand() rewrites a policy so decide() can walk it unchanged:
     - { type: "climate", zone, level, cond?, floor?, important? } becomes a load entry
       on the zone's device, with the planner's kW for that level (`kw`), the zone's
       own `occ` and `gap` (`vars`, as the simulator gives zone entries), a condition
       that is 0 unless the planner says the level applies (AND the entry's own
       `cond`), its own hysteresis key (`hkey`), and its `floor` if given;
     - protect entries are gen-like: never shed (a deficit if they can't be served),
       so they also run in safe mode;
     - legacy load entries on a device a zone has taken over (zone.device) keep their
       `cond` and `sp`, and get the modelled kW for that sp and the zone's occ/gap;
     - zones with no entries are placed automatically (levels.FLOORS): protect just
       above the first charge rung, setback/comfort/precondition just after it with
       their own battery floors, soak at the end of the list on a 100% floor.

   Advisory zones (no outputs) have nothing real to power, so the real walk leaves
   them out; a shadow walk with them in (advisory: true) says what they would get.

   resolve() reads the walk back: per zone, the tightest level that was granted (or
   needed nothing more than an earlier one already got) sets the band. Active levels
   with none granted is a hard shed: off. */
"use strict";
const { LEVELS, autoFloor, importantByDefault } = require("./levels.js");
const { isAdvisory } = require("./zones.js");

const devIdOf = (z) => z.device || `climate_${z.id}`;

function levelEntry(z, plan, level, e = {}) {
  const l = plan && plan.levels[level];
  const user = e.cond != null && String(e.cond).trim() !== "" ? String(e.cond) : "1";
  const dev = devIdOf(z);
  const out = {
    type: "load", dev,
    cond: l && l.active ? user : "0",
    kw: l ? l.kw : 0,
    vars: { occ: plan && plan.occupied ? 1 : 0, gap: plan ? plan.gap : 0 },
    important: e.important != null ? !!e.important : importantByDefault(z.energy_class, level),
    gen: level === "protect" ? e.gen !== false : !!e.gen,
    hkey: `${dev}#${level}`,
    climate: { zone: z.id, level, sp: l ? l.sp : 0, side: l ? l.side : null, setpoint: l ? l.setpoint : null, why: l ? l.why : "" },
  };
  if (Number.isFinite(e.floor)) out.floor = e.floor;
  if (e.auto) out.auto = true;
  return out;
}

function ruleEntry(z, plan, e) {
  const sp = Number.isFinite(e.sp) ? e.sp : 0;
  const side = plan ? (sp < 0 && plan.soakSide ? plan.soakSide : plan.side) : null;
  const usable = plan && !plan.blocked && side;
  return {
    ...e,
    cond: usable ? (e.cond == null ? "0" : String(e.cond)) : "0",
    kw: usable ? plan.kwFor(sp, side) : 0,
    vars: { occ: plan && plan.occupied ? 1 : 0, gap: plan ? plan.gap : 0 },
    hkey: `${devIdOf(z)}#sp${sp}`,
    climate: { zone: z.id, level: sp < 0 ? "soak" : sp === 0 ? "comfort" : "rule", rule: true, sp, side,
               setpoint: usable ? Math.round(plan.setpointFor(side, sp) * 10) / 10 : null, why: e.cond ? `rule: ${e.cond}` : "rule" },
  };
}

/**
 * @param {object} policy  { devices, list }
 * @param {object[]} zones normalised zones
 * @param {Map<string, object>} plans  zone id -> plan (missing: the zone's entries stay idle)
 * @param {{ advisory?: boolean }} [opt]  include advisory zones (the shadow walk)
 * @returns {{ devices, list, warnings }}
 */
function expand(policy, zones, plans, { advisory = false } = {}) {
  // An advisory zone that takes over a load leaves that load as it was in the real walk.
  const active = zones.filter((z) => advisory || !isAdvisory(z));
  const dropped = new Set(zones.filter((z) => !active.includes(z)).map((z) => z.id));
  if (!active.length && !dropped.size) return policy;
  const byId = new Map(active.map((z) => [z.id, z]));
  const byDev = new Map(active.map((z) => [devIdOf(z), z]));
  const known = new Set(policy.devices.map((d) => d.id));
  const devices = policy.devices.map((d) => (byDev.has(d.id) ? { ...d, climate: byDev.get(d.id).id } : d));
  for (const z of active) {
    if (known.has(devIdOf(z))) continue;
    const p = plans.get(z.id);
    devices.push({ id: devIdOf(z), name: z.name, kw: p ? p.ratedKw : 0, climate: z.id, advisory: isAdvisory(z) });
  }

  const explicit = new Set(), warnings = [];
  const list = [];
  let rungFloor = 0;
  for (const e of policy.list) {
    if (e && e.type === "charge") rungFloor = Math.max(rungFloor, e.to);
    if (e && e.type === "climate") {
      if (dropped.has(e.zone)) continue;                 // advisory: only in the shadow walk
      const z = byId.get(e.zone);
      if (!z) { list.push({ ...e, type: "climate-unknown" }); continue; }
      explicit.add(z.id);
      if (rungFloor >= 100 && e.level !== "soak" && e.level !== "protect") {
        warnings.push(`${z.name}: its ${e.level} entry sits below the 100% charge rung, so it only ever runs on surplus`);
      }
      list.push(levelEntry(z, plans.get(z.id), e.level, e));
    } else if (e && e.type === "load" && byDev.has(e.dev)) {
      const z = byDev.get(e.dev);
      explicit.add(z.id);
      list.push(ruleEntry(z, plans.get(z.id), e));
    } else list.push(e);
  }

  // Zones with no entries of their own: protect above the first rung (gen-like),
  // setback/comfort/precondition right after it on their own floors, soak at the end.
  const auto = active.filter((z) => !explicit.has(z.id) && z.auto_ladder !== false)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  if (!auto.length) return { devices, list, warnings };
  const first = list.findIndex((e) => e && e.type === "charge");
  const top = first < 0 ? list.length : first, after = first < 0 ? list.length : first + 1;
  const inserts = [];
  for (const z of auto) {
    LEVELS.forEach((level, li) => {
      const f = autoFloor(z.energy_class, level);
      if (f == null) return;
      const entry = levelEntry(z, plans.get(z.id), level, { auto: true, ...(f === "gen" ? {} : { floor: f }) });
      const pos = f === "gen" ? top : level === "soak" ? list.length : after;
      inserts.push({ pos, li, prio: z.priority, entry });
    });
  }
  inserts.sort((a, b) => a.pos - b.pos || a.li - b.li || a.prio - b.prio);
  const out = [];
  let k = 0;
  for (let i = 0; i <= list.length; i++) {
    while (k < inserts.length && inserts[k].pos === i) out.push(inserts[k++].entry);
    if (i < list.length) out.push(list[i]);
  }
  return { devices, list: out, warnings };
}

const ALLOWED = new Set(["granted", "already-served", "deficit"]);

/**
 * One decision per zone from the dispatch result.
 * @param {object} [shadow]  a walk including advisory zones; their decisions come from it
 * @returns {Map<string, object>} zone id -> { state, level, sp, side, setpoint, mode, kw, reason, refused }
 *   state: running | coast | shed | idle | manual | fallback
 */
function resolve(zones, plans, result, shadow = null) {
  const rowsOf = (res) => {
    const m = new Map(zones.map((z) => [z.id, []]));
    for (const t of (res && res.trace) || []) if (t.climate && m.has(t.climate.zone)) m.get(t.climate.zone).push(t);
    return m;
  };
  const real = rowsOf(result), sh = shadow ? rowsOf(shadow) : null;
  const kwOf = (res) => new Map(((res && res.decisions) || []).map((d) => [d.id, d.run ? d.kw : 0]));
  const kwReal = kwOf(result), kwShadow = kwOf(shadow);
  const out = new Map();
  for (const z of zones) {
    const plan = plans.get(z.id), adv = isAdvisory(z);
    const rows = (adv && sh ? sh : real).get(z.id);
    const all = rows.filter((t) => t.f > 1e-9);
    // Soak toward the other side never wins over what the room needs now (H2).
    const fits = (t) => !(plan && t.climate.level === "soak" && t.climate.side !== plan.side && !plan.inBand);
    const allowed = all.filter((t) => ALLOWED.has(t.outcome) && fits(t));
    const refused = all.filter((t) => !ALLOWED.has(t.outcome));
    const best = allowed.reduce((b, t) => (!b || t.climate.sp < b.climate.sp ? t : b), null);
    const kw = adv ? 0 : kwReal.get(devIdOf(z)) || 0;
    const refusedNames = [...new Set(refused.filter((t) => !best || t.climate.sp < best.climate.sp).map((t) => t.climate.level))];
    const d = { zone: z.id, kw, shadowKw: adv ? kwShadow.get(devIdOf(z)) || 0 : undefined, advisory: adv || z.advise_only,
                refused: refusedNames, level: null, sp: null, side: null, setpoint: null, mode: "off", state: "idle", reason: "" };

    if (!plan) { d.reason = "no plan (no readings yet)"; out.set(z.id, d); continue; }
    if (!all.length) {
      d.reason = plan.manualOff ? "turned off by hand" : plan.blocked === "window" ? "window or door open: off"
        : plan.blocked === "no-side" ? "nothing it can do (no output for the side needed)"
        : "nothing asking to run";
      if (plan.manualOff) { d.state = "manual"; d.mode = "manual"; }
      out.set(z.id, d); continue;
    }
    if (!best) {
      const floor = Math.max(...refused.map((t) => t.floorPct || 0));
      d.state = "shed";
      d.reason = `shed: ${refusedNames.join(", ")} not affordable (battery at its ${floor}% floor)${plan.manual ? ", despite the setting by hand" : ""}`;
      out.set(z.id, d); continue;
    }
    const c = best.climate;
    Object.assign(d, { level: c.level, sp: c.sp, side: c.side, setpoint: c.setpoint });
    const widened = refusedNames.length ? `; band widened, ${refusedNames.join(", ")} shed` : "";
    if (plan.manual && plan.manual.mode === "off") {
      // Turned off by hand: stays off unless protection needs power (a freezing room).
      if (c.level === "protect" && best.demandKw > 0.01) {
        Object.assign(d, { state: "running", mode: c.side, protecting: true, reason: `turned off by hand, but protection holds ${c.setpoint} °C` });
      } else Object.assign(d, { state: "manual", mode: "manual", reason: "turned off by hand" });
      out.set(z.id, d); continue;
    }
    if (plan.manual) {
      // A person's setting stands only while comfort is affordable (H6).
      if (c.sp <= 0) {
        Object.assign(d, { state: "manual", mode: "manual", reason: `your setting (${plan.manual.mode}${Number.isFinite(plan.manual.setpoint) ? ` ${plan.manual.setpoint} °C` : ""}) respected until ${new Date(plan.manual.until).toTimeString().slice(0, 5)}` });
        out.set(z.id, d); continue;
      }
      d.overruled = true;
    }
    const over = d.overruled ? "; your setting isn't affordable now" : "";
    if (plan.fallback) {
      // No room temperature: hand the unit's own thermostat the granted setpoint (H7).
      Object.assign(d, { state: "fallback", mode: c.side, reason: `no room temperature: the unit's own thermostat holds ${c.setpoint} °C (${c.level})${widened}${over}` });
      out.set(z.id, d); continue;
    }
    // Room comfortably on the right side of a setpoint that needs no power: coast.
    const T = plan.temp, sp = c.setpoint;
    const slack = Number.isFinite(T) && Number.isFinite(sp) ? (c.side === "cool" ? sp - T : T - sp) : 0;
    if (!(best.demandKw > 0.01) && slack > 0.5) {
      const h = plan.coastHours ? plan.coastHours(sp) : NaN;
      Object.assign(d, { state: "coast", mode: "off",
        reason: `${c.level}: coasting at ${T} °C, holds ${c.side === "cool" ? "≤" : "≥"} ${sp} °C${Number.isFinite(h) ? ` for ~${h < 1 ? Math.round(h * 60) + " min" : h.toFixed(1) + " h"}` : ""}${widened}${over}` });
    } else {
      Object.assign(d, { state: "running", mode: c.side, reason: `${c.level}: ${c.side} to ${sp} °C${c.why ? ` (${c.why})` : ""}${widened}${over}` });
    }
    out.set(z.id, d);
  }
  return out;
}

module.exports = { expand, resolve, devIdOf };
