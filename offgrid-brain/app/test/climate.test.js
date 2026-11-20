/* Tests for the climate brain: learning, the thermal model, planning, the ladder,
   actuation and outputs. Cases marked [Hn]/[Mn] reproduce findings of the 0.34.0
   review. Run: node test/climate.test.js */
"use strict";
process.env.TZ = "Australia/Sydney";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Preferences, Occupancy } = require("../climate/learn.js");
const { ThermalModel } = require("../climate/thermal.js");
const { ConsumptionCurves, attribute } = require("../climate/consumption.js");
const Zones = require("../climate/zones.js");
const { planZone } = require("../climate/plan.js");
const Ladder = require("../climate/ladder.js");
const { ClimateActuator, fitSetpoint } = require("../climate/actuate.js");
const { ClimateBrain } = require("../climate/index.js");
const { parseHistory, replay, seedFromHistory } = require("../climate/seed.js");
const { decide } = require("../policy/dispatch.js");
const { project, loadProfile } = require("../policy/timeline.js");
const { check: checkPolicy } = require("../config.js");
const Settings = require("../settings.js");
const { MqttSink } = require("../sinks/mqtt.js");
const { HAClient } = require("../sources/ha.js");
require("../log.js").setLevel("error");

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const near = (a, b, tol, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} not within ${tol} of ${b}`);
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const at = (iso) => new Date(iso).getTime();     // local time (TZ above)
const MON = at("2026-11-02T00:00:00");           // a Monday, local midnight

const CFG = Zones.normalise({ enabled: true });
const SOAK = { ...CFG, soak_enabled: true };
// A zone with a real output (zones with none are advisory and stay out of the real walk).
const zone = (over = {}) => Zones.normaliseZone({ id: "office", name: "Office", area: "Office", temp_entities: ["sensor.office_t"],
  outputs: [{ kind: "ac", entity: "climate.office", kw: 1.5 }], ...over });
const LIMITS = { inverter_kw: 7.5, max_charge_kw: 7.5, reserve_pct: 10, capacity_kwh: 51.8, tick_hours: 5 / 3600, hysteresis_pct: 3 };
const CTX = { hour: 18, dow: 1, weekend: 0, month: 6, season: 1, occ: 1, dark: 1, sun: 0, soc: 50, pv: 0, surplus: 0,
              tout: 8, forecast: 1, used: 0, gap: 0, autonomy: 2, storm: 0, storm_ahead: 0, lightning: 999 };
const DEFAULT_POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "policy", "policy.default.json"), "utf8"));
const POLICY = {
  devices: [{ id: "network", kw: 0.05 }],
  list: [
    { type: "load", dev: "network", cond: "1", gen: true },
    { type: "charge", to: 20 }, { type: "charge", to: 40 }, { type: "charge", to: 60 }, { type: "charge", to: 100 },
  ],
};

// ======================================================================= learning

t("preferences: synthetic manual adjustments become setpoints by day type and hour", () => {
  const p = new Preferences();
  for (let d = 0; d < 28; d++) {
    const day = MON + d * DAY, dow = d % 7;
    if (dow < 5) p.observe("office", day + 19 * HOUR, "heat", 21.5);
    else p.observe("office", day + 9 * HOUR, "heat", 19);
    if (dow < 5) p.observe("office", day + 14 * HOUR, "cool", 24);
  }
  const now = MON + 28 * DAY;
  const wkEve = p.preferred("office", now + 19 * HOUR, "heat", 20);
  near(wkEve.value, 21.5, 0.2, "weekday evening");
  assert.ok(wkEve.confidence > 0.8);
  near(p.preferred("office", now + 5 * DAY + 9 * HOUR, "heat", 20).value, 19, 0.3, "weekend morning");
  near(p.preferred("office", now + 20 * HOUR, "heat", 20).value, 21.5, 0.3, "kernel spreads to the next hour");
  const night = p.preferred("office", now + 3 * HOUR, "heat", 20);
  assert.ok(night.confidence < 0.05 && Math.abs(night.value - 20) < 0.1);
  near(p.preferred("office", now + 14 * HOUR, "cool", 25).value, 24, 0.2, "cooling learned separately");
});

t("preferences: old adjustments decay in favour of recent ones", () => {
  const p = new Preferences();
  for (let k = 0; k < 10; k++) p.observe("z", MON - 160 * DAY + k * 7 * DAY + 19 * HOUR, "heat", 18);
  for (let k = 0; k < 3; k++) p.observe("z", MON - 21 * DAY + k * 7 * DAY + 19 * HOUR, "heat", 23);
  assert.ok(p.preferred("z", MON + 19 * HOUR, "heat", 20).learned > 21.5);
});

t("occupancy: an hour-of-week pattern from presence history, and when it starts next", () => {
  const o = new Occupancy();
  for (let d = 0; d < 28; d++) {
    for (let m = 0; m < 24 * 60; m += 5) {
      const h = Math.floor(m / 60);
      o.observe("office", MON + d * DAY + m * MIN, d % 7 < 5 ? h >= 17 && h < 23 : h >= 8 && h < 22);
    }
  }
  const tue = MON + 29 * DAY;
  assert.ok(o.probability("office", tue + 19 * HOUR).p > 0.85);
  assert.ok(o.probability("office", tue + 11 * HOUR).p < 0.2);
  assert.ok(o.probability("office", MON + 33 * DAY + 11 * HOUR).p > 0.8, "Sat 11:00");
  near(o.nextOccupied("office", tue + 15 * HOUR, 240, 0.5), 120, 15, "next occupied");
  assert.strictEqual(o.nextOccupied("office", tue + 9 * HOUR, 120, 0.5), null);
});

t("occupancy: unavailable presence is unknown, not empty", () => {
  const o = new Occupancy();
  for (let m = 0; m < 7 * 24 * 60; m += 5) o.observe("z", MON + m * MIN, null);
  assert.strictEqual(o.probability("z", MON + 8 * DAY, 0.6).p, 0.6);
  const st = (state) => ({ state, attributes: {}, ageSec: 1 });
  assert.strictEqual(Zones.anyPresent([st("on"), st("unavailable")]), true);
  assert.strictEqual(Zones.anyPresent([st("off"), st("unavailable")]), false);
  assert.strictEqual(Zones.anyPresent([st("unavailable"), st("unknown")]), null);
  assert.strictEqual(Zones.anyPresent([st("2")]), true, "a count");
});

function simulateRoom({ a = 0.08, bh = 2.0, bc = 2.5, g = 0.1, days = 10, seed = 1 } = {}) {
  let rnd = seed; const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const windows = [];
  let T = 18, heat = false, cool = false;
  for (let w = 0; w < days * 96; w++) {
    const t0 = Math.round(T * 10) / 10;
    let toutSum = 0, ph = 0, pc = 0;
    for (let m = 0; m < 15; m++) {
      const tm = (w * 15 + m) / 60;
      const tout = 17 + 8 * Math.sin((2 * Math.PI * (tm - 9)) / 24);
      if (T < 19) heat = true; if (T > 21.5) heat = false;
      if (T > 24 && tout > 20) cool = true; if (T < 22) cool = false;
      if (w % 40 < 8) heat = false, cool = false;
      const P = heat ? 1 : 0, C = cool ? 1 : 0;
      T += (a * (tout - T) + bh * P - bc * C + g + (rand() - 0.5) * 0.2) / 60;
      toutSum += tout; ph += P; pc += C;
    }
    windows.push({ t0, t1: Math.round(T * 10) / 10, tout: toutSum / 15, ph: ph / 15, pc: pc / 15, hours: 0.25 });
  }
  return windows;
}

t("thermal model: the RC fit recovers the room's physics and predicts warm-up time", () => {
  const m = new ThermalModel({ area_m2: 20 });
  assert.ok(m.confidence() < 0.05);
  for (const w of simulateRoom()) m.update(w);
  const { a, bh, g } = m.params;
  near(a, 0.08, 0.03, "a"); near(bh, 2.0, 0.5, "bh"); near(g, 0.1, 0.25, "g");
  assert.ok(m.confidence("heat") > 0.6);
  const Tinf = 10 + (0.1 + 2.0) / 0.08, truth = -Math.log((21 - Tinf) / (17 - Tinf)) / 0.08;
  near(m.hoursToReach(17, 21, 10, 1, "heat"), truth, truth * 0.2, "hours to reach");
  assert.strictEqual(m.hoursToReach(22, 21, 10, 1, "heat"), 0);
  assert.strictEqual(m.hoursToReach(17, 40, 10, 0.1, "heat"), Infinity);
  near(m.hoursToReach(17, 21, 10, m.kwToReach(17, 21, 10, 1, "heat"), "heat"), 1, 0.01, "kwToReach/hoursToReach agree");
  assert.strictEqual(m.forPlanning("heat"), m, "confident: plans with the fit");
});

t("[M8] thermal model: below the confidence gate planning uses the prior; outliers are rejected", () => {
  const m = new ThermalModel({ area_m2: 20 });
  const p = m.forPlanning("heat");
  assert.notStrictEqual(p, m);
  assert.strictEqual(m.source, "prior");
  for (const w of simulateRoom({ days: 3 })) m.update(w);
  const before = m.n.rejected;
  assert.strictEqual(m.update({ t0: 20, t1: 22.5, tout: 15, hours: 0.25 }), false, "+10 °C/h unexplained");
  assert.strictEqual(m.n.rejected, before + 1);
  assert.ok(m.update({ t0: 20, t1: 20, tout: 20, irr: 800, hours: 0.25 }) !== undefined, "irradiance accepted as a regressor");
});

t("[H9] thermal model: survives a round trip; malformed or old state is handled", () => {
  const m = new ThermalModel({ area_m2: 20 });
  for (const w of simulateRoom({ days: 3 }).map((w) => ({ ...w, pc: 0 }))) m.update(w);
  const m2 = new ThermalModel({ area_m2: 20, state: JSON.parse(JSON.stringify(m.toJSON())) });
  assert.deepStrictEqual(m2.params, m.params);
  const bad = new ThermalModel({ area_m2: 20, state: { theta: [0.04, 5, 5, 0.2] } });   // no P
  assert.strictEqual(bad.theta.length, 6, "prior kept");
  const old = new ThermalModel({ area_m2: 20, state: { theta: [0.05, 3, 3, 0.1], P: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], n: { passive: 5 } } });
  assert.strictEqual(old.params.a, 0.05, "a 4-parameter state is extended");
  assert.strictEqual(new ThermalModel({ state: { theta: [NaN, 1, 1, 1, 1, 1], P: [] } }).theta.every(Number.isFinite), true);
});

t("consumption: a synthetic metered history drives the learnt draw curve", () => {
  const c = new ConsumptionCurves();
  assert.strictEqual(c.predict("climate.hp", "heat", 10, 2).kw, 2, "no data: nameplate");
  let rnd = 7; const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 400; k++) {
    const lift = rand() * 20;
    c.observe("climate.hp", "heat", lift, 0.5 + 0.05 * lift + (rand() - 0.5) * 0.05, MON + k * MIN);
  }
  const p = c.predict("climate.hp", "heat", 15, 2);
  near(p.learned, 1.25, 0.05, "learned"); near(p.c1, 0.05, 0.01, "slope");
  assert.ok(p.confidence > 0.99);
  assert.strictEqual(c.predict("climate.hp", "cool", 15, 2).kw, 2);
});

t("[M7] attribution: shared meter split over running units; idle → 0 and a learned baseline; climate-only meters", () => {
  const base = {};
  const outs = (ra, rb, co = false) => [{ key: "a", power_entity: "sensor.m", kw: 2, running: ra, climateOnly: co }, { key: "b", power_entity: "sensor.m", kw: 1, running: rb, climateOnly: co }];
  let r = attribute(outs(false, false), () => 0.3, base);
  assert.deepStrictEqual([r.get("a"), r.get("b")], [0, 0], "nothing running: nothing attributed");
  near(base["sensor.m"], 0.3, 1e-9, "baseline learned");
  r = attribute(outs(true, false), () => 2.1, base);
  near(r.get("a"), 1.8, 1e-9, "baseline taken off"); assert.strictEqual(r.get("b"), 0);
  r = attribute(outs(false, false, true), () => 1.5, {});
  assert.deepStrictEqual([r.get("a"), r.get("b")], [1, 0.5], "climate-only: a draw is a unit running");
  assert.ok(Number.isNaN(attribute([{ key: "c", power_entity: "", kw: 1 }], () => 1).get("c")));
});

// ======================================================================= planning

const model = () => new ThermalModel({ area_m2: 20 });
const basePlan = (over = {}) => planZone({
  zone: zone(), cfg: CFG, cap: { heat: 1.5, cool: 1.5 }, model: model(), now: MON,
  temp: 19, humidity: NaN, tout: 8, toutLater: { min: 4, max: 14 }, comfort: { heat: 20, cool: 25, confidence: 0 },
  occupied: true, away: false, nextOccMin: null, expectOcc: true, windowOpen: false, override: null,
  outlook: {}, sun: false, soc: 60, prevSide: null, ...over,
});

t("plan: an occupied cold room heats to comfort; levels widen toward protection", () => {
  const p = basePlan();
  assert.strictEqual(p.side, "heat");
  assert.deepStrictEqual(["protect", "setback", "comfort"].map((l) => p.levels[l].setpoint), [10, 17, 20]);
  assert.ok(p.levels.comfort.active && p.levels.comfort.kw > 0);
  assert.ok(p.levels.protect.kw <= p.levels.setback.kw && p.levels.setback.kw <= p.levels.comfort.kw);
  assert.deepStrictEqual(p.band("setback"), { low: 17, high: 28 });
  near(p.gap, 12, 0.01);
});

t("plan: a window open turns the zone off; unoccupied widens; away widens further", () => {
  assert.ok(Object.values(basePlan({ windowOpen: true }).levels).every((l) => !l.active));
  const p = basePlan({ occupied: false });
  assert.ok(!p.levels.comfort.active && p.levels.setback.active && p.levels.setback.setpoint === 17);
  assert.strictEqual(basePlan({ occupied: false, away: true }).levels.setback.setpoint, 14);
});

t("[M2] plan: pre-heats before predicted occupancy, including when it's due now", () => {
  const p = basePlan({ occupied: false, temp: 17, nextOccMin: 30 });
  assert.ok(p.leadMin >= 30 && p.levels.precondition.active && p.levels.precondition.setpoint === 20);
  assert.ok(basePlan({ occupied: false, temp: 16, nextOccMin: 0 }).levels.precondition.active, "0 = expected now");
  assert.ok(basePlan({ occupied: false, temp: 19.9, nextOccMin: 30, precondLatched: true }).levels.precondition.active, "latched");
  assert.ok(!basePlan({ occupied: false, temp: 17, nextOccMin: 30, away: true }).levels.precondition.active);
});

t("plan: soak is off by default; on, it pre-cools a comfortable room before a hot afternoon", () => {
  const args = { temp: 23, tout: 24, toutLater: { min: 20, max: 34 }, sun: true, outlook: { fullSoon: true } };
  assert.ok(!basePlan(args).levels.soak.active, "soak_enabled is false by default");
  const p = basePlan({ ...args, cfg: SOAK });
  assert.strictEqual(p.soakSide, "cool");
  assert.ok(p.levels.soak.active && p.levels.soak.setpoint === 22 && p.levels.soak.kw > 0);
  assert.ok(!basePlan({ ...args, cfg: SOAK, outlook: {} }).levels.soak.active, "no surplus forecast");
  assert.ok(!basePlan({ ...args, cfg: SOAK, sun: false }).levels.soak.active, "not at night");
});

t("[H2] plan: soak never runs against the side the room needs now", () => {
  const p = basePlan({ cfg: SOAK, temp: 17, tout: 12, toutLater: { min: 12, max: 33 }, sun: true, soc: 100, outlook: { fullSoon: true } });
  assert.strictEqual(p.side, "heat");
  assert.strictEqual(p.soakSide, "cool");
  assert.ok(!p.levels.soak.active, "cold room: no pre-cooling");
});

t("plan: humidity lowers the cooling setpoint (with the caller's hysteresis)", () => {
  assert.strictEqual(basePlan({ humidity: 80 }).comfort.cool, 24);
  assert.strictEqual(basePlan({ humidity: 68, humid: true }).comfort.cool, 24, "still muggy on the way down");
});

t("[M3] plan: no outdoor reading is NaN, never a fake 20 °C", () => {
  const p = basePlan({ tout: NaN });
  assert.ok(Number.isNaN(p.tout));
  assert.strictEqual(p.gap, 0);
  assert.strictEqual(p.side, "heat");
  assert.ok(Object.values(p.levels).every((l) => Number.isFinite(l.kw)), "power still planned");
  assert.ok(p.levels.comfort.kw > 0);
});

t("[H7] plan: with no room temperature, protection and setback fall back to the unit's thermostat", () => {
  const p = basePlan({ temp: NaN, noReading: true });
  assert.ok(p.fallback && !p.blocked);
  assert.ok(p.levels.protect.active && p.levels.setback.active);
  assert.ok(!p.levels.comfort.active && !p.levels.soak.active);
  const blind = basePlan({ temp: NaN, tout: NaN, noReading: true });
  assert.strictEqual(blind.levels.protect.kw, 0, "knowing nothing, protection claims nothing (it can't be shed)");
  assert.ok(blind.levels.setback.kw > 0);
});

// ======================================================================= ladder

const walk = (pol, plans, ctx, zones = [zone()]) => {
  const r = decide(Ladder.expand(pol, zones, plans), ctx, LIMITS);
  return { r, d: Ladder.resolve(zones, plans, r).get(zones[0].id) };
};

t("[H1] ladder: on the starter policy's rungs (20, 100) an occupied cold room gets comfort from the battery", () => {
  const plans = new Map([["office", basePlan({ temp: 17 })]]);
  const { d } = walk(DEFAULT_POLICY, plans, { ...CTX, soc: 80 });
  assert.deepStrictEqual([d.state, d.level, d.mode, d.setpoint], ["running", "comfort", "heat", 20]);
});

t("[H1] ladder: auto placement — protect above the first rung, levels after it on their own floors, soak last", () => {
  const plans = new Map([["office", basePlan()]]);
  const out = Ladder.expand(POLICY, [zone()], plans);
  const idx = (lvl) => out.list.findIndex((e) => e.climate && e.climate.level === lvl);
  const rung = (to) => out.list.findIndex((e) => e.type === "charge" && e.to === to);
  assert.ok(idx("protect") < rung(20) && out.list[idx("protect")].gen, "protect: above the first rung, gen-like");
  for (const [lvl, floor] of [["setback", 30], ["comfort", 40], ["precondition", 60]]) {
    assert.ok(idx(lvl) > rung(20) && idx(lvl) < rung(40), lvl);
    assert.strictEqual(out.list[idx(lvl)].floor, floor, `${lvl} floor`);
  }
  assert.ok(idx("soak") === out.list.length - 1 && out.list[idx("soak")].floor === 100);
  const lux = Ladder.expand(POLICY, [zone({ energy_class: "luxury" })], plans);
  assert.ok(!lux.list.some((e) => e.climate && e.climate.level === "precondition"), "luxury: no pre-conditioning");
});

t("[H1] decide: an entry's own floor, never lower than its rung's", () => {
  const pol = { devices: [{ id: "x", kw: 1 }], list: [{ type: "charge", to: 20 }, { type: "load", dev: "x", cond: "1", floor: 50 }] };
  assert.ok(!decide(pol, { ...CTX, soc: 45 }, LIMITS).decisions[0].run);
  assert.ok(decide(pol, { ...CTX, soc: 55 }, LIMITS).decisions[0].run);
  const low = { ...pol, list: [{ type: "charge", to: 60 }, { type: "load", dev: "x", cond: "1", floor: 10 }] };
  assert.ok(!decide(low, { ...CTX, soc: 55 }, LIMITS).decisions[0].run, "the rung's 60% still applies");
});

t("[M10] decide: hysteresis is remembered per entry key, not per device", () => {
  const pol = { devices: [{ id: "x", kw: 1 }], list: [{ type: "charge", to: 20 },
    { type: "load", dev: "x", cond: "1", kw: 0.5, hkey: "x#a" }, { type: "load", dev: "x", cond: "1", kw: 1, floor: 60, hkey: "x#b" }] };
  const shallow = decide(pol, { ...CTX, soc: 59 }, LIMITS, new Set(["x", "x#a"]));
  assert.strictEqual(shallow.trace[2].outcome, "partial", "running at the shallow level doesn't hold the deep one");
  const deep = decide(pol, { ...CTX, soc: 59 }, LIMITS, new Set(["x", "x#a", "x#b"]));
  assert.strictEqual(deep.trace[2].outcome, "granted", "the deep level holds its own hysteresis");
  assert.deepStrictEqual(deep.grantedKeys, ["x#a", "x#b"]);
});

t("ladder: deficit coasts — comfort shed, setback kept (free), band widened, unit off", () => {
  const plans = new Map([["office", basePlan()]]);
  const { d } = walk(POLICY, plans, { ...CTX, soc: 35 });
  assert.deepStrictEqual([d.level, d.setpoint, d.state, d.mode], ["setback", 17, "coast", "off"]);
  assert.ok(d.refused.includes("comfort") && /band widened/.test(d.reason) && /coasting at 19 °C, holds ≥ 17 °C for ~/.test(d.reason), d.reason);
});

t("[H7] ladder: protection is never shed — at the reserve a freezing room still heats (a deficit, not a shed)", () => {
  const m = model(); m.theta[1] = 0;   // even a model that thinks heating does nothing
  const plans = new Map([["office", basePlan({ temp: 9, model: m })]]);
  const { r, d } = walk(POLICY, plans, { ...CTX, soc: 10 });
  assert.deepStrictEqual([d.level, d.mode, d.setpoint, d.state], ["protect", "heat", 10, "running"]);
  assert.ok(r.deficitKw > 0, "raised as a deficit");
  const safe = walk(POLICY, plans, { ...CTX, soc: 10 });   // safe mode substitutes the reserve: same
  assert.strictEqual(safe.d.level, "protect");
});

t("ladder: explicit entries replace auto placement; a level under the 100% rung is warned about", () => {
  const pol = { ...POLICY, list: [...POLICY.list, { type: "climate", zone: "office", level: "comfort", cond: "autonomy > 5" }] };
  assert.deepStrictEqual(checkPolicy(pol), []);
  const plans = new Map([["office", basePlan()]]);
  const ex = Ladder.expand(pol, [zone()], plans);
  assert.strictEqual(ex.list.filter((e) => e.climate).length, 1);
  assert.ok(/only ever runs on surplus/.test(ex.warnings[0]));
  const r = decide(ex, { ...CTX, soc: 100, pv: 5 }, LIMITS);
  assert.strictEqual(Ladder.resolve([zone()], plans, r).get("office").state, "idle", "autonomy 2 < 5");
  assert.ok(checkPolicy({ ...POLICY, list: [{ type: "climate", zone: "office", level: "warm" }] }).length);
});

t("ladder: legacy sp rules on a taken-over device keep working with modelled kW and the zone's occupancy", () => {
  const pol = { devices: [{ id: "amber", name: "Office (Amber)", kw: 5 }],
    list: [{ type: "charge", to: 20 }, { type: "load", dev: "amber", cond: "gap > 10 ? 1 : 0", sp: 4 }, { type: "load", dev: "amber", cond: "occ", sp: 0 }] };
  const z = zone({ device: "amber", outputs: [{ kind: "ac", entity: "climate.amber", kw: 1.5 }] });
  const away = new Map([["office", basePlan({ occupied: false })]]);
  const r = decide(Ladder.expand(pol, [z], away), { ...CTX, soc: 90, occ: 1 }, LIMITS);
  const rows = r.trace.filter((x) => x.climate);
  assert.strictEqual(rows[1].outcome, "idle", "the zone's occ (0) wins over the house occ (1)");
  assert.ok(["granted", "already-served"].includes(rows[0].outcome) && rows[0].f === 1);
  assert.ok(rows[0].demandKw < 5, "modelled kW, not the 5 kW nameplate");
  assert.strictEqual(Ladder.resolve([z], away, r).get("office").setpoint, 16);
});

t("[M1] ladder: a zone taking over a load but with no outputs leaves that load as it was", () => {
  const pol = { devices: [{ id: "amber", kw: 5 }], list: [{ type: "load", dev: "amber", cond: "1", sp: 3 }] };
  const z = zone({ device: "amber", outputs: [] });
  const ex = Ladder.expand(pol, [z], new Map([["office", basePlan()]]));
  assert.deepStrictEqual(ex.list, pol.list, "real walk: unchanged");
  assert.ok(Ladder.expand(pol, [z], new Map([["office", basePlan()]]), { advisory: true }).list[0].climate, "shadow: planned");
});

t("[H6] ladder: a person's setting stands only while comfort is affordable", () => {
  const manual = { mode: "heat", setpoint: 26, until: MON + 20 * HOUR };
  const plans = new Map([["office", basePlan({ temp: 22, override: manual })]]);
  const low = walk(POLICY, plans, { ...CTX, soc: 12 }).d;
  assert.notStrictEqual(low.mode, "manual", "at a low battery the brain enforces the granted band");
  assert.ok(low.overruled && /isn't affordable/.test(low.reason), low.reason);
  assert.strictEqual(walk(POLICY, plans, { ...CTX, soc: 95 }).d.mode, "manual", "with comfort granted it stands");
});

t("[H8] ladder: an advisory zone takes no real budget; a shadow walk says what it would get", () => {
  const pol = { devices: [{ id: "pump", kw: 1 }], list: [{ type: "charge", to: 20 }, { type: "charge", to: 100 }, { type: "load", dev: "pump", cond: "1" }] };
  const z = zone({ outputs: [] });   // advisory
  const plans = new Map([["office", basePlan({ temp: 33.5, tout: 34, sun: true })]]);
  const ctx = { ...CTX, soc: 100, pv: 1.2, sun: 1, tout: 34 };
  const real = decide(Ladder.expand(pol, [z], plans), ctx, LIMITS);
  assert.ok(real.decisions.find((x) => x.id === "pump").run, "the real pump still runs");
  assert.ok(!real.decisions.some((x) => x.id === "climate_office"));
  const shadow = decide(Ladder.expand(pol, [z], plans, { advisory: true }), ctx, LIMITS);
  const d = Ladder.resolve([z], plans, real, shadow).get("office");
  assert.strictEqual(d.kw, 0);
  assert.ok(d.shadowKw > 0 && d.advisory && d.mode === "cool", JSON.stringify(d));
});

t("ladder: a policy with no zones is untouched", () => {
  assert.strictEqual(Ladder.expand(POLICY, [], new Map()), POLICY);
});

t("[M11] projection: climate kW added to the load; old samples without climKw left out of the profile", () => {
  const battery = { capacity_kwh: 50, reserve_pct: 10, max_charge_kw: 5, inverter_kw: 7.5 };
  const pol = { devices: [{ id: "heater", kw: 1, climate: "office" }], list: [{ type: "load", dev: "heater", cond: "1", kw: 0.8 }] };
  let seenNow = null;
  const steps = project({ now: MON, soc: 50, ctx: CTX, policy: pol, limits: { ...battery, tick_hours: 1 }, battery,
    forecast: [], load: () => 0.5, hours: 1, stepMin: 60, expand: (t, c, now) => { seenNow = now; return pol; } });
  assert.deepStrictEqual(steps.map((s) => [s.loadKw, s.climateKw]), [[1.3, 0.8], [1.3, 0.8]]);
  assert.strictEqual(seenNow, MON, "the hook gets the projection's start");
  const prof = loadProfile([{ t: MON, loadKw: 3 }, { t: MON + MIN, loadKw: 1.5, climKw: 1 }], 0, { lessClimate: true });
  assert.strictEqual(prof(MON), 0.5, "the sample with no climKw might hold climate: left out");
});

// ======================================================================= brain

function fakeHa(states, extra = {}) {
  const calls = [];
  return {
    calls, ready: false, states, ourContexts: new Set(), userId: null,
    entity: (id) => (states[id] ? { attributes: {}, ageSec: 5, ...states[id] } : null),
    callService: async (domain, service, entity, data) => { calls.push([domain, service, entity, data]); return { context: { id: `ctx${calls.length}` } }; },
    send: async () => ({}), ...extra,
  };
}
const ZONE_CFG = { id: "office", name: "Office", temp_entities: ["sensor.office_t"], presence_entities: ["binary_sensor.office_occupancy", "binary_sensor.office_motion"],
  outputs: [{ kind: "ac", entity: "climate.office", kw: 1.5, power_entity: "sensor.office_ac_power" }] };
const brainWith = (states, zoneOver = {}, cfgOver = {}, state) => {
  const ha = fakeHa(states);
  const b = new ClimateBrain({ ha, state });
  b.configure({ enabled: true, zones: [{ ...ZONE_CFG, ...zoneOver }], ...cfgOver });
  return { b, ha };
};

t("brain: a hand change to what the brain set is an override: learned strongly, then respected", () => {
  const st = { "sensor.office_t": { state: "18" }, "binary_sensor.office_occupancy": { state: "on" }, "binary_sensor.office_motion": { state: "unavailable" },
    "climate.office": { state: "heat", attributes: { temperature: 21 } }, "sensor.office_ac_power": { state: "900", attributes: { unit_of_measurement: "W" } } };
  const { b } = brainWith(st);
  b.actuator.commanded.set("climate.office", { mode: "heat", setpoint: 21, at: MON + 18 * HOUR });
  b.tick(MON + 18 * HOUR + 30000, { tout: 8, sun: false, soc: 80 });
  st["climate.office"] = { state: "heat", attributes: { temperature: 23 }, context: { id: "p1", user_id: "peter", parent_id: null } };
  const plans = b.tick(MON + 18 * HOUR + 10 * MIN, { tout: 8, sun: false, soc: 80 });
  assert.ok(b.overrides.office && b.overrides.office.setpoint === 23);
  assert.ok(b.prefs.preferred("office", MON + 18 * HOUR, "heat", 20).learned > 22.9);
  assert.ok(plans.get("office").manual && plans.get("office").comfort.heat === 23);
  assert.strictEqual(plans.get("office").occupied, true, "one presence sensor on, the other unavailable");
});

t("[H3] brain: it never learns its own setpoints — across hours and a restart", () => {
  const st = { "sensor.office_t": { state: "18" }, "binary_sensor.office_occupancy": { state: "on" }, "climate.office": { state: "heat", attributes: { temperature: 17 } } };
  const { b, ha } = brainWith(st);
  b.actuator.commanded.set("climate.office", { mode: "heat", setpoint: 17, at: MON + 18 * HOUR });   // the setback, while comfort was shed
  for (let k = 0; k <= 4 * 60; k += 5) b.tick(MON + 18 * HOUR + k * MIN, { tout: 8, soc: 30 });
  assert.strictEqual(b.prefs.preferred("office", MON + 21 * HOUR, "heat", 20).learned, null, "no hold samples of its own setting");
  const b2 = new ClimateBrain({ ha, state: JSON.parse(JSON.stringify(b.toJSON())) });
  b2.configure({ enabled: true, zones: [ZONE_CFG] });
  assert.strictEqual(b2.actuator.commanded.get("climate.office").setpoint, 17, "commanded is persisted");
  for (let k = 0; k <= 3 * 60; k += 5) b2.tick(MON + 23 * HOUR + k * MIN, { tout: 8, soc: 30 });
  assert.strictEqual(b2.prefs.preferred("office", MON + 24 * HOUR, "heat", 20).learned, null, "nor after a restart");
});

t("[H3] brain: automations and the brain's own HA user don't teach; people do", () => {
  const st = { "sensor.office_t": { state: "18" }, "binary_sensor.office_occupancy": { state: "off" }, "climate.office": { state: "heat", attributes: { temperature: 20 } } };
  const { b, ha } = brainWith(st);
  ha.userId = "brain-user";
  b.tick(MON + 19 * HOUR, { tout: 8 });
  st["climate.office"] = { state: "heat", attributes: { temperature: 23 }, context: { id: "a1", parent_id: "automation-run", user_id: null } };
  b.tick(MON + 19 * HOUR + MIN, { tout: 8 });
  st["climate.office"] = { state: "heat", attributes: { temperature: 24 }, context: { id: "a2", parent_id: null, user_id: "brain-user" } };
  b.tick(MON + 19 * HOUR + 2 * MIN, { tout: 8 });
  assert.strictEqual(b.prefs.preferred("office", MON + 19 * HOUR, "heat", 20).learned, null);
  st["climate.office"] = { state: "heat", attributes: { temperature: 22 }, context: { id: "a3", parent_id: null, user_id: "peter" } };
  b.tick(MON + 19 * HOUR + 3 * MIN, { tout: 8 });
  near(b.prefs.preferred("office", MON + 19 * HOUR, "heat", 20).learned, 22, 0.01, "a person");
});

t("[H4] brain: a unit rounding the brain's setpoint, or echoing it late, is not an override", () => {
  const st = { "sensor.office_t": { state: "18" }, "climate.office": { state: "heat", attributes: { temperature: 20, target_temp_step: 1 } } };
  const { b } = brainWith(st);
  b.tick(MON + 18 * HOUR, { tout: 8 });
  // The actuator sends 20.5 as 21 on a 1° unit (fitSetpoint), and remembers 21.
  b.actuator.commanded.set("climate.office", { mode: "heat", setpoint: fitSetpoint(20.5, { step: 1 }), at: MON + 18 * HOUR + 5000, step: 1 });
  st["climate.office"] = { state: "heat", attributes: { temperature: 21, target_temp_step: 1 }, context: { id: "ours1" } };
  b.tick(MON + 18 * HOUR + 10000, { tout: 8 });
  assert.ok(!b.overrides.office, "its own step-rounded command");
  b.actuator.commanded.set("climate.office", { mode: "heat", setpoint: 19, at: MON + 18 * HOUR + MIN, step: 1 });
  b.tick(MON + 18 * HOUR + 8 * MIN, { tout: 8 });   // still showing 21
  st["climate.office"] = { state: "heat", attributes: { temperature: 19, target_temp_step: 1 }, context: { id: "ours2" } };
  b.tick(MON + 18 * HOUR + 12 * MIN, { tout: 8 });   // the echo, 11 min later
  assert.ok(!b.overrides.office, "a late echo is still ours");
  assert.strictEqual(fitSetpoint(20.6, { step: 1 }), 21);
  assert.strictEqual(fitSetpoint(35, { step: 0.5, maxTemp: 30 }), 30, "clamped to the unit's range");
  assert.strictEqual(fitSetpoint(5, { step: 0.5, minTemp: 16 }), 16);
});

t("[M4] brain: a metered unit idling at setpoint isn't flagged; one claiming to heat at ~0 W is", () => {
  const st = { "sensor.office_t": { state: "21" }, "climate.office": { state: "heat", attributes: { temperature: 21 } },
    "sensor.office_ac_power": { state: "3", attributes: { unit_of_measurement: "W" } } };
  const { b } = brainWith(st);
  for (let m = 0; m <= 11; m++) b.tick(MON + 18 * HOUR + m * MIN, { tout: 8 });
  assert.strictEqual(b.flags.get("office").length, 0, "at setpoint, no hvac_action: idle, fine");
  st["climate.office"] = { state: "heat", attributes: { temperature: 21, hvac_action: "heating" } };
  for (let m = 12; m <= 23; m++) b.tick(MON + 18 * HOUR + m * MIN, { tout: 8 });
  assert.ok(/~0 W/.test(b.flags.get("office")[0].problem));
  st["sensor.office_ac_power"].state = "1200";
  b.tick(MON + 18 * HOUR + 24 * MIN, { tout: 8 });
  assert.strictEqual(b.flags.get("office").length, 0);
});

t("[LOW] readings: fan-only and dry aren't heating", () => {
  const z = zone({ outputs: [{ kind: "ac", entity: "climate.office", kw: 1.5 }] });
  for (const mode of ["fan_only", "dry"]) {
    const r = Zones.readZone(z, (id) => (id === "climate.office" ? { state: mode, attributes: {} } : { state: "22", attributes: {} }));
    assert.strictEqual(r.heatKw, 0, mode);
  }
});

t("brain: metered draw feeds the consumption curve and the zone's rating", () => {
  const st = { "sensor.office_t": { state: "18" }, "climate.office": { state: "heat", attributes: { temperature: 21, hvac_action: "heating" } },
    "sensor.office_ac_power": { state: "800", attributes: { unit_of_measurement: "W" } } };
  const { b } = brainWith(st);
  for (let m = 0; m < 120; m++) b.tick(MON + 18 * HOUR + m * MIN, { tout: 8 });
  near(b.curves.predict("climate.office", "heat", 12, 1.5).learned, 0.8, 0.001);
  assert.ok(b.plans.get("office").cap.heat < 1.0);
  near(b.measuredKw(), 0.8, 1e-9);
});

t("[M5] brain: an energy counter ticking every 5 s still gives power", () => {
  const { b } = brainWith({});
  const ctx = { energy: new Map() };
  let kw;
  for (let k = 0; k < 720; k++) kw = b._fromEnergy("k", { state: String((100 + (k * 5 / 3600) * 2).toFixed(4)), attributes: {} }, MON + k * 5000, ctx);
  near(kw, 2, 0.05, "2 kW steady");
});

t("[H9] brain: corrupt or foreign learned state starts fresh instead of crashing", () => {
  const states = [{ models: { office: { theta: [0.04, 5, 5, 0.2] } } }, { prefs: "x", occ: [1], curves: { a: { w: "x" } }, models: 5, actuator: { obs: { k: { on: "?" } } } },
    { version: 99, prefs: { office: {} } }, null, "garbage"];
  for (const state of states) {
    const { b } = brainWith({ "sensor.office_t": { state: "19" } }, {}, {}, state);
    b.tick(MON, { tout: 8 });
    JSON.stringify(b.toJSON());
  }
});

t("[M2] brain: pre-conditioning when people are due now, latched, then given up after the grace", () => {
  const st = { "sensor.office_t": { state: "17" }, "binary_sensor.office_occupancy": { state: "off" }, "binary_sensor.office_motion": { state: "off" } };
  const { b } = brainWith(st, { outputs: [{ kind: "ac", entity: "climate.office", kw: 1.5 }] });
  for (let w = 1; w <= 4; w++) b.occ.addHour("office", MON - w * 7 * DAY + 18 * HOUR, 1);
  const T0 = MON + 18 * HOUR;
  assert.ok(b.tick(T0, { tout: 8 }).get("office").levels.precondition.active, "due now");
  assert.ok(b.latch.office > T0);
  assert.ok(b.tick(T0 + 45 * MIN, { tout: 8 }).get("office").levels.precondition.active, "still within the grace");
  assert.ok(!b.tick(T0 + 95 * MIN, { tout: 8 }).get("office").levels.precondition.active, "gave up");
});

t("[M1] brain: a failed tick lets go of the zones' devices", () => {
  const { b } = brainWith({ "sensor.office_t": { state: "19" } });
  b.tick(MON, { tout: 8 });
  assert.ok(b.owns("climate_office"));
  b.markFailed();
  assert.ok(!b.owns("climate_office") && b.decisions.size === 0 && b.snapshot().failed);
  b.tick(MON + MIN, { tout: 8 });
  assert.ok(b.owns("climate_office"), "back next tick");
  const adv = brainWith({ "sensor.office_t": { state: "19" } }, { outputs: [] }).b;
  assert.ok(!adv.owns("climate_office"), "an advisory zone owns nothing");
});

t("[LOW] brain: removed zones are forgotten; away doesn't teach occupancy; humidity has hysteresis", () => {
  const st = { "sensor.office_t": { state: "19" }, "binary_sensor.office_occupancy": { state: "on" }, "person.us": { state: "not_home" }, "sensor.h": { state: "72" } };
  const { b } = brainWith(st, { humidity_entity: "sensor.h" }, { presence_entity: "person.us" });
  for (let m = 0; m < 130; m += 5) b.tick(MON + m * MIN, { tout: 8 });
  assert.strictEqual(b.occ.probability("office", MON + 7 * DAY, 0.3).p, 0.3, "away: not learned");
  assert.ok(b.humid.get("office"));
  st["sensor.h"].state = "67"; b.tick(MON + 131 * MIN, { tout: 8 });
  assert.ok(b.humid.get("office"), "67%: still muggy");
  st["sensor.h"].state = "64"; b.tick(MON + 132 * MIN, { tout: 8 });
  assert.ok(!b.humid.get("office"));
  b.prefs.observe("office", MON, "heat", 22);
  b.configure({ enabled: true, zones: [{ ...ZONE_CFG, id: "den", name: "Den" }] });
  assert.ok(!b.prefs.z.office && !b.models.has("office"), "purged");
});

t("[M11] brain: projection pays for recovery after a setback, and leaves advisory zones out", () => {
  const { b } = brainWith({ "sensor.office_t": { state: "20" } }, { outputs: [{ kind: "ac", entity: "climate.office", kw: 3 }] });
  for (let w = 1; w <= 6; w++) { b.occ.addHour("office", MON - w * 7 * DAY + 17 * HOUR, 0); b.occ.addHour("office", MON - w * 7 * DAY + 18 * HOUR, 1); b.occ.addHour("office", MON - w * 7 * DAY + 19 * HOUR, 1); }
  const start = MON + 12 * HOUR;
  b.tick(start, { tout: 5 });
  const kwAt = (t) => b.expandAt(POLICY, t, { ...CTX, tout: 5 }, start).list.find((e) => e.climate && e.climate.level === "comfort").kw;
  assert.ok(kwAt(MON + 18 * HOUR + 30 * MIN) > kwAt(MON + 19 * HOUR + 30 * MIN), "arriving costs more than staying");
  const adv = brainWith({ "sensor.office_t": { state: "20" } }, { outputs: [] }).b;
  adv.tick(start, { tout: 5 });
  assert.ok(!adv.expandAt(POLICY, start + HOUR, CTX, start).list.some((e) => e.climate), "advisory: nothing projected");
});

t("brain: the low-case outlook flags surplus coming and climate shed later", () => {
  const { b } = brainWith({});
  b.setOutlook([{ t: MON + HOUR, soc: 80, socLow: 99, shed: [] }, { t: MON + 5 * HOUR, soc: 30, socLow: 20, shed: ["climate_office"] }], MON);
  assert.deepStrictEqual(b.outlookFor(b.zones[0]), { fullSoon: true, tight: true, shedSoon: true });
});

// ======================================================================= actuation

const ac = (over = {}) => zone({ outputs: [{ kind: "ac", entity: "climate.office", kw: 1.5, min_on_s: 300, min_off_s: 300, ...over }] });
const reading = (o) => new Map([["office", { temp: 18, outputs: [{ available: true, on: false, mode: "off", setpoint: NaN, step: 0.5, ...o }] }]]);
const dec = (mode, setpoint, extra = {}) => new Map([["office", { mode, setpoint, reason: "test", ...extra }]]);

t("[H5] actuator: dry run then live — what dry run advised is sent once live", async () => {
  const ha = fakeHa({}), act = new ClimateActuator({ ha });
  await act.apply([ac()], dec("heat", 20), reading({}), { dryRun: true, now: MON });
  assert.strictEqual(ha.calls.length, 0);
  assert.strictEqual(act.commanded.size, 0, "dry run commands nothing");
  await act.apply([ac()], dec("heat", 20), reading({}), { dryRun: false, now: MON + HOUR });
  assert.deepStrictEqual(ha.calls[0], ["climate", "set_temperature", "climate.office", { temperature: 20, hvac_mode: "heat" }]);
});

t("[H5] actuator: minimum run counted from what the unit was seen doing; a restart remembers it", async () => {
  const ha = fakeHa({}), act = new ClimateActuator({ ha });
  const on = reading({ on: true, mode: "heat", setpoint: 20 });
  let out = await act.apply([ac()], dec("off", null), on, { dryRun: false, now: MON });
  assert.strictEqual(ha.calls.length, 0, "first sight of a running unit: a dwell is owed");
  assert.strictEqual(out[0].action, "held");
  const act2 = new ClimateActuator({ ha, state: JSON.parse(JSON.stringify(act.toJSON())) });
  out = await act2.apply([ac()], dec("off", null), on, { dryRun: false, now: MON + 200000 });
  assert.strictEqual(ha.calls.length, 0, "the restart still owes the rest");
  await act2.apply([ac()], dec("off", null), on, { dryRun: false, now: MON + 301000 });
  assert.deepStrictEqual(ha.calls[0], ["climate", "set_hvac_mode", "climate.office", { hvac_mode: "off" }]);
});

t("[H5] actuator: heat to cool goes through off", async () => {
  const ha = fakeHa({}), act = new ClimateActuator({ ha });
  const heating = reading({ on: true, mode: "heat", setpoint: 20 });
  await act.apply([ac({ min_on_s: 0, min_off_s: 120 })], dec("cool", 24), heating, { dryRun: false, now: MON });
  assert.deepStrictEqual(ha.calls[0].slice(0, 2), ["climate", "set_hvac_mode"], "off first");
  const off = reading({ on: false, mode: "off" });
  await act.apply([ac({ min_on_s: 0, min_off_s: 120 })], dec("cool", 24), off, { dryRun: false, now: MON + 60000 });
  assert.strictEqual(ha.calls.length, 1, "minimum off before cooling");
  await act.apply([ac({ min_on_s: 0, min_off_s: 120 })], dec("cool", 24), off, { dryRun: false, now: MON + 190000 });
  assert.deepStrictEqual(ha.calls[1], ["climate", "set_temperature", "climate.office", { temperature: 24, hvac_mode: "cool" }]);
});

t("[H5] actuator: a unit that doesn't follow is resent with a backoff; failures back off too", async () => {
  const ha = fakeHa({}), act = new ClimateActuator({ ha });
  const z = ac({ min_on_s: 0, min_off_s: 0 });
  await act.apply([z], dec("heat", 21), reading({}), { dryRun: false, now: MON });
  await act.apply([z], dec("heat", 21), reading({}), { dryRun: false, now: MON + 30000 });
  assert.strictEqual(ha.calls.length, 1, "not before a minute");
  await act.apply([z], dec("heat", 21), reading({}), { dryRun: false, now: MON + 61000 });
  assert.strictEqual(ha.calls.length, 2, "resent");
  await act.apply([z], dec("heat", 21), reading({ on: true, mode: "heat", setpoint: 21 }), { dryRun: false, now: MON + 62000 });
  assert.ok(!act.resend.has("climate.office"), "followed: backoff cleared");
  const bad = new ClimateActuator({ ha: { callService: async () => { throw new Error("nope"); } } });
  await bad.apply([z], dec("heat", 21), reading({}), { dryRun: false, now: MON });
  const out = await bad.apply([z], dec("heat", 21), reading({}), { dryRun: false, now: MON + 10000 });
  assert.strictEqual(out[0].action, "waiting");
});

t("[H4] actuator: setpoints go out on the unit's step and inside its range", async () => {
  const ha = fakeHa({}), act = new ClimateActuator({ ha });
  await act.apply([ac({ min_off_s: 0 })], dec("cool", 14.3), reading({ step: 1, minTemp: 16, maxTemp: 30 }), { dryRun: false, now: MON });
  assert.strictEqual(ha.calls[0][3].temperature, 16);
  const ha2 = fakeHa({}), act2 = new ClimateActuator({ ha: ha2 });
  await act2.apply([ac({ min_off_s: 0 })], dec("heat", 20.6), reading({ step: 1 }), { dryRun: false, now: MON });
  assert.strictEqual(ha2.calls[0][3].temperature, 21);
});

t("[H7] actuator: with no room temperature a thermostat is given the setback, never switched off", async () => {
  const ha = fakeHa({}), act = new ClimateActuator({ ha });
  const r = new Map([["office", { temp: NaN, outputs: [{ available: true, on: true, mode: "heat", setpoint: 21, step: 0.5 }] }]]);
  await act.apply([ac()], dec("heat", 17, { state: "fallback" }), r, { dryRun: false, now: MON });
  assert.deepStrictEqual(ha.calls[0], ["climate", "set_temperature", "climate.office", { temperature: 17, hvac_mode: "heat" }]);
  const v = zone({ outputs: [{ kind: "hydronic", entity: "switch.valve", kw: 0.1, min_on_s: 0, min_off_s: 0 }] });
  const ha2 = fakeHa({}), act2 = new ClimateActuator({ ha: ha2 });
  await act2.apply([v], dec("heat", 17, { state: "fallback" }), new Map([["office", { temp: NaN, outputs: [{ available: true, on: true, mode: "heat" }] }]]), { dryRun: false, now: MON });
  assert.strictEqual(ha2.calls.length, 0, "a valve with no reading is left as it is");
});

t("actuator: a hydronic valve and its shared source (read from the real source state); a manual zone keeps the source on", async () => {
  const z = zone({ outputs: [{ kind: "hydronic", entity: "switch.office_valve", kw: 0.1, min_on_s: 0, min_off_s: 0, source_entity: "climate.heat_pump" }] });
  const src = { "climate.heat_pump": { state: "off" } };
  const ha = fakeHa(src), act = new ClimateActuator({ ha });
  const r = (temp, on) => new Map([["office", { temp, outputs: [{ available: true, on, mode: on ? "heat" : "off" }] }]]);
  const d = dec("heat", 20);
  await act.apply([z], d, r(19, false), { dryRun: false, now: MON, get: ha.entity });
  assert.deepStrictEqual(ha.calls.map((c) => c.slice(0, 3)), [["switch", "turn_on", "switch.office_valve"], ["climate", "set_hvac_mode", "climate.heat_pump"]]);
  src["climate.heat_pump"].state = "heat";
  await act.apply([z], d, r(20.1, true), { dryRun: false, now: MON + 120000, get: ha.entity });
  assert.strictEqual(ha.calls.length, 2, "hysteresis keeps it on");
  await act.apply([z], dec("manual", null), r(20.4, true), { dryRun: false, now: MON + 240000, get: ha.entity });
  assert.strictEqual(ha.calls.length, 2, "a manual zone's running valve keeps the source on");
  await act.apply([z], d, r(20.4, true), { dryRun: false, now: MON + 360000, get: ha.entity });
  assert.deepStrictEqual(ha.calls.slice(2).map((c) => c.slice(0, 3)), [["switch", "turn_off", "switch.office_valve"], ["climate", "set_hvac_mode", "climate.heat_pump"]]);
});

t("actuator: advise-only zones are never commanded, even live", async () => {
  const ha = fakeHa({}), act = new ClimateActuator({ ha });
  await act.apply([zone({ advise_only: true, outputs: [{ kind: "ac", entity: "climate.office", kw: 1 }] })], dec("heat", 21), reading({}), { dryRun: false, now: MON });
  assert.strictEqual(ha.calls.length, 0);
});

// ======================================================================= outputs, settings, seeding

t("brain: end to end in dry run — plan, ladder, decision, advice, no calls", async () => {
  const st = { "sensor.office_t": { state: "17.5" }, "binary_sensor.office_occupancy": { state: "on" }, "climate.office": { state: "off", attributes: {} } };
  const { b, ha } = brainWith(st);
  b.tick(MON + 18 * HOUR, { tout: 6, sun: false, soc: 85 });
  const r = decide(b.expand(POLICY), { ...CTX, soc: 85 }, LIMITS);
  const d = b.resolve(r).get("office");
  assert.deepStrictEqual([d.mode, d.level, d.setpoint], ["heat", "comfort", 20]);
  const first = await b.apply({ dryRun: true, now: MON + 18 * HOUR });
  assert.strictEqual(first[0].action, "held", "a unit seen for the first time owes its minimum off");
  const adv = await b.apply({ dryRun: true, now: MON + 18 * HOUR + 301000 });
  assert.strictEqual(ha.calls.length, 0);
  assert.deepStrictEqual(adv.filter((a) => a.action === "dry_run").map((a) => a.detail), ["heat 20 °C"]);
  assert.ok(b.owns("climate_office") && !b.owns("network"));
  assert.deepStrictEqual(b.snapshot().zones[0].band, { low: 20, high: 25 });
});

t("[LOW] mqtt: zone devices named for the zone, area only when set, Reason diagnostic and sent on change, removals survive a restart", () => {
  const sent = [];
  const sink = new MqttSink({ enabled: true });
  sink.client = { connected: true, publish: (topic, payload) => sent.push([topic, payload]) };
  const last = (topic) => { for (let i = sent.length - 1; i >= 0; i--) if (sent[i][0] === topic) return sent[i][1]; return undefined; };
  const z = (over = {}) => ({ id: "office", name: "Office", area: "", plan: { temp: 19.5, occupied: true, occProb: 0.8, comfort: { confidence: 0.5 } },
    decision: { mode: "heat", setpoint: 20, level: "comfort", reason: "comfort: heat to 20 °C", kw: 0.6 }, band: { low: 20, high: 25 }, model: { confidence: 0.4 }, flags: [], ...over });
  sink.publishClimate({ zones: [z()] });
  const cfg = JSON.parse(last("homeassistant/sensor/offgrid_brain/climate_office_target/config"));
  assert.strictEqual(cfg.device.name, "Office");
  assert.strictEqual(cfg.device.via_device, "offgrid_brain");
  assert.ok(!("suggested_area" in cfg.device), "no area set: none suggested");
  assert.ok(!("default_entity_id" in cfg), "zone entities leave the id to HA (area + device + entity)");
  const zoneBtn = JSON.parse(last("homeassistant/button/offgrid_brain/climate_office_reset_learning/config"));
  assert.ok(!("default_entity_id" in zoneBtn), "zone button: id composed by HA too");
  sink.publish("sensor", "soc", 50, { name: "Battery SoC" });
  assert.strictEqual(JSON.parse(last("homeassistant/sensor/offgrid_brain/soc/config")).default_entity_id, "sensor.offgrid_brain_soc", "brain entities keep their fixed ids");
  assert.strictEqual(JSON.parse(last("homeassistant/sensor/offgrid_brain/climate_office_reason/config")).entity_category, "diagnostic");
  const n = sent.filter(([tp]) => tp === "offgrid_brain/climate_office_reason").length;
  sink.publishClimate({ zones: [z()] });
  assert.strictEqual(sent.filter(([tp]) => tp === "offgrid_brain/climate_office_reason").length, n, "unchanged reason not resent");
  sink.publishClimate({ zones: [z({ area: "Study" })] });
  assert.strictEqual(JSON.parse(last("homeassistant/sensor/offgrid_brain/climate_office_target/config")).device.suggested_area, "Study", "re-announced on area change");
  const saved = JSON.parse(JSON.stringify(sink.zonesJSON()));
  const sink2 = new MqttSink({ enabled: true });
  const sent2 = [];
  sink2.client = { connected: true, publish: (topic, payload) => sent2.push([topic, payload]) };
  sink2.restoreZones(saved);
  sink2.publishClimate({ zones: [] });
  assert.ok(sent2.some(([tp, p]) => tp === "homeassistant/sensor/offgrid_brain/climate_office_target/config" && p === ""), "removed after a restart");
});

t("[LOW] settings: zones normalised; problems normalising would hide are caught on the raw input", () => {
  const raw = { climate: { enabled: true, zones: [{ id: "office", name: "Office", temp_entities: "sensor.a, sensor.b",
    outputs: [{ kind: "ac", entity: "climate.office", kw: 1.2, power_entity: "sensor.shelly_ac" }] }] } };
  const s = Settings.normalise(raw);
  assert.deepStrictEqual(s.climate.zones[0].temp_entities, ["sensor.a", "sensor.b"]);
  assert.strictEqual(s.climate.soak_enabled, false);
  assert.deepStrictEqual([...Settings.checkRaw(raw), ...Settings.check(s)].filter((p) => /climate|Office/.test(p)), []);
  const bad = { climate: { enabled: true, zones: [{ id: "office", name: "Office", energy_class: "vip", temp_entities: ["sensor.a"], outputs: [{ kind: "boiler", entity: "climate.x" }] }] } };
  const probs = Settings.checkRaw(bad).join("; ");
  assert.ok(/energy class/.test(probs) && /kind must be/.test(probs), probs);
  assert.deepStrictEqual(Settings.check(Settings.normalise(bad)).filter((p) => /energy class|kind/.test(p)), [], "normalising hides them: hence the raw check");
});

t("[H3/M6/RR6] seed: a day per request, per entity; history has no context, so changes teach only weakly, and the brain's own never", async () => {
  const s = (iso, state, a, c) => ({ s: state, ...(a ? { a } : {}), ...(c ? { c } : {}), lu: at(iso) / 1000 });
  const rows = {
    "sensor.office_t": [s("2026-11-02T06:00:00", "18")],
    "climate.office": [s("2026-11-02T06:00:00", "off", {}), s("2026-11-02T07:00:00", "heat", { temperature: 25 }, { id: "x", parent_id: "auto" }),
      s("2026-11-02T08:00:00", "heat", { temperature: 17 }), s("2026-11-02T19:00:00", "heat", { temperature: 22 }, { id: "y", user_id: "peter" })],
    "binary_sensor.office_occupancy": [s("2026-11-02T06:00:00", "off"), s("2026-11-02T18:30:00", "on"), s("2026-11-02T22:00:00", "off")],
  };
  const requests = [];
  const ha = fakeHa({}, { ready: true, send: async (m) => { requests.push(m); const id = m.entity_ids[0];
    return { [id]: (rows[id] || []).filter((r) => r.lu * 1000 >= Date.parse(m.start_time) && r.lu * 1000 < Date.parse(m.end_time)) }; } });
  const b = new ClimateBrain({ ha });
  b.configure({ enabled: true, zones: [{ ...ZONE_CFG, presence_entities: ["binary_sensor.office_occupancy"], outputs: [{ kind: "ac", entity: "climate.office", kw: 1.5 }] }] });
  b.actuator.commanded.set("climate.office", { mode: "heat", setpoint: 17, at: at("2026-11-02T07:59:00") });
  await seedFromHistory(b, b.zones, { start: at("2026-11-02T00:00:00"), end: at("2026-11-04T00:00:00") });
  assert.strictEqual(requests.length, 2 * 3, "one request per entity per day");
  assert.ok(requests.every((m) => m.entity_ids.length === 1 && m.no_attributes === !m.entity_ids[0].startsWith("climate.")));
  assert.ok(b.prefs.preferred("office", at("2026-11-09T08:00:00"), "heat", 20).learned > 24, "the brain's own 17 isn't learned (the 25 next to it is, weakly)");
  const eve = b.prefs.preferred("office", at("2026-11-09T19:00:00"), "heat", 20);
  near(eve.learned, 22, 0.01, "the 22 is learned");
  assert.ok(eve.confidence < 0.25, `but weakly: ${eve.confidence}`);
  assert.ok(b.occ.probability("office", at("2026-11-09T20:00:00")).p > b.occ.probability("office", at("2026-11-09T10:00:00")).p);
  const hist = parseHistory({ "climate.office": rows["climate.office"] });
  assert.strictEqual(hist.get("climate.office")[1].context.parent_id, "auto");
  assert.ok(replay(b, b.zones, hist, { start: at("2026-11-02T06:00:00"), end: at("2026-11-02T09:00:00") }) >= 3);
});

t("[H7/LOW] ha: freshness from Home Assistant's last_reported; context kept; names respect has_entity_name", async () => {
  const ha = new HAClient({ token: "x" });
  ha._store("sensor.t", { state: "20", attributes: {}, last_updated: new Date(Date.now() - 5 * HOUR).toISOString(),
    last_reported: new Date(Date.now() - 4 * HOUR).toISOString(), context: { id: "c1", user_id: null, parent_id: null } });
  const e = ha.entity("sensor.t");
  assert.ok(e.ageSec > 3.9 * 3600, `age ${e.ageSec}`);
  assert.strictEqual(e.context.id, "c1");
  const z = zone();
  assert.ok(Number.isNaN(Zones.readZone(z, (id) => ha.entity(id)).temp), "a sensor silent for 4 h is stale, though just received");
  ha.send = async (m) => ({
    get_states: [{ entity_id: "sensor.a", state: "1", attributes: { friendly_name: "old" } }, { entity_id: "sensor.b", state: "1", attributes: {} },
      { entity_id: "sensor.c", state: "1", attributes: {} }, { entity_id: "sensor.d", state: "1", attributes: {} }],
    "config/entity_registry/list": [{ entity_id: "sensor.a", device_id: "d", has_entity_name: true, original_name: "Temperature" },
      { entity_id: "sensor.b", device_id: "d", has_entity_name: true, original_name: null },
      { entity_id: "sensor.c", device_id: "d", has_entity_name: false, original_name: "Hall sensor temperature" },
      { entity_id: "sensor.d", device_id: "d", has_entity_name: true, name: "Hall sensor battery" }],
    "config/device_registry/list": [{ id: "d", name: "Hall sensor", area_id: null }],
    "config/area_registry/list": [],
  })[m.type];
  const names = Object.fromEntries((await ha.listEntities()).map((x) => [x.entity_id, x.name]));
  assert.deepStrictEqual(names, { "sensor.a": "Hall sensor Temperature", "sensor.b": "Hall sensor", "sensor.c": "Hall sensor temperature", "sensor.d": "Hall sensor battery" });
});

// ======================================================================= re-review (RR1-RR8)

const STEP1 = { target_temp_step: 1, min_temp: 16, max_temp: 30 };
function liveBrain(st) {
  const ha = fakeHa(st, { userId: "brain" });
  const b = new ClimateBrain({ ha });
  b.configure({ enabled: true, zones: [{ ...ZONE_CFG, presence_entities: ["binary_sensor.o"], outputs: [{ kind: "ac", entity: "climate.office", kw: 1.5 }] }] });
  b._run = new Set();
  b.cycle = async (t, soc, dryRun = false) => {
    b.tick(t, { tout: 8, sun: false, soc });
    const r = decide(b.expand(DEFAULT_POLICY), { ...CTX, soc }, LIMITS, b._run);
    b.resolve(r);
    b._run = new Set([...r.decisions.filter((d) => d.run).map((d) => d.id), ...r.grantedKeys]);
    return b.apply({ dryRun, now: t });
  };
  return { b, ha };
}

t("brain: without the brain commanding (dry run), a person's change is learned but not held", () => {
  const st = { "sensor.office_t": { state: "18" }, "climate.office": { state: "cool", attributes: { temperature: 25 } } };
  const { b } = brainWith(st);
  b.tick(MON + 14 * HOUR, { tout: 30, sun: true, soc: 80 });
  st["climate.office"] = { state: "cool", attributes: { temperature: 23.5 }, context: { id: "p2", user_id: "peter" } };
  b.tick(MON + 14 * HOUR + MIN, { tout: 30, sun: true, soc: 80 });
  assert.ok(!b.overrides.office);
  near(b.prefs.preferred("office", MON + 14 * HOUR, "cool", 25).learned, 23.5, 0.01);
});

t("[RR1] actuator: a side flip during the minimum run sends nothing (the unit keeps its own setpoint)", async () => {
  for (const [unit, usp, dm, dsp] of [["heat", 20, "cool", 25], ["cool", 25, "heat", 20]]) {
    const ha = fakeHa({}), act = new ClimateActuator({ ha });
    const rd = new Map([["office", { temp: 22, outputs: [{ available: true, step: 0.5, on: true, mode: unit, setpoint: usp }] }]]);
    await act.apply([ac()], dec(unit, usp), rd, { dryRun: false, now: MON });
    const out = await act.apply([ac()], dec(dm, dsp), rd, { dryRun: false, now: MON + 60000 });
    assert.strictEqual(ha.calls.length, 0, `${unit} -> ${dm}: ${JSON.stringify(ha.calls)}`);
    assert.strictEqual(out[0].action, "held");
  }
});

t("[RR2] brain: a person's one-step nudge is theirs, not reverted as the brain's own", async () => {
  const st = { "sensor.office_t": { state: "18" }, "binary_sensor.o": { state: "on" }, "climate.office": { state: "heat", attributes: { temperature: 20, ...STEP1 } } };
  const { b, ha } = liveBrain(st);
  let t = MON + 18 * HOUR;
  b.actuator.obs.set("office#0", { on: true, mode: "heat", changedAt: t - HOUR });
  b.actuator.commanded.set("climate.office", { mode: "heat", setpoint: 20, at: t - HOUR, step: 1 });
  await b.cycle(t, 80);
  const n0 = ha.calls.length;
  st["climate.office"] = { state: "heat", attributes: { temperature: 21, ...STEP1 }, context: { id: "n1", user_id: "peter", parent_id: null } };
  t += 5000; await b.cycle(t, 80);
  assert.ok(b.overrides.office && b.overrides.office.setpoint === 21, "held as theirs");
  assert.strictEqual(b.decisions.get("office").state, "manual");
  assert.deepStrictEqual(ha.calls.slice(n0), [], "not sent back to 20");
  const { sameAsCommanded } = require("../climate/index.js");
  assert.ok(!sameAsCommanded({ mode: "heat", setpoint: 20, step: 1 }, { mode: "heat", setpoint: 21 }), "a whole step away isn't ours");
  assert.ok(sameAsCommanded({ mode: "heat", setpoint: 20, step: 1 }, { mode: "heat", setpoint: 20.4 }));
});

t("[RR3] brain: a setting the battery overruled is dropped; on recovery the brain plans the zone (from what it learned)", async () => {
  const st = { "sensor.office_t": { state: "20" }, "binary_sensor.o": { state: "on" }, "climate.office": { state: "heat", attributes: { temperature: 20, ...STEP1 } } };
  const { b, ha } = liveBrain(st);
  let t = MON + 18 * HOUR;
  b.actuator.obs.set("office#0", { on: true, mode: "heat", changedAt: t - HOUR });
  b.actuator.commanded.set("climate.office", { mode: "heat", setpoint: 20, at: t - HOUR, step: 1 });
  await b.cycle(t, 80);
  st["climate.office"] = { state: "heat", attributes: { temperature: 24, ...STEP1 }, context: { id: "x", user_id: "peter" } };
  t += 5000; await b.cycle(t, 80);
  assert.strictEqual(b.decisions.get("office").state, "manual");
  b._run = new Set(); t += 5000; await b.cycle(t, 35);
  assert.ok(b.decisions.get("office").overruled && !b.overrides.office, "overruled: dropped");
  const sent = ha.calls.at(-1)[3].temperature;
  st["climate.office"] = { state: "heat", attributes: { temperature: sent, ...STEP1 }, context: { id: "y", user_id: "brain" } };
  for (let k = 0; k < 20; k++) { t += 60000; await b.cycle(t, 80); }
  const d = b.decisions.get("office");
  assert.notStrictEqual(d.state, "manual", "not 'respected' while the unit sits elsewhere");
  assert.ok(d.setpoint > 20, `comfort leans toward the person's 24 now: ${d.setpoint}`);
  assert.strictEqual(ha.calls.at(-1)[3].temperature, fitSetpoint(d.setpoint, { step: 1 }), "and the unit is told (on its step)");
});

t("[RR4] actuator: a new want isn't stuck behind an old backoff; failed calls retry each minute; protection at least every 5 min", async () => {
  const ha = fakeHa({}), act = new ClimateActuator({ ha });
  const z = ac({ min_on_s: 0, min_off_s: 0 });
  const ignoring = reading({ on: true, mode: "heat", setpoint: 25 });
  let t = MON;
  for (let k = 0; k < 6; k++) { await act.apply([z], dec("heat", 20), ignoring, { dryRun: false, now: t }); t += 40 * MIN; }
  const n = ha.calls.length;
  await act.apply([z], dec("heat", 17), ignoring, { dryRun: false, now: t + 5000 });
  assert.strictEqual(ha.calls.length, n + 1, "a different want is sent at once");
  const pha = fakeHa({}), pact = new ClimateActuator({ ha: pha });
  let pt = MON;
  for (let k = 0; k < 12 * 60; k++) { await pact.apply([z], dec("heat", 10, { level: "protect" }), ignoring, { dryRun: false, now: pt }); pt += 5000; }
  assert.ok(pha.calls.length >= 12, `protection resent at least every 5 min over an hour: ${pha.calls.length}`);
  let down = true;
  const calls = [];
  const fail = new ClimateActuator({ ha: { callService: async (...a) => { if (down) throw new Error("socket not open"); calls.push(a); return {}; } } });
  let ft = MON;
  for (let k = 0; k < 12 * 20; k++) { await fail.apply([z], dec("heat", 21), reading({}), { dryRun: false, now: ft }); ft += 5000; }
  down = false;
  let waited = 0;
  for (let k = 0; k < 720 && !calls.length; k++) { ft += 5000; waited += 5; await fail.apply([z], dec("heat", 21), reading({}), { dryRun: false, now: ft }); }
  assert.ok(waited <= 60, `after a 20 min outage the command lands within a minute: ${waited} s`);
});

t("[RR5] ha: no state_reported subscription; last_reported refreshed from get_states", async () => {
  const ha = new HAClient({ token: "x" });
  const sent = [];
  const old = new Date(Date.now() - 4 * HOUR).toISOString(), fresh = new Date(Date.now() - 60000).toISOString();
  let reported = old;
  ha.send = async (m) => { sent.push(m); if (m.type === "get_states") return [{ entity_id: "sensor.t", state: "20", attributes: {}, last_updated: old, last_reported: reported }]; return {}; };
  ha.track(["sensor.t"]);
  await ha._afterAuth();
  clearInterval(ha.refreshTimer);
  assert.ok(!sent.some((m) => m.event_type === "state_reported"), "HA needs a filter for state_reported: not subscribed");
  assert.ok(ha.entity("sensor.t").ageSec > 3.9 * 3600);
  reported = fresh;
  await ha.refreshReported();
  assert.ok(ha.entity("sensor.t").ageSec < 120, "a steady sensor's report time is refreshed");
  ha.send = async () => { throw new Error("socket not open"); };
  await ha.refreshReported();   // logged, not thrown
});

t("[RR6] brain: a bare context (time-triggered automation, or the unit's buttons) teaches weakly and never holds", () => {
  const st = { "sensor.office_t": { state: "18" }, "binary_sensor.o": { state: "on" }, "climate.office": { state: "heat", attributes: { temperature: 20, target_temp_step: 1 } } };
  const { b } = liveBrain(st);
  const t0 = MON + 18 * HOUR;
  b.actuator.commanded.set("climate.office", { mode: "heat", setpoint: 20, at: t0 - HOUR, step: 1 });
  b.tick(t0, { tout: 8, soc: 80 });
  st["climate.office"] = { state: "heat", attributes: { temperature: 16, target_temp_step: 1 }, context: { id: "auto1", parent_id: null, user_id: null } };
  b.tick(t0 + 5000, { tout: 8, soc: 80 });
  assert.ok(!b.overrides.office, "no override hold");
  const p = b.prefs.preferred("office", t0, "heat", 20);
  assert.strictEqual(p.learned, 16);
  assert.ok(p.confidence < 0.25, `weakly: ${p.confidence}`);
  assert.strictEqual(b.classify({ mode: "heat", setpoint: 16 }, { id: "a", parent_id: "p" }, null), "automation");
  assert.strictEqual(b.classify({ mode: "heat", setpoint: 16 }, null, null), "unknown");
  assert.strictEqual(b.classify({ mode: "heat", setpoint: 20 }, { id: "u", user_id: "peter" }, { mode: "heat", setpoint: 20 }), "human", "a person setting what the brain had is still a person");
});

t("[RR7] projection: the load profile keeps older minutes for hours newer ones don't cover yet", () => {
  const h = (hh, mm = 0) => at(`2026-11-02T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`);
  const samples = [{ t: h(9), loadKw: 2 }, { t: h(10), loadKw: 3 }, { t: h(10, 30), loadKw: 1.5, climKw: 1 }];
  const prof = loadProfile(samples, 0, { lessClimate: true });
  assert.strictEqual(prof(h(9, 15)), 2, "09:00 not yet covered: the old minute stands");
  assert.strictEqual(prof(h(10, 15)), 0.5, "10:00 covered: only the new minute, less its climate");
});

t("[RR8] plan/ladder: turned off by hand keeps protection; a warm room stays off, a freezing one heats", () => {
  const off = { mode: "off", setpoint: NaN, until: MON + 20 * HOUR };
  const warm = basePlan({ temp: 18, override: off });
  assert.ok(warm.levels.protect.active && !warm.levels.comfort.active && !warm.levels.setback.active);
  const w = walk(POLICY, new Map([["office", warm]]), { ...CTX, soc: 80 }).d;
  assert.deepStrictEqual([w.state, w.mode], ["manual", "manual"]);
  const cold = basePlan({ temp: 5, tout: 0, override: off });
  const c = walk(POLICY, new Map([["office", cold]]), { ...CTX, soc: 80 }).d;
  assert.deepStrictEqual([c.state, c.mode, c.setpoint, c.level], ["running", "heat", 10, "protect"]);
  assert.ok(c.protecting && !c.overruled, "protection, but the person's off stands afterwards");
});

t("[RR fuzz] decide: plain policies decide byte-identically to the pre-climate engine (795c427)", () => {
  const Old = require("./fixtures/dispatch-pre-climate.js").decide;
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const conds = ["1", "soc > 50", "surplus > 0.5", "occ", "hour >= 8 && hour < 18", "0.5", "pv > 2", "autonomy > 1"];
  for (let k = 0; k < 3000; k++) {
    const devices = Array.from({ length: 5 }, (_, i) => ({ id: "d" + i, kw: Math.round(rnd() * 30) / 10, important: rnd() > 0.3 }));
    const list = []; let rung = 0;
    for (let i = 0; i < 10; i++) {
      if (rnd() < 0.25) { rung = Math.min(100, rung + Math.round(rnd() * 5) * 10); list.push({ type: "charge", to: rung || 20 }); }
      else { const e = { type: "load", dev: pick(devices).id, cond: pick(conds) }; if (rnd() < 0.2) e.gen = true; if (rnd() < 0.2) e.sp = 2; if (rnd() < 0.1) e.important = rnd() > 0.5; list.push(e); }
    }
    const soc = Math.round(rnd() * 1000) / 10;
    const ctx = { ...CTX, hour: Math.floor(rnd() * 24), occ: rnd() > 0.5 ? 1 : 0, sun: 1, dark: 0, soc, pv: Math.round(rnd() * 80) / 10, autonomy: rnd() * 3 };
    const limits = { ...LIMITS, hysteresis_pct: pick([0, 2, 5]) };
    const running = new Set(devices.filter(() => rnd() > 0.5).map((d) => d.id));
    const hist = rnd() > 0.5 ? Array.from({ length: 30 }, (_, i) => [MON - (30 - i) * 60000, soc]) : [];
    const a = decide({ devices, list }, ctx, limits, running, hist);
    assert.deepStrictEqual(a.grantedKeys, [], "no keys without hkey entries");
    delete a.grantedKeys;
    assert.strictEqual(JSON.stringify(a), JSON.stringify(Old({ devices, list }, ctx, limits, running, hist)), `policy ${k} differs`);
  }
});

// ======================================================================= reset (0.34.1)

function learnedBrain(ha = fakeHa({ "sensor.office_t": { state: "19" }, "sensor.den_t": { state: "19" } })) {
  const b = new ClimateBrain({ ha });
  const mk = (id) => ({ id, name: id, temp_entities: [`sensor.${id}_t`], presence_entities: [`binary_sensor.${id}_o`],
    outputs: [{ kind: "ac", entity: `climate.${id}`, kw: 1.5, power_entity: `sensor.${id}_p` }] });
  b.configure({ enabled: true, zones: [mk("office"), mk("den")] });
  for (const id of ["office", "den"]) {
    b.prefs.observe(id, MON + 19 * HOUR, "heat", 22);
    for (let w = 1; w <= 3; w++) b.occ.addHour(id, MON - w * 7 * DAY + 19 * HOUR, 1);
    for (const x of simulateRoom({ days: 2 })) b.models.get(id).update(x);
    for (let k = 0; k < 30; k++) b.curves.observe(`climate.${id}`, "heat", 10, 0.9, MON + k * MIN);
    b.baselines[`sensor.${id}_p`] = 0.1;
    b.seeded[id] = true;
    b.since[id] = { prefs: MON, occ: MON, model: MON, curves: MON };   // learning began on MON (the clock is real)
  }
  b.actuator.commanded.set("climate.office", { mode: "heat", setpoint: 20, at: MON, step: 0.5 });
  b.actuator.obs.set("office#0", { on: true, mode: "heat", changedAt: MON });
  return b;
}
const hasPrefs = (b, id) => b.prefs.preferred(id, MON + 19 * HOUR, "heat", 20).learned != null;
const hasOcc = (b, id) => b.occ.probability(id, MON + 19 * HOUR, 0.2).p > 0.5;
const fitted = (b, id) => b.models.get(id).n.passive + b.models.get(id).n.heat > 0;
const hasCurve = (b, id) => b.curves.predict(`climate.${id}`, "heat", 10, 1.5).learned != null;

t("[reset] preferences only, one zone: everything else, and the other zone, untouched", () => {
  const b = learnedBrain();
  const r = b.reset({ zone: "office", parts: ["prefs"], now: MON + DAY });
  assert.deepStrictEqual(r, { zones: ["office"], parts: ["prefs"] });
  assert.ok(!hasPrefs(b, "office") && hasPrefs(b, "den"));
  assert.ok(hasOcc(b, "office") && fitted(b, "office") && hasCurve(b, "office"));
  assert.strictEqual(b.learningSince("office").prefs, MON + DAY);
  assert.notStrictEqual(b.learningSince("office").occ, MON + DAY);
  assert.strictEqual(b.learningSince("office").all, MON + DAY);
});

t("[reset] everything, all zones: model back to the prior; settings and hardware state kept; no auto re-seed", () => {
  const b = learnedBrain();
  b.reset({ parts: "all", now: MON + DAY });
  for (const id of ["office", "den"]) {
    assert.ok(!hasPrefs(b, id) && !hasOcc(b, id) && !fitted(b, id) && !hasCurve(b, id), id);
    assert.strictEqual(b.models.get(id).forPlanning("heat").source, "prior");
    assert.ok(b.seeded[id], "history isn't re-learned on its own");
    assert.strictEqual(b.learningSince(id).all, MON + DAY);
  }
  assert.deepStrictEqual(b.baselines, {});
  assert.strictEqual(b.zones.length, 2, "zone settings kept");
  assert.strictEqual(b.actuator.commanded.get("climate.office").setpoint, 20, "command memory kept");
  assert.ok(b.actuator.obs.has("office#0"), "dwell state kept");
  assert.throws(() => b.reset({ zone: "attic" }), /no climate zone/);
  assert.throws(() => b.reset({ parts: ["nonsense"] }), /nothing to reset/);
});

t("[reset] survives a restart: still reset, dates kept, re-seed request kept", () => {
  const b = learnedBrain();
  b.reset({ zone: "den", parts: ["occ", "model"], reseedSince: MON + 2 * DAY, now: MON + 3 * DAY });
  const b2 = new ClimateBrain({ ha: b.ha, state: JSON.parse(JSON.stringify(b.toJSON())) });
  b2.configure(b.cfg);
  assert.ok(!hasOcc(b2, "den") && !fitted(b2, "den") && hasPrefs(b2, "den") && hasCurve(b2, "den"));
  assert.ok(hasOcc(b2, "office") && fitted(b2, "office"));
  assert.strictEqual(b2.learningSince("den").occ, MON + 3 * DAY);
  assert.deepStrictEqual(b2.reseed.den, { since: MON + 2 * DAY, parts: ["occ", "model"] });
  assert.ok(!b2.seeded.den, "will re-learn from history");
});

t("[reset] re-seed from a date learns only the reset parts, from that date", async () => {
  const s = (iso, state, a) => ({ s: state, ...(a ? { a } : {}), lu: at(iso) / 1000 });
  const rows = {
    "binary_sensor.office_o": [s("2026-11-01T06:00:00", "off"), s("2026-11-01T19:00:00", "on"), s("2026-11-01T22:00:00", "off"),
      s("2026-11-09T06:00:00", "off"), s("2026-11-09T07:00:00", "on"), s("2026-11-09T09:00:00", "off")],
    "climate.office": [s("2026-11-09T06:00:00", "off", {}), s("2026-11-09T07:00:00", "heat", { temperature: 25 })],
    "sensor.office_t": [s("2026-11-01T06:00:00", "19")],
  };
  const requests = [];
  const ha = fakeHa({}, { ready: true, send: async (m) => { requests.push(m); const id = m.entity_ids[0];
    return { [id]: (rows[id] || []).filter((r) => r.lu * 1000 >= Date.parse(m.start_time) && r.lu * 1000 < Date.parse(m.end_time)) }; } });
  const b = learnedBrain(ha);
  b.reset({ zone: "office", parts: ["occ"], reseedSince: at("2026-11-09T00:00:00"), now: at("2026-11-10T00:00:00") });
  await b.seed(at("2026-11-10T00:00:00"));
  assert.ok(requests.every((m) => Date.parse(m.start_time) >= at("2026-11-09T00:00:00")), "nothing from before the date");
  assert.ok(b.occ.probability("office", at("2026-11-16T07:00:00")).p > 0.5, "occupancy re-learned since the date");
  assert.ok(!(b.occ.probability("office", at("2026-11-08T19:00:00")).p > 0.5), "the old evenings aren't");
  assert.strictEqual(b.prefs.preferred("office", at("2026-11-16T07:00:00"), "heat", 20).learned, null, "preferences weren't reset, so not re-learned");
  assert.ok(b.seeded.office && !b.reseed.office);
});

t("[reset] web API needs confirmation; MQTT buttons reset all zones or one", async () => {
  const { startServer } = require("../web/server.js");
  const calls = [];
  const server = startServer({ port: 0, allowAny: true, getState: () => ({}), getPolicy: () => ({}), check: () => [], preview: () => null, apply: () => {},
    getSettings: () => ({}), checkSettings: () => [], applySettings: () => {}, listEntities: async () => [],
    resetClimate: (b) => { calls.push(b); if (b.zone === "attic") throw new Error('no climate zone "attic"'); return { zones: ["office"], parts: ["prefs"] }; } });
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/api/climate/reset`;
  const post = (body) => fetch(url, { method: "POST", body: JSON.stringify(body) });
  assert.strictEqual((await post({ zone: "office" })).status, 409, "no confirmation");
  assert.strictEqual(calls.length, 0);
  const ok = await post({ zone: "office", parts: ["prefs"], confirm: "RESET" });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual((await ok.json()).zones, ["office"]);
  assert.strictEqual((await post({ zone: "attic", confirm: "RESET" })).status, 422);
  server.close();

  const sent = [];
  const sink = new MqttSink({ enabled: true });
  sink.client = { connected: true, publish: (topic, payload) => sent.push([topic, payload]) };
  sink.publishClimate({ enabled: true, zones: [{ id: "office", name: "Office", area: "Office", plan: {}, decision: {}, flags: [], learningSince: { all: MON } }] });
  const all = JSON.parse(sent.find(([tp]) => tp === "homeassistant/button/offgrid_brain/climate_reset_learning/config")[1]);
  assert.deepStrictEqual([all.name, all.entity_category, all.command_topic, all.device.identifiers[0]], ["Reset climate learning", "config", "offgrid_brain/cmd/climate_reset_learning", "offgrid_brain"]);
  assert.ok(!("state_topic" in all));
  const one = JSON.parse(sent.find(([tp]) => tp === "homeassistant/button/offgrid_brain/climate_office_reset_learning/config")[1]);
  assert.strictEqual(one.device.identifiers[0], "offgrid_brain_climate_office");
  const since = sent.find(([tp]) => tp === "offgrid_brain/climate_office_learning_since");
  assert.strictEqual(since[1], new Date(MON).toISOString());
  assert.strictEqual(JSON.parse(sent.find(([tp]) => tp === "homeassistant/sensor/offgrid_brain/climate_office_learning_since/config")[1]).device_class, "timestamp");
});

// ======================================================================= runner
(async () => {
  console.log("climate:");
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n       ${String(e.stack).split("\n").slice(0, 3).join("\n       ")}`); process.exitCode = 1; }
  }
  console.log(`\n${pass} passed`);
})();
