/* Climate in the dispatch ladder.

   expand() rewrites a policy so decide() can walk it unchanged:
     - { type: "climate", zone, level, cond? } becomes a load entry on the zone's
       device, with the planner's kW for that level (`kw`), the zone's own `occ` and
       `gap` (`vars`, as the simulator gives zone entries), and a condition that is
       0 unless the planner says the level applies (AND the entry's own `cond`);
     - legacy load entries on a device a zone has taken over (zone.device) keep their
       `cond` and `sp`, and get the modelled kW for that sp and the zone's occ/gap;
     - zones with no entries are placed automatically by energy class (levels.AUTO).

   resolve() reads the walk back: per zone, the tightest level that was granted (or
   needed nothing more than an earlier one already got) sets the band. Active levels
   with none granted is a hard shed: off. */
"use strict";
const { LEVELS, AUTO, importantByDefault } = require("./levels.js");

const devIdOf = (z) => z.device || `climate_${z.id}`;

function levelEntry(z, plan, level, e = {}) {
  const l = plan && plan.levels[level];
  const user = e.cond != null && String(e.cond).trim() !== "" ? String(e.cond) : "1";
  return {
    type: "load", dev: devIdOf(z),
    cond: l && l.active ? user : "0",
    kw: l ? l.kw : 0,
    vars: { occ: plan && plan.occupied ? 1 : 0, gap: plan ? plan.gap : 0 },
    important: e.important != null ? !!e.important : importantByDefault(z.energy_class, level),
    climate: { zone: z.id, level, sp: l ? l.sp : 0, side: l ? l.side : null, setpoint: l ? l.setpoint : null, why: l ? l.why : "" },
    ...(e.auto ? { auto: true } : {}),
  };
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
    climate: { zone: z.id, level: "rule", sp, side, setpoint: usable ? Math.round(plan.setpointFor(side, sp) * 10) / 10 : null, why: e.cond ? `rule: ${e.cond}` : "rule" },
  };
}

/**
 * @param {object} policy  { devices, list }
 * @param {object[]} zones normalised zones
 * @param {Map<string, object>} plans  zone id -> plan (missing: the zone's entries stay idle)
 */
function expand(policy, zones, plans) {
  if (!zones.length) return policy;
  const byId = new Map(zones.map((z) => [z.id, z]));
  const byDev = new Map(zones.map((z) => [devIdOf(z), z]));
  const known = new Set(policy.devices.map((d) => d.id));
  const devices = policy.devices.map((d) => (byDev.has(d.id) ? { ...d, climate: byDev.get(d.id).id } : d));
  for (const z of zones) {
    if (known.has(devIdOf(z))) continue;
    const p = plans.get(z.id);
    devices.push({ id: devIdOf(z), name: z.name, kw: p ? p.ratedKw : 0, climate: z.id,
                   important: importantByDefault(z.energy_class, "protect") });
  }

  const explicit = new Set();
  const list = [];
  for (const e of policy.list) {
    if (e && e.type === "climate") {
      const z = byId.get(e.zone);
      if (!z) { list.push({ ...e, type: "climate-unknown" }); continue; }
      explicit.add(z.id);
      list.push(levelEntry(z, plans.get(z.id), e.level, e));
    } else if (e && e.type === "load" && byDev.has(e.dev)) {
      const z = byDev.get(e.dev);
      explicit.add(z.id);
      list.push(ruleEntry(z, plans.get(z.id), e));
    } else list.push(e);
  }

  // Zones with no entries of their own: place each level after the charge rung its
  // energy class names (at the end of that rung's segment), or at the end of the list.
  const auto = zones.filter((z) => !explicit.has(z.id) && z.auto_ladder !== false)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  if (!auto.length) return { devices, list };
  const rungs = list.map((e, i) => (e && e.type === "charge" ? { i, to: e.to } : null)).filter(Boolean);
  const posAfter = (pct) => {
    if (pct === "end") return list.length;
    const r = rungs.find((x) => x.to >= pct);
    if (!r) return list.length;
    const next = rungs.find((x) => x.i > r.i);
    return next ? next.i : list.length;
  };
  const inserts = [];
  for (const z of auto) {
    const table = AUTO[z.energy_class] || AUTO.comfort;
    LEVELS.forEach((level, li) => {
      if (!table[level]) return;
      inserts.push({ pos: posAfter(table[level][0]), li, prio: z.priority, entry: levelEntry(z, plans.get(z.id), level, { auto: true }) });
    });
  }
  inserts.sort((a, b) => a.pos - b.pos || a.li - b.li || a.prio - b.prio);
  const out = [];
  let k = 0;
  for (let i = 0; i <= list.length; i++) {
    while (k < inserts.length && inserts[k].pos === i) out.push(inserts[k++].entry);
    if (i < list.length) out.push(list[i]);
  }
  return { devices, list: out };
}

const ALLOWED = new Set(["granted", "already-served"]);

/**
 * One decision per zone from the dispatch result.
 * @returns {Map<string, object>} zone id -> { state, level, sp, side, setpoint, mode, kw, reason, refused }
 *   state: running | coast | shed | idle | manual
 */
function resolve(zones, plans, result) {
  const rows = new Map(zones.map((z) => [z.id, []]));
  for (const t of result.trace || []) if (t.climate && rows.has(t.climate.zone)) rows.get(t.climate.zone).push(t);
  const kwByDev = new Map((result.decisions || []).map((d) => [d.id, d.run ? d.kw : 0]));
  const out = new Map();
  for (const z of zones) {
    const plan = plans.get(z.id);
    const all = rows.get(z.id).filter((t) => t.f > 1e-9);
    const allowed = all.filter((t) => ALLOWED.has(t.outcome));
    const refused = all.filter((t) => !ALLOWED.has(t.outcome));
    const best = allowed.reduce((b, t) => (!b || t.climate.sp < b.climate.sp ? t : b), null);
    const kw = kwByDev.get(devIdOf(z)) || 0;
    const refusedNames = [...new Set(refused.filter((t) => !best || t.climate.sp < best.climate.sp).map((t) => t.climate.level))];
    const d = { zone: z.id, kw, refused: refusedNames, level: null, sp: null, side: null, setpoint: null, mode: "off", state: "idle", reason: "" };

    if (!plan) { d.reason = "no plan (no readings yet)"; out.set(z.id, d); continue; }
    if (!all.length) {
      d.reason = plan.blocked === "no-reading" ? "no room temperature reading: nothing offered"
        : plan.blocked === "window" ? "window or door open: off"
        : plan.blocked === "manual-off" ? "turned off by hand"
        : plan.blocked === "no-side" ? "nothing it can do (no output for the side needed)"
        : "nothing asking to run";
      if (plan.manual) { d.state = "manual"; d.mode = "manual"; }
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
    if (plan.manual) {
      Object.assign(d, { state: "manual", mode: "manual", reason: `your setting (${plan.manual.mode}${Number.isFinite(plan.manual.setpoint) ? ` ${plan.manual.setpoint} °C` : ""}) respected until ${new Date(plan.manual.until).toTimeString().slice(0, 5)}${widened}` });
      out.set(z.id, d); continue;
    }
    // Room comfortably on the right side of a setpoint that needs no power: coast.
    const T = plan.temp, sp = c.setpoint;
    const slack = Number.isFinite(T) && Number.isFinite(sp) ? (c.side === "cool" ? sp - T : T - sp) : 0;
    if (!(best.demandKw > 0.01) && slack > 0.5) {
      const h = plan.coastHours ? plan.coastHours(sp) : NaN;
      Object.assign(d, { state: "coast", mode: "off",
        reason: `${c.level}: coasting at ${T} °C, holds ${c.side === "cool" ? "≤" : "≥"} ${sp} °C${Number.isFinite(h) ? ` for ~${h < 1 ? Math.round(h * 60) + " min" : h.toFixed(1) + " h"}` : ""}${widened}` });
    } else {
      Object.assign(d, { state: "running", mode: c.side, reason: `${c.level}: ${c.side} to ${sp} °C${c.why ? ` (${c.why})` : ""}${widened}` });
    }
    out.set(z.id, d);
  }
  return out;
}

module.exports = { expand, resolve, devIdOf };
