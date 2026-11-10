/* Behavioural tests for the real-time dispatch walk. Run: node test/dispatch.test.js
   No framework — these must run inside the add-on container with zero dev deps. */
"use strict";
const assert = require("assert");
const { decide } = require("../policy/dispatch.js");
const { buildContext, LoadHistory, autonomyOf } = require("../policy/context.js");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };

const LIMITS = { inverter_kw: 7.5, max_charge_kw: 7.5, reserve_pct: 10,
                capacity_kwh: 51.8, tick_hours: 30 / 3600 };
const policy = {
  devices: [
    { id: "standby", name: "Standby", kw: 0.108 },
    { id: "network", name: "Network", kw: 0.2 },
    { id: "compute", name: "NAS/AI", kw: 0.35 },
    { id: "ev", name: "EV charger", kw: 7.0 },
  ],
  list: [
    { type: "load", dev: "standby", cond: "1", gen: true },
    { type: "load", dev: "network", cond: "1", gen: true },
    { type: "charge", to: 40 },
    { type: "load", dev: "compute", cond: "1" },
    { type: "charge", to: 80 },
    { type: "load", dev: "ev", cond: "1" },
  ],
};
const ctx = (over) => Object.assign(
  { hour: 12, dow: 2, weekend: 0, month: 6, season: 1, occ: 1, dark: 0, sun: 1,
    soc: 50, pv: 0, surplus: 0, tout: 15, forecast: 1, used: 0, gap: 0, autonomy: 5 }, over);

console.log("dispatch:");

t("healthy battery + sun runs everything", () => {
  const r = decide(policy, ctx({ soc: 95, pv: 10 }), LIMITS);
  assert.strictEqual(r.shed.length, 0, "nothing should be shed");
  assert.ok(r.decisions.find((d) => d.id === "ev").run, "EV should run");
});

t("charge rung acts as a discharge floor for entries below it", () => {
  // SoC 50% is above the 40 rung but below the 80 rung, no sun.
  const r = decide(policy, ctx({ soc: 50, pv: 0 }), LIMITS);
  const byId = Object.fromEntries(r.decisions.map((d) => [d.id, d]));
  assert.ok(byId.standby.run && byId.network.run, "top entries must stay up");
  assert.ok(byId.compute.run, "compute sits above the 80 rung and below 40 — battery may serve it");
  assert.ok(!byId.ev.run, "EV sits below the 80 rung and must be shed at 50%");
  assert.strictEqual(r.floorPct, 80, "floor after the last rung walked is 80");
});

t("at reserve, only the non-sheddable top of the list survives", () => {
  const r = decide(policy, ctx({ soc: 10, pv: 0 }), LIMITS);
  const run = r.decisions.filter((d) => d.run).map((d) => d.id);
  // standby and network are gen-backed: unservable, but they keep running and are
  // reported as a deficit. Everything discretionary is shed.
  assert.deepStrictEqual(run.sort(), ["network", "standby"]);
  assert.deepStrictEqual(r.unbacked.map((d) => d.id).sort(), ["network", "standby"]);
  assert.ok(r.deficitKw > 0.15, `expected a deficit, got ${r.deficitKw}`);
  assert.deepStrictEqual(r.shed.map((d) => d.id).sort(), ["compute", "ev"]);
});

t("a gen-backed load is never reported as shed", () => {
  const r = decide(policy, ctx({ soc: 10, pv: 0 }), LIMITS);
  for (const s of r.shed) assert.ok(!s.gen, `${s.id} is gen-backed and must not be shed`);
});

t("no deficit is raised while solar covers the gen-backed loads", () => {
  const r = decide(policy, ctx({ soc: 10, pv: 5 }), LIMITS);
  assert.strictEqual(r.deficitKw, 0, "solar covers standby + network");
  assert.strictEqual(r.unbacked.length, 0);
});

t("solar serves entries ABOVE the first charge rung even at reserve SoC", () => {
  const r = decide(policy, ctx({ soc: 10, pv: 5 }), LIMITS);
  const byId = Object.fromEntries(r.decisions.map((d) => [d.id, d]));
  assert.ok(byId.standby.run && byId.network.run, "solar covers the top entries without touching the battery");
});

t("a depleted bank claims solar ahead of loads below its charge rung", () => {
  // 10% SoC against a 40% rung = 15.5 kWh of headroom, far more than 5 kW can
  // deliver in a tick, so charging takes the lot and `compute` is correctly shed.
  const r = decide(policy, ctx({ soc: 10, pv: 5 }), LIMITS);
  assert.ok(r.charge > 4, `expected charging to claim the solar, got ${r.charge.toFixed(2)} kW`);
  assert.ok(!r.decisions.find((d) => d.id === "compute").run, "compute sits below the rung and yields to recharging");
});

t("a nearly-satisfied charge rung only takes what it needs", () => {
  // Single rung, so `charge` is unambiguous. At 39.99% against a 40% rung the
  // headroom is 0.005 kWh; over a 30 s tick that is ~0.6 kW, not the full 5 kW.
  const oneRung = {
    devices: [{ id: "compute", name: "NAS/AI", kw: 0.35 }],
    list: [{ type: "charge", to: 40 }, { type: "load", dev: "compute", cond: "1" }],
  };
  const r = decide(oneRung, ctx({ soc: 39.99, pv: 5 }), LIMITS);
  assert.ok(r.charge < 1, `rung should trickle, took ${r.charge.toFixed(3)} kW`);
  assert.ok(r.decisions.find((d) => d.id === "compute").run, "compute must still be served from the remaining solar");
});

t("a far-from-target charge rung is capped by the charger, not the headroom", () => {
  const oneRung = {
    devices: [{ id: "compute", name: "NAS/AI", kw: 0.35 }],
    list: [{ type: "charge", to: 100 }, { type: "load", dev: "compute", cond: "1" }],
  };
  const r = decide(oneRung, ctx({ soc: 20, pv: 20 }), LIMITS);
  assert.ok(Math.abs(r.charge - LIMITS.max_charge_kw) < 1e-6, `expected the 7.5 kW charger ceiling, got ${r.charge}`);
  assert.ok(r.decisions.find((d) => d.id === "compute").run, "surplus beyond the charger still serves loads");
});

t("battery inverter power ceiling limits concurrent load", () => {
  const small = Object.assign({}, LIMITS, { inverter_kw: 1.0 });
  const r = decide(policy, ctx({ soc: 95, pv: 0 }), small);
  assert.ok(!r.decisions.find((d) => d.id === "ev").run, "7 kW EV cannot run on a 1 kW inverter");
});

t("a rule returning 0 is 'not now', not a shed", () => {
  const p2 = JSON.parse(JSON.stringify(policy));
  p2.list[5].cond = "0";                       // EV rule off
  const r = decide(p2, ctx({ soc: 95, pv: 10 }), LIMITS);
  assert.ok(!r.decisions.find((d) => d.id === "ev"), "EV should not appear as a decision at all");
  assert.strictEqual(r.shed.length, 0, "and must not be counted as shed");
});

t("every shed decision carries a human-readable reason", () => {
  const r = decide(policy, ctx({ soc: 50, pv: 0 }), LIMITS);
  for (const s of r.shed) assert.ok(/floor|short/.test(s.reason), `reason missing for ${s.id}: ${s.reason}`);
});

console.log("context:");

t("autonomy falls as SoC falls", () => {
  const base = { capacityKwh: 51.8, reservePct: 10, expectedLoadKwh: 30, forecastKwh: 5 };
  const hi = autonomyOf({ ...base, socPct: 90 });
  const lo = autonomyOf({ ...base, socPct: 30 });
  assert.ok(hi > lo, `expected ${hi} > ${lo}`);
});

t("autonomy is 99 when forecast generation covers expected load", () => {
  assert.strictEqual(autonomyOf({ capacityKwh: 51.8, reservePct: 10, socPct: 50, expectedLoadKwh: 10, forecastKwh: 40 }), 99);
});

t("load history seeds, then uses realised days", () => {
  const h = new LoadHistory(7, 30);
  assert.strictEqual(h.expectedDailyKwh(), 30, "seed before any complete day");
  h.add("2026-10-01", 1.0, 3600 * 24);          // 24 kWh on day 1
  h.add("2026-10-02", 1.0, 60);                 // rolls day 1 into history
  assert.ok(Math.abs(h.expectedDailyKwh() - 24) < 0.01, `got ${h.expectedDailyKwh()}`);
});

t("season tracks the southern-hemisphere year like the simulator", () => {
  const h = new LoadHistory(7, 30);
  const mk = (iso) => buildContext({ now: new Date(iso), soc: 50, pvKw: 1, loadKw: 1, toutC: 15,
    forecastKwh: NaN, history: h, battery: { capacity_kwh: 51.8, reserve_pct: 10 } });
  assert.ok(mk("2026-06-21T12:00:00").season > 0.95, "June = winter ~1");
  assert.ok(mk("2026-12-21T12:00:00").season < 0.05, "December = summer ~0");
});

t("a charge rung below target with no solar left says so, not charging", () => {
  const pol = { devices: [{ id: "base", kw: 1 }], list: [{ type: "load", dev: "base", cond: "1", gen: true }, { type: "charge", to: 100 }] };
  const charge = (pv, soc) => decide(pol, ctx({ pv, soc }), LIMITS).trace[1].outcome;
  assert.strictEqual(charge(0, 70), "below", "draining at night");
  assert.strictEqual(charge(0.8, 70), "below", "the load took all the solar");
  assert.strictEqual(charge(3, 70), "charging");
  assert.strictEqual(charge(0, 100), "full");
});

t("only important sheds are flagged; convenience loads are held back", () => {
  const pol = {
    devices: [{ id: "office", kw: 1.4 }, { id: "ev", kw: 6.6, important: false }, { id: "pump", kw: 0.5 }],
    list: [
      { type: "charge", to: 80 },
      { type: "load", dev: "office", cond: "1", important: false },   // comfort: not worth flagging
      { type: "load", dev: "ev", cond: "1" },
      { type: "load", dev: "pump", cond: "1" },
    ],
  };
  const r = decide(pol, ctx({ pv: 0, soc: 50 }), LIMITS);
  assert.deepStrictEqual(r.shed.map((d) => d.id).sort(), ["ev", "office", "pump"]);
  assert.deepStrictEqual(r.flagged.map((d) => d.id), ["pump"]);
  assert.deepStrictEqual(r.heldBack.map((d) => d.id).sort(), ["ev", "office"]);
  assert.strictEqual(r.trace[1].important, false);
  assert.strictEqual(r.trace[3].important, true);
});

t("an important entry going unserved flags the device; a convenience entry alone doesn't", () => {
  const pol = {
    devices: [{ id: "office", kw: 1.4, important: false }],
    list: [{ type: "charge", to: 80 }, { type: "load", dev: "office", cond: "gap > 0 ? 1 : 0", important: true }, { type: "load", dev: "office", cond: "1" }],
  };
  assert.deepStrictEqual(decide(pol, ctx({ pv: 0, soc: 50, gap: 0 }), LIMITS).flagged.length, 0, "only the convenience entry asked");
  assert.deepStrictEqual(decide(pol, ctx({ pv: 0, soc: 50, gap: 12 }), LIMITS).flagged.map((d) => d.id), ["office"]);
});

t("hysteresis: a running load holds through a dip below its floor; a stopped one doesn't start", () => {
  const pol = { devices: [{ id: "ac", kw: 2 }], list: [{ type: "charge", to: 100 }, { type: "load", dev: "ac", cond: "1" }] };
  const L = { ...LIMITS, hysteresis_pct: 3 };
  const at = (soc, running) => decide(pol, ctx({ pv: 0, soc }), L, running).decisions[0];
  assert.strictEqual(at(99.8, []).run, false, "off, and below the 100% floor: can't start on battery");
  assert.strictEqual(at(99.8, ["ac"]).run, true, "running: holds at 99.8%");
  assert.strictEqual(at(97.5, ["ac"]).run, true, "still inside the 3% band");
  assert.strictEqual(at(96.9, ["ac"]).run, false, "below 97%: shed");
  const tr = decide(pol, ctx({ pv: 0, soc: 99.8 }), L, ["ac"]).trace[1];
  assert.ok(tr.held && tr.holdFloorPct === 97, JSON.stringify(tr));
});

t("hysteresis never reaches below the reserve, and 0 turns it off", () => {
  const pol = { devices: [{ id: "x", kw: 1 }], list: [{ type: "load", dev: "x", cond: "1" }] };
  const at = (soc, h) => decide(pol, ctx({ pv: 0, soc }), { ...LIMITS, hysteresis_pct: h }, ["x"]).decisions[0].run;
  assert.strictEqual(at(9.5, 3), false, "reserve 10%: no hold below it");
  const pol2 = { devices: [{ id: "x", kw: 1 }], list: [{ type: "charge", to: 40 }, { type: "load", dev: "x", cond: "1" }] };
  assert.strictEqual(decide(pol2, ctx({ pv: 0, soc: 39 }), { ...LIMITS, hysteresis_pct: 0 }, ["x"]).decisions[0].run, false);
});

console.log(`\n${pass} passed`);
