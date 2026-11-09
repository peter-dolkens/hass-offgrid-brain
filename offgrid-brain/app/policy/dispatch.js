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
   limits  : { inverter_kw, max_charge_kw, reserve_pct }
   Returns : { decisions, charge, shed, budget, floorPct, errors }

   `decisions` carries one row per device with `run` (bool), the service level
   reached, and the REASON — which is what makes the add-on auditable rather
   than a black box flipping relays. */
function decide(policy, ctx, limits) {
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

  for (let i = 0; i < policy.list.length; i++) {
    const e = policy.list[i];

    if (e.type === "charge") {
      if (soc < e.to) {
        // Mirrors sim.js's three-way cap: available power, the charger's ceiling, and
        // the headroom still left to the target. Without the third term a bank sitting
        // at 39.9% would claim full solar against a 40% rung and starve everything
        // below it, when a few watts would do.
        const headroomKwh = ((e.to - soc) / 100) * limits.capacity_kwh;
        const headroomKw = headroomKwh / (limits.tick_hours || 1 / 120);
        const ch = Math.max(0, Math.min(budgetKw, limits.max_charge_kw, headroomKw));
        chargeKw += ch;
        budgetKw -= ch;                              // charging competes with loads below
      }
      if (e.to > floorPct) floorPct = e.to;          // becomes the floor for everything below
      continue;
    }
    if (e.type !== "load") continue;

    const d = dev[e.dev];
    if (!d) continue;

    const f = clamp01(C.fn(e.cond, d.name || e.dev)({ ...ctx, surplus: budgetKw, used: ctx.used || 0 }));
    if (f <= 1e-9) continue;                          // rule says not now — not a shed

    const demand = (d.kw || 0) * f;
    const inc = demand - (served[e.dev] || 0);        // top-up to this service level
    if (inc <= 1e-9) continue;

    const fromPv = Math.min(inc, budgetKw);
    budgetKw -= fromPv;
    let rem = inc - fromPv;

    let fromBatt = 0;
    if (rem > 1e-9 && soc > floorPct) {               // battery only above this entry's floor
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
    // A device RUNS if any entry granted it power. Deeper entries only improve service.
    result[e.dev] = {
      id: e.dev,
      name: d.name || e.dev,
      run: (prev && prev.run) || ok || unbacked,
      unbacked: (prev && prev.unbacked) || unbacked,
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
  return {
    decisions,
    charge: chargeKw,
    shed: decisions.filter((r) => !r.run),
    unbacked: decisions.filter((r) => r.unbacked),   // running, but on borrowed time
    deficitKw,
    budget: budgetKw,
    floorPct,
    errors: C.errors,
  };
}

module.exports = { decide, VARS };
