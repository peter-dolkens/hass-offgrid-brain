/* Real-time dispatch walk.

   This is the ONLINE twin of the allocation loop in offgrid-sim/web/sim.js.
   The simulator allocates an hourly ENERGY pool (kWh) top-down through the list;
   the brain allocates instantaneous POWER (kW) through the SAME list, with the
   same two entry kinds and the same floor semantics:

     { type:"charge", to:Y }  -> fill battery to Y% here, AND act as a discharge
                                 FLOOR: entries below may not pull the battery
                                 below Y%.
     { type:"load", dev, cond, sp, gen } -> run `dev` if `cond` (expr -> 0..1)
                                 is met, at that service level.

   Not every shed matters. A device is `important` unless it says otherwise
   (devices[].important: false), and an entry can override its device either way
   (list[].important). A device that ends up not running is FLAGGED only if one of
   the entries that couldn't be served was important; otherwise it was merely held
   back (an EV waiting for surplus, a comfort setpoint the battery can't afford).

   A device may appear MANY times = progressive service levels; each lower entry
   tops up to a better level, reached only if power remains at that depth.
   Keeping this faithful to sim.js is the whole point: a policy backtested
   against the measured year is the policy that runs the house. */
"use strict";
const Expr = require("./expr.js");

// Must match sim.js VARS exactly, or policies are not portable between the two.
const VARS = ["occ", "dark", "sun", "hour", "dow", "weekend", "month", "soc", "pv",
              "surplus", "tout", "forecast", "used", "gap", "season", "autonomy"];

function compiler() {
  const cache = new Map(), errors = [];
  return {
    errors,
    fn(src, label) {
      if (cache.has(src)) return cache.get(src);
      const c = Expr.compile(src || "0", VARS);
      if (!c.ok) { errors.push(`${label}: ${c.error}`); cache.set(src, () => 0); return cache.get(src); }
      cache.set(src, c.fn);
      return c.fn;
    },
  };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/* Decide what should be running right now.

   policy  : { devices: [...], list: [...] }
   ctx     : runtime variables (see VARS) — soc is PERCENT, pv/surplus are kW
   limits  : { inverter_kw, max_charge_kw, reserve_pct, hysteresis_pct }
   running : ids of the devices running after the previous walk (optional)
   Returns : { decisions, charge, shed, budget, floorPct, errors, trace }

   HYSTERESIS. A device needs the battery above an entry's floor to START drawing on
   it, but one already running may keep drawing down to the floor minus
   hysteresis_pct (never below the reserve). Without it a load that came on at a full
   battery would drop out at 99.9% under the 100% rung, or the moment a cloud passed,
   and come back a minute later.

   `decisions` carries one row per device with `run` (bool), the service level
   reached, and the REASON — which is what makes the add-on auditable rather
   than a black box flipping relays. */
function decide(policy, ctx, limits, running) {
  const hyst = Math.max(0, Number.isFinite(limits.hysteresis_pct) ? limits.hysteresis_pct : 0);
  const wasRunning = running instanceof Set ? running : new Set(running || []);
  const C = compiler();
  const dev = {};
  for (const d of policy.devices) dev[d.id] = d;

  let budgetKw = Math.max(0, ctx.pv || 0);          // free solar first
  let floorPct = limits.reserve_pct;                 // hard battery reserve
  let battKw = limits.inverter_kw;                   // discharge power still available
  const soc = ctx.soc;

  const served = {};      // kW already granted per device (progressive top-up)
  const result = {};      // device id -> decision row
  let chargeKw = 0;
  let deficitKw = 0;      // gen-backed demand that solar+battery could not cover
  // One row per list entry, for display only: what the walk did at each depth.
  const trace = [];

  for (let i = 0; i < policy.list.length; i++) {
    const e = policy.list[i];

    if (e.type === "charge") {
      let ch = 0;
      if (soc < e.to) {
        // Mirrors sim.js's three-way cap: available power, the charger's ceiling, and
        // the headroom still left to the target. Without the third term a bank sitting
        // at 39.9% would claim full solar against a 40% rung and starve everything
        // below it, when a few watts would do.
        const headroomKwh = ((e.to - soc) / 100) * limits.capacity_kwh;
        const headroomKw = headroomKwh / (limits.tick_hours || 1 / 120);
        ch = Math.max(0, Math.min(budgetKw, limits.max_charge_kw, headroomKw));
        chargeKw += ch;
        budgetKw -= ch;                              // charging competes with loads below
      }
      if (e.to > floorPct) floorPct = e.to;          // becomes the floor for everything below
      // Below the target with nothing left to charge from is "below", not "charging".
      trace.push({ i, type: "charge", to: e.to, chargeKw: ch, floorPct,
                   outcome: soc >= e.to ? "full" : ch > 0.001 ? "charging" : "below" });
      continue;
    }
    if (e.type !== "load") { trace.push({ i, type: e.type, outcome: "ignored" }); continue; }

    const d = dev[e.dev];
    if (!d) { trace.push({ i, type: "load", dev: e.dev, outcome: "unknown-device" }); continue; }

    const f = clamp01(C.fn(e.cond, d.name || e.dev)({ ...ctx, surplus: budgetKw, used: ctx.used || 0 }));
    const important = e.important != null ? !!e.important : d.important !== false;
    const row = { i, type: "load", dev: e.dev, name: d.name || e.dev, cond: e.cond, f,
                  gen: !!e.gen, important, floorPct, surplusKw: budgetKw };
    if (f <= 1e-9) { trace.push({ ...row, outcome: "idle" }); continue; }   // rule says not now — not a shed

    const demand = (d.kw || 0) * f;
    const inc = demand - (served[e.dev] || 0);        // top-up to this service level
    if (inc <= 1e-9) { trace.push({ ...row, demandKw: demand, outcome: "already-served" }); continue; }

    const fromPv = Math.min(inc, budgetKw);
    budgetKw -= fromPv;
    let rem = inc - fromPv;

    let fromBatt = 0;
    // Battery only above this entry's floor, or, for a device already running, above
    // the floor less the hysteresis band (but never the reserve).
    const holdFloor = wasRunning.has(e.dev) ? Math.max(limits.reserve_pct, floorPct - hyst) : floorPct;
    const held = holdFloor < floorPct && soc <= floorPct && soc > holdFloor;
    if (rem > 1e-9 && soc > holdFloor) {
      fromBatt = Math.min(rem, battKw);
      battKw -= fromBatt;
      rem -= fromBatt;
    }

    const ok = rem <= 1e-9;

    /* gen-backed entries are NOT sheddable. In sim.js `gen` marks a load the Shark 6
       backs in an emergency; here it marks a load that must keep running whatever the
       battery says — either because shedding it is physically impossible (the
       inverters' own standby draw) or because shedding it would be self-defeating
       (the router and switch ARE the control path; drop them and the brain goes
       blind and deaf). An unservable gen entry is a DEFICIT to alarm on, not a
       relay to open. */
    const unbacked = !ok && !!e.gen;
    if (ok || unbacked) served[e.dev] = (served[e.dev] || 0) + inc;
    if (unbacked) deficitKw += rem;

    const prev = result[e.dev];
    trace.push({ ...row, demandKw: demand, incKw: inc, fromPvKw: fromPv, fromBattKw: fromBatt, shortKw: rem,
                 held: held && fromBatt > 0, holdFloorPct: holdFloor,
                 outcome: ok ? "granted" : unbacked ? "deficit" : (prev && prev.run) ? "partial" : "shed" });
    // A device RUNS if any entry granted it power. Deeper entries only improve service.
    result[e.dev] = {
      id: e.dev,
      name: d.name || e.dev,
      run: (prev && prev.run) || ok || unbacked,
      unbacked: (prev && prev.unbacked) || unbacked,
      // an important entry went unserved (only matters if the device ends up not running)
      missedImportant: (prev && prev.missedImportant) || (!ok && !unbacked && important),
      kw: served[e.dev] || 0,
      entry: i,
      sp: e.sp,
      gen: !!e.gen,
      reason: ok
        ? `entry ${i}: granted ${(fromPv + fromBatt).toFixed(3)} kW (${fromPv.toFixed(3)} solar + ${fromBatt.toFixed(3)} battery)`
        : unbacked
          ? `entry ${i}: DEFICIT — needs ${rem.toFixed(3)} kW that solar and battery cannot supply at ${soc.toFixed(1)}%, but it is gen-backed so it keeps running`
          : (prev && prev.run)
            ? `entry ${i}: deeper service level not reached (short ${rem.toFixed(3)} kW) — running at a lower level`
            : `entry ${i}: SHED — short ${rem.toFixed(3)} kW; battery at ${soc.toFixed(1)}% is at/below this entry's floor of ${floorPct}%`,
    };
  }

  const decisions = Object.values(result);
  for (const r of decisions) r.flagged = !r.run && r.missedImportant;
  return {
    decisions,
    charge: chargeKw,
    shed: decisions.filter((r) => !r.run),
    flagged: decisions.filter((r) => !r.run && r.missedImportant),   // the sheds worth showing
    heldBack: decisions.filter((r) => !r.run && !r.missedImportant),
    unbacked: decisions.filter((r) => r.unbacked),   // running, but on borrowed time
    deficitKw,
    budget: budgetKw,
    floorPct,
    errors: C.errors,
    trace,
  };
}

module.exports = { decide, VARS };
