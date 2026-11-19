/* Tests for the climate brain: learning, the thermal model, planning, the ladder,
   actuation and outputs. Run: node test/climate.test.js */
"use strict";
process.env.TZ = "Australia/Sydney";
const assert = require("assert");
const { Preferences, Occupancy } = require("../climate/learn.js");
const { ThermalModel } = require("../climate/thermal.js");
const { ConsumptionCurves, attribute } = require("../climate/consumption.js");
const Zones = require("../climate/zones.js");
const { planZone } = require("../climate/plan.js");
const Ladder = require("../climate/ladder.js");
const { ClimateActuator } = require("../climate/actuate.js");
const { ClimateBrain } = require("../climate/index.js");
const { parseHistory, replay } = require("../climate/seed.js");
const { decide } = require("../policy/dispatch.js");
const { project } = require("../policy/timeline.js");
const { check: checkPolicy } = require("../config.js");
const Settings = require("../settings.js");
const { MqttSink } = require("../sinks/mqtt.js");
require("../log.js").setLevel("error");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.stack.split("\n").slice(0, 3).join("\n       ")}`); process.exitCode = 1; } };
const ta = async (name, fn) => { try { await fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.stack.split("\n").slice(0, 3).join("\n       ")}`); process.exitCode = 1; } };
const near = (a, b, tol, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} not within ${tol} of ${b}`);
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const at = (iso) => new Date(iso).getTime();     // local time (TZ above)
const MON = at("2026-11-02T00:00:00");           // a Monday, local midnight

const CFG = Zones.normalise({ enabled: true });
const zone = (over = {}) => Zones.normaliseZone({ id: "office", name: "Office", area: "Office", temp_entities: ["sensor.office_t"], ...over });
const LIMITS = { inverter_kw: 7.5, max_charge_kw: 7.5, reserve_pct: 10, capacity_kwh: 51.8, tick_hours: 5 / 3600 };
const CTX = { hour: 18, dow: 1, weekend: 0, month: 6, season: 1, occ: 1, dark: 1, sun: 0, soc: 50, pv: 0, surplus: 0,
              tout: 8, forecast: 1, used: 0, gap: 0, autonomy: 2, storm: 0, storm_ahead: 0, lightning: 999 };

console.log("climate: learning");

t("preferences: synthetic manual adjustments become setpoints by day type and hour", () => {
  const p = new Preferences();
  for (let d = 0; d < 28; d++) {
    const day = MON + d * DAY, dow = d % 7;
    if (dow < 5) p.observe("office", day + 19 * HOUR, "heat", 21.5);
    else p.observe("office", day + 9 * HOUR, "heat", 19);
    if (dow < 5) p.observe("office", day + 14 * HOUR, "cool", 24);
  }
  const now = MON + 28 * DAY;   // a Monday
  const wkEve = p.preferred("office", now + 19 * HOUR, "heat", 20);
  near(wkEve.value, 21.5, 0.2, "weekday evening");
  assert.ok(wkEve.confidence > 0.8, `confidence ${wkEve.confidence}`);
  near(p.preferred("office", now + 5 * DAY + 9 * HOUR, "heat", 20).value, 19, 0.3, "weekend morning");
  near(p.preferred("office", now + 20 * HOUR, "heat", 20).value, 21.5, 0.3, "kernel spreads to the next hour");
  const night = p.preferred("office", now + 3 * HOUR, "heat", 20);
  assert.ok(night.confidence < 0.05 && Math.abs(night.value - 20) < 0.1, "no data at 3 am: the default");
  near(p.preferred("office", now + 14 * HOUR, "cool", 25).value, 24, 0.2, "cooling learned separately");
});

t("preferences: old adjustments decay in favour of recent ones", () => {
  const p = new Preferences();
  for (let k = 0; k < 10; k++) p.observe("z", MON - 160 * DAY + k * 7 * DAY + 19 * HOUR, "heat", 18);
  for (let k = 0; k < 3; k++) p.observe("z", MON - 21 * DAY + k * 7 * DAY + 19 * HOUR, "heat", 23);
  const v = p.preferred("z", MON + 19 * HOUR, "heat", 20).learned;
  assert.ok(v > 21.5, `recent 23s should dominate, got ${v}`);
});

t("occupancy: an hour-of-week pattern from presence history, and when it starts next", () => {
  const o = new Occupancy();
  for (let d = 0; d < 28; d++) {
    const dow = d % 7;
    for (let m = 0; m < 24 * 60; m += 5) {
      const ts = MON + d * DAY + m * MIN, h = Math.floor(m / 60);
      o.observe("office", ts, dow < 5 ? h >= 17 && h < 23 : h >= 8 && h < 22);
    }
  }
  const tue = MON + 29 * DAY;
  assert.ok(o.probability("office", tue + 19 * HOUR).p > 0.85, "Tue 19:00 occupied");
  assert.ok(o.probability("office", tue + 11 * HOUR).p < 0.2, "Tue 11:00 empty");
  assert.ok(o.probability("office", MON + 33 * DAY + 11 * HOUR).p > 0.8, "Sat 11:00 occupied");
  near(o.nextOccupied("office", tue + 15 * HOUR, 240, 0.5), 120, 15, "next occupied");
  assert.strictEqual(o.nextOccupied("office", tue + 9 * HOUR, 120, 0.5), null);
});

t("occupancy: unavailable presence is unknown, not empty", () => {
  const o = new Occupancy();
  for (let m = 0; m < 7 * 24 * 60; m += 5) o.observe("z", MON + m * MIN, null);
  assert.strictEqual(o.probability("z", MON + 8 * DAY, 0.6).p, 0.6, "nothing learned from unknowns");
  const st = (state) => ({ state, attributes: {}, ageSec: 1 });
  assert.strictEqual(Zones.anyPresent([st("on"), st("unavailable")]), true);
  assert.strictEqual(Zones.anyPresent([st("off"), st("unavailable")]), false);
  assert.strictEqual(Zones.anyPresent([st("unavailable"), st("unknown")]), null);
  assert.strictEqual(Zones.anyPresent([st("2")]), true, "a count");
  assert.strictEqual(Zones.anyPresent([st("not_home"), st("home")]), true);
});

// A room with known physics, simulated minute by minute, sampled in 15-min windows.
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
      if (w % 40 < 8) heat = false, cool = false;          // spells of coasting
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
  assert.ok(m.confidence() < 0.05, "no confidence before data");
  for (const w of simulateRoom()) m.update(w);
  const { a, bh, g } = m.params;
  near(a, 0.08, 0.03, "a");
  near(bh, 2.0, 0.5, "bh");
  near(g, 0.1, 0.25, "g");
  assert.ok(m.confidence("heat") > 0.6, `confidence ${m.confidence("heat")}`);
  // True warm-up 17 -> 21 °C at 1 kW, 10 °C outside:
  const Tinf = 10 + (0.1 + 2.0) / 0.08, truth = -Math.log((21 - Tinf) / (17 - Tinf)) / 0.08;
  near(m.hoursToReach(17, 21, 10, 1, "heat"), truth, truth * 0.2, "hours to reach");
  assert.strictEqual(m.hoursToReach(22, 21, 10, 1, "heat"), 0, "already there");
  assert.strictEqual(m.hoursToReach(17, 40, 10, 0.1, "heat"), Infinity, "can't get there");
  assert.ok(m.coastHours(21, 18, 10) > 1, "coasts for a while");
  const kw = m.kwToReach(17, 21, 10, 1, "heat");
  near(m.hoursToReach(17, 21, 10, kw, "heat"), 1, 0.01, "kwToReach and hoursToReach agree");
  assert.ok(m.holdKw(21, 10, "heat") > 0 && m.holdKw(21, 30, "heat") === 0, "holding");
});

t("thermal model: survives a round trip and keeps an unexcited direction at its prior", () => {
  const m = new ThermalModel({ area_m2: 20 });
  const bc0 = m.params.bc;
  for (const w of simulateRoom({ days: 3 }).map((w) => ({ ...w, pc: 0 }))) m.update(w);
  near(m.params.bc, bc0, bc0 * 0.25, "bc never excited");
  const m2 = new ThermalModel({ area_m2: 20, state: JSON.parse(JSON.stringify(m.toJSON())) });
  assert.deepStrictEqual(m2.params, m.params);
  assert.strictEqual(m.update({ t0: 20, t1: 40, tout: 10, hours: 0.25 }), false, "a glitch is refused");
});

t("consumption: a synthetic metered history drives the learnt draw curve", () => {
  const c = new ConsumptionCurves();
  assert.strictEqual(c.predict("climate.hp", "heat", 10, 2).kw, 2, "no data: nameplate");
  let rnd = 7; const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 400; k++) {
    const lift = rand() * 20;
    c.observe("climate.hp", "heat", lift, 0.5 + 0.05 * lift + (rand() - 0.5) * 0.05, MON + k * MIN);
  }
  assert.ok(!c.observe("climate.hp", "heat", 5, 0.01, MON), "idle minutes don't count");
  const p = c.predict("climate.hp", "heat", 15, 2);
  near(p.learned, 1.25, 0.05, "learned");
  near(p.kw, 1.25, 0.06, "blended");
  assert.ok(p.confidence > 0.99);
  near(p.c1, 0.05, 0.01, "slope");
  assert.strictEqual(c.predict("climate.hp", "cool", 15, 2).kw, 2, "cooling not learned yet");
});

t("consumption: one meter on a shared circuit is attributed to the units that run", () => {
  const outs = [{ key: "a", power_entity: "sensor.m", kw: 2, running: true }, { key: "b", power_entity: "sensor.m", kw: 1, running: false },
                { key: "c", power_entity: "", kw: 1 }];
  let r = attribute(outs, () => 1.8);
  assert.deepStrictEqual([r.get("a"), r.get("b")], [1.8, 0]);
  assert.ok(Number.isNaN(r.get("c")), "no meter");
  r = attribute(outs.map((o) => ({ ...o, running: false })), () => 1.5);
  assert.deepStrictEqual([r.get("a"), r.get("b")], [1, 0.5], "none says: by nameplate");
  r = attribute(outs, () => NaN);
  assert.ok(Number.isNaN(r.get("a")), "no reading");
});

console.log("climate: planning");

const model = () => new ThermalModel({ area_m2: 20 });
const basePlan = (over = {}) => planZone({
  zone: zone(), cfg: CFG, cap: { heat: 1.5, cool: 1.5 }, model: model(), now: MON,
  temp: 19, humidity: NaN, tout: 8, toutLater: { min: 4, max: 14 }, comfort: { heat: 20, cool: 25, confidence: 0 },
  occupied: true, away: false, nextOccMin: null, expectOcc: true, windowOpen: false, override: null,
  outlook: {}, sun: false, soc: 60, prevSide: null, ...over,
});

t("plan: an occupied cold room heats to its comfort setpoint; levels widen toward protection", () => {
  const p = basePlan();
  assert.strictEqual(p.side, "heat");
  assert.deepStrictEqual(["protect", "setback", "comfort"].map((l) => p.levels[l].setpoint), [10, 17, 20]);
  assert.ok(p.levels.comfort.active && p.levels.comfort.kw > 0);
  assert.ok(p.levels.protect.kw <= p.levels.setback.kw && p.levels.setback.kw <= p.levels.comfort.kw, "non-decreasing");
  assert.deepStrictEqual(p.band("setback"), { low: 17, high: 28 });
  near(p.gap, 12, 0.01, "gap = |tout - comfort|");
});

t("plan: a window open turns the zone off", () => {
  const p = basePlan({ windowOpen: true });
  assert.strictEqual(p.blocked, "window");
  assert.ok(Object.values(p.levels).every((l) => !l.active));
});

t("plan: with no room temperature, nothing is offered", () => {
  const p = basePlan({ temp: NaN, noReading: true });
  assert.strictEqual(p.blocked, "no-reading");
  assert.ok(Object.values(p.levels).every((l) => !l.active));
});

t("plan: unoccupied widens the band; away widens it further", () => {
  const p = basePlan({ occupied: false });
  assert.ok(!p.levels.comfort.active && p.levels.setback.active);
  assert.strictEqual(p.levels.setback.setpoint, 17);
  assert.strictEqual(basePlan({ occupied: false, away: true }).levels.setback.setpoint, 14);
});

t("plan: pre-heats before predicted occupancy, not hours ahead", () => {
  const p = basePlan({ occupied: false, temp: 17, nextOccMin: 30 });
  assert.ok(p.leadMin >= 30, `lead ${p.leadMin}`);
  assert.ok(p.levels.precondition.active, "within the lead");
  assert.ok(p.levels.precondition.kw > 0 && p.levels.precondition.setpoint === 20);
  assert.ok(!basePlan({ occupied: false, temp: 17, nextOccMin: 115 }).levels.precondition.active || basePlan({ occupied: false, temp: 17, nextOccMin: 115 }).leadMin >= 115);
  assert.ok(!basePlan({ occupied: false, temp: 17, nextOccMin: 30, away: true }).levels.precondition.active, "not when away");
});

t("plan: solar surplus pre-cools into the band before a hot afternoon", () => {
  const p = basePlan({ temp: 23, tout: 24, toutLater: { min: 20, max: 34 }, sun: true, outlook: { fullSoon: true } });
  assert.strictEqual(p.soakSide, "cool");
  const s = p.levels.soak;
  assert.ok(s.active, s.why);
  assert.strictEqual(s.setpoint, 22, "toward the far edge, soak_c below the cool setpoint");
  assert.ok(s.kw > 0);
  assert.ok(!basePlan({ temp: 23, tout: 24, toutLater: { min: 20, max: 34 }, sun: true, outlook: {}, soc: 60 }).levels.soak.active, "no surplus forecast");
  assert.ok(!basePlan({ temp: 23, tout: 24, toutLater: { min: 20, max: 34 }, sun: false, outlook: { fullSoon: true } }).levels.soak.active, "not at night");
});

t("plan: a muggy room lowers the cooling setpoint", () => {
  assert.strictEqual(basePlan({ humidity: 80 }).comfort.cool, 24);
});

console.log("climate: ladder");

const POLICY = {
  devices: [{ id: "network", kw: 0.05 }],
  list: [
    { type: "load", dev: "network", cond: "1", gen: true },
    { type: "charge", to: 20 }, { type: "charge", to: 40 }, { type: "charge", to: 60 }, { type: "charge", to: 100 },
  ],
};

t("ladder: zones without entries are placed by energy class", () => {
  const z = zone(), plans = new Map([["office", basePlan()]]);
  const out = Ladder.expand(POLICY, [z], plans);
  const where = (lvl) => out.list.findIndex((e) => e.climate && e.climate.level === lvl);
  const rung = (to) => out.list.findIndex((e) => e.type === "charge" && e.to === to);
  assert.ok(where("protect") > rung(20) && where("protect") < rung(40));
  assert.ok(where("setback") > rung(40) && where("setback") < rung(60));
  assert.ok(where("comfort") > rung(60) && where("comfort") < rung(100));
  assert.ok(where("soak") > rung(100));
  assert.ok(out.devices.some((d) => d.id === "climate_office" && d.climate === "office"));
  assert.strictEqual(out.list[where("protect")].important, true);
  assert.strictEqual(out.list[where("comfort")].important, false);
});

t("ladder: deficit coasts — comfort shed, the free setback band kept, band widened, unit off", () => {
  const plans = new Map([["office", basePlan()]]);
  const walked = Ladder.expand(POLICY, [zone()], plans);
  const r = decide(walked, { ...CTX, soc: 35 }, LIMITS);
  const d = Ladder.resolve([zone()], plans, r).get("office");
  assert.strictEqual(d.level, "setback", "holding 17 °C costs nothing yet, so it's kept");
  assert.strictEqual(d.setpoint, 17);
  assert.strictEqual(d.state, "coast", d.reason);
  assert.ok(/coasting at 19 °C, holds ≥ 17 °C for ~/.test(d.reason), d.reason);
  assert.strictEqual(d.mode, "off");
  assert.ok(d.refused.includes("comfort") && /band widened/.test(d.reason), d.reason);
});

t("ladder: a healthy battery grants comfort and the unit heats to the comfort setpoint", () => {
  const plans = new Map([["office", basePlan()]]);
  const r = decide(Ladder.expand(POLICY, [zone()], plans), { ...CTX, soc: 90 }, LIMITS);
  const d = Ladder.resolve([zone()], plans, r).get("office");
  assert.deepStrictEqual([d.level, d.mode, d.setpoint, d.state], ["comfort", "heat", 20, "running"]);
  assert.ok(d.kw > 0, "the device runs at the modelled kW");
});

t("ladder: at the reserve with protection needed, the zone is hard-shed", () => {
  const plans = new Map([["office", basePlan({ temp: 9 })]]);
  const r = decide(Ladder.expand(POLICY, [zone()], plans), { ...CTX, soc: 12 }, LIMITS);
  const d = Ladder.resolve([zone()], plans, r).get("office");
  assert.strictEqual(d.state, "shed", d.reason);
  assert.strictEqual(d.mode, "off");
});

t("ladder: explicit climate entries replace auto placement and AND their own condition", () => {
  const pol = { ...POLICY, list: [...POLICY.list, { type: "climate", zone: "office", level: "comfort", cond: "autonomy > 5" }] };
  assert.deepStrictEqual(checkPolicy(pol), []);
  const plans = new Map([["office", basePlan()]]);
  const walked = Ladder.expand(pol, [zone()], plans);
  assert.strictEqual(walked.list.filter((e) => e.climate).length, 1, "no auto entries");
  const r = decide(walked, { ...CTX, soc: 100, pv: 5 }, LIMITS);
  assert.strictEqual(Ladder.resolve([zone()], plans, r).get("office").state, "idle", "autonomy 2 < 5");
  assert.ok(checkPolicy({ ...POLICY, list: [{ type: "climate", zone: "office", level: "warm" }] }).length, "bad level refused");
});

t("ladder: legacy sp rules on a taken-over device keep working with modelled kW and the zone's occupancy", () => {
  const pol = { devices: [{ id: "amber", name: "Office (Amber)", kw: 5 }],
    list: [{ type: "charge", to: 20 }, { type: "load", dev: "amber", cond: "gap > 10 ? 1 : 0", sp: 4 }, { type: "load", dev: "amber", cond: "occ", sp: 0 }] };
  const z = zone({ device: "amber" });
  const away = new Map([["office", basePlan({ occupied: false })]]);
  let walked = Ladder.expand(pol, [z], away);
  assert.strictEqual(walked.devices[0].climate, "office");
  assert.strictEqual(walked.list.filter((e) => e.climate && e.auto).length, 0, "legacy entries count as explicit");
  let r = decide(walked, { ...CTX, soc: 90, occ: 1 }, LIMITS);
  const rows = r.trace.filter((x) => x.climate);
  assert.strictEqual(rows[1].outcome, "idle", "the zone's occ (0) wins over the house occ (1)");
  assert.ok(["granted", "already-served"].includes(rows[0].outcome), "gap 12 > 10: asked to run");
  assert.strictEqual(rows[0].f, 1);
  assert.ok(rows[0].demandKw < 5 && rows[0].demandKw === away.get("office").kwFor(4), "modelled kW, not the 5 kW nameplate");
  assert.strictEqual(Ladder.resolve([z], away, r).get("office").setpoint, 16, "sp 4 below 20");
  const occ = new Map([["office", basePlan()]]);
  r = decide(Ladder.expand(pol, [z], occ), { ...CTX, soc: 90 }, LIMITS);
  assert.strictEqual(Ladder.resolve([z], occ, r).get("office").setpoint, 20);
});

t("ladder: a policy with no zones is untouched", () => {
  assert.strictEqual(Ladder.expand(POLICY, [], new Map()), POLICY);
});

t("projection: climate's planned kW is added to the projected load", () => {
  const battery = { capacity_kwh: 50, reserve_pct: 10, max_charge_kw: 5, inverter_kw: 7.5 };
  const pol = { devices: [{ id: "heater", kw: 1, climate: "office" }], list: [{ type: "load", dev: "heater", cond: "1", kw: 0.8 }] };
  const steps = project({ now: MON, soc: 50, ctx: CTX, policy: pol, limits: { ...battery, tick_hours: 1 }, battery,
    forecast: [], load: () => 0.5, hours: 1, stepMin: 60, expand: () => pol });
  assert.deepStrictEqual(steps.map((s) => [s.loadKw, s.climateKw]), [[1.3, 0.8], [1.3, 0.8]]);
});

console.log("climate: brain, actuation, outputs");

function fakeHa(states) {
  const calls = [];
  return {
    calls, ready: false, states,
    entity: (id) => (states[id] ? { attributes: {}, ageSec: 5, ...states[id] } : null),
    callService: async (domain, service, entity, data) => { calls.push([domain, service, entity, data]); },
    send: async () => ({}),
  };
}
const brainWith = (states, zoneOver = {}, cfgOver = {}) => {
  const ha = fakeHa(states);
  const b = new ClimateBrain({ ha });
  b.configure({ enabled: true, zones: [{ id: "office", name: "Office", temp_entities: ["sensor.office_t"], presence_entities: ["binary_sensor.office_occupancy", "binary_sensor.office_motion"],
    outputs: [{ kind: "ac", entity: "climate.office", kw: 1.5, power_entity: "sensor.office_ac_power" }], ...zoneOver }], ...cfgOver });
  return { b, ha };
};

t("brain: a hand change to what the brain set is an override: learned strongly, then respected", () => {
  const st = { "sensor.office_t": { state: "18" }, "binary_sensor.office_occupancy": { state: "on" }, "binary_sensor.office_motion": { state: "unavailable" },
    "climate.office": { state: "heat", attributes: { temperature: 21 } }, "sensor.office_ac_power": { state: "900", attributes: { unit_of_measurement: "W" } } };
  const { b } = brainWith(st);
  b.actuator.commanded.set("climate.office", { mode: "heat", setpoint: 21, at: MON + 18 * HOUR });
  b.tick(MON + 18 * HOUR + 30000, { tout: 8, sun: false, soc: 80 });
  assert.ok(!b.overrides.office, "the brain's own setting is not an override");
  st["climate.office"] = { state: "heat", attributes: { temperature: 23 } };
  const plans = b.tick(MON + 18 * HOUR + 10 * MIN, { tout: 8, sun: false, soc: 80 });
  assert.ok(b.overrides.office && b.overrides.office.setpoint === 23);
  assert.ok(b.prefs.preferred("office", MON + 18 * HOUR, "heat", 20).learned > 22.9);
  assert.ok(plans.get("office").manual, "held at the person's setting");
  assert.strictEqual(plans.get("office").comfort.heat, 23);
  assert.strictEqual(plans.get("office").occupied, true, "one presence sensor on, the other unavailable");
});

t("brain: without the brain commanding (dry run), a change is learned but not held", () => {
  const st = { "sensor.office_t": { state: "18" }, "climate.office": { state: "cool", attributes: { temperature: 25 } } };
  const { b } = brainWith(st);
  b.tick(MON + 14 * HOUR, { tout: 30, sun: true, soc: 80 });
  st["climate.office"] = { state: "cool", attributes: { temperature: 23.5 } };
  b.tick(MON + 14 * HOUR + MIN, { tout: 30, sun: true, soc: 80 });
  assert.ok(!b.overrides.office);
  near(b.prefs.preferred("office", MON + 14 * HOUR, "cool", 25).learned, 23.5, 0.3, "learned (beside a weak sample of the 25 it was left at)");
});

t("brain: a unit that says it's heating but whose meter reads ~0 W is flagged", () => {
  const st = { "sensor.office_t": { state: "17" }, "climate.office": { state: "heat", attributes: { temperature: 21, hvac_action: "heating" } },
    "sensor.office_ac_power": { state: "3", attributes: { unit_of_measurement: "W" } } };
  const { b } = brainWith(st);
  for (let m = 0; m <= 11; m++) b.tick(MON + 18 * HOUR + m * MIN, { tout: 8, sun: false, soc: 80 });
  const f = b.flags.get("office");
  assert.strictEqual(f.length, 1, JSON.stringify(f));
  assert.ok(/~0 W/.test(f[0].problem));
  st["sensor.office_ac_power"].state = "1200";
  b.tick(MON + 18 * HOUR + 12 * MIN, { tout: 8, sun: false, soc: 80 });
  assert.strictEqual(b.flags.get("office").length, 0, "cleared once it draws");
});

t("brain: metered draw feeds the consumption curve and the zone's rating", () => {
  const st = { "sensor.office_t": { state: "18" }, "climate.office": { state: "heat", attributes: { temperature: 21, hvac_action: "heating" } },
    "sensor.office_ac_power": { state: "800", attributes: { unit_of_measurement: "W" } } };
  const { b } = brainWith(st);
  for (let m = 0; m < 120; m++) b.tick(MON + 18 * HOUR + m * MIN, { tout: 8, sun: false, soc: 80 });
  const pred = b.curves.predict("climate.office", "heat", 12, 1.5);
  near(pred.learned, 0.8, 0.001, "learned draw");
  assert.ok(pred.kw < 1.0, "the rating leans to the measured 0.8 kW");
  assert.ok(b.plans.get("office").cap.heat < 1.0, "heating rated at what it draws");
  near(b.measuredKw(), 0.8, 1e-9, "recorded climate draw");
});

t("brain: an energy counter stands in for a missing power meter", () => {
  const st = { "sensor.office_t": { state: "18" }, "climate.office": { state: "heat", attributes: { temperature: 21, hvac_action: "heating" } },
    "sensor.office_ac_energy": { state: "10.00", attributes: { unit_of_measurement: "kWh" } } };
  const { b } = brainWith(st, { outputs: [{ kind: "ac", entity: "climate.office", kw: 1.5, energy_entity: "sensor.office_ac_energy" }] });
  b.tick(MON, { tout: 8 });
  st["sensor.office_ac_energy"].state = "10.10";
  b.tick(MON + 6 * MIN, { tout: 8 });
  near(b.readings.get("office").heatKw, 1.0, 1e-6, "0.1 kWh in 6 min");
});

t("brain: projection expansion plans steady-state holding power from the forecast", () => {
  const { b } = brainWith({ "sensor.office_t": { state: "20" } });
  b.tick(Date.now(), { tout: 5 });
  b.toutForecast = [{ t: Math.floor(Date.now() / HOUR) * HOUR + 5 * HOUR, temp: 0 }];
  const pol = b.expandAt(POLICY, Math.floor(Date.now() / HOUR) * HOUR + 5 * HOUR + 10 * MIN, { ...CTX, tout: 5 });
  assert.ok(pol.list.some((e) => e.climate && e.climate.level === "protect"));
  const set = pol.list.find((e) => e.climate && e.climate.level === "setback");
  assert.ok(set.kw > 0, "holding a setback at 0 °C outside costs something");
});

t("brain: the low-case outlook flags surplus coming and climate shed later", () => {
  const { b } = brainWith({});
  b.setOutlook([{ t: MON + HOUR, soc: 80, socLow: 99, shed: [] }, { t: MON + 5 * HOUR, soc: 30, socLow: 20, shed: ["climate_office"] }], MON);
  assert.deepStrictEqual(b.outlookFor(b.zones[0]), { fullSoon: true, tight: true, shedSoon: true });
});

const ta2 = async () => {
  await ta("brain: end to end in dry run — plan, ladder, decision, advice, no calls", async () => {
    const st = { "sensor.office_t": { state: "17.5" }, "binary_sensor.office_occupancy": { state: "on" },
      "climate.office": { state: "off", attributes: {} } };
    const { b, ha } = brainWith(st);
    b.tick(MON + 18 * HOUR, { tout: 6, sun: false, soc: 85 });
    const walked = b.expand(POLICY);
    const r = decide(walked, { ...CTX, soc: 85 }, LIMITS);
    const d = b.resolve(r).get("office");
    assert.deepStrictEqual([d.mode, d.level, d.setpoint], ["heat", "comfort", 20]);
    const adv = await b.apply({ dryRun: true, now: MON + 18 * HOUR });
    assert.strictEqual(ha.calls.length, 0);
    assert.deepStrictEqual(adv.map((a) => [a.action, a.detail]), [["dry_run", "heat 20 °C"]]);
    assert.ok(b.owns("climate_office") && !b.owns("network"));
    const snap = b.snapshot();
    assert.strictEqual(snap.zones[0].decision.level, "comfort");
    assert.deepStrictEqual(snap.zones[0].band, { low: 20, high: 25 });
    assert.strictEqual(snap.zones[0].outputs[0].advice, "would set heat 20 °C");
    JSON.stringify(b.toJSON());
  });

  await ta("actuator: minimum run time holds a compressor on; dry run never calls Home Assistant", async () => {
    const z = zone({ outputs: [{ kind: "ac", entity: "climate.office", kw: 1.5, min_on_s: 300 }] });
    const ha = fakeHa({}), act = new ClimateActuator({ ha });
    const read = new Map([["office", { temp: 18, outputs: [{ on: false, mode: "off", setpoint: NaN }] }]]);
    const dec = (mode, setpoint) => new Map([["office", { mode, setpoint, reason: "test" }]]);
    await act.apply([z], dec("heat", 20.2), read, { dryRun: false, now: MON });
    assert.deepStrictEqual(ha.calls[0], ["climate", "set_temperature", "climate.office", { temperature: 20, hvac_mode: "heat" }]);
    const held = await act.apply([z], dec("off", null), read, { dryRun: false, now: MON + 60000 });
    assert.strictEqual(ha.calls.length, 1, "held on");
    assert.strictEqual(held[0].action, "held");
    await act.apply([z], dec("off", null), read, { dryRun: false, now: MON + 301000 });
    assert.deepStrictEqual(ha.calls[1], ["climate", "set_hvac_mode", "climate.office", { hvac_mode: "off" }]);
    assert.strictEqual(act.commanded.get("climate.office").mode, "off");

    const ha2 = fakeHa({}), dry = new ClimateActuator({ ha: ha2 });
    const adv = await dry.apply([z], dec("cool", 24), read, { dryRun: true, now: MON });
    assert.strictEqual(ha2.calls.length, 0);
    assert.strictEqual(adv[0].action, "dry_run");
    assert.strictEqual(dry.commanded.size, 0, "nothing commanded, so every change seen is a person's");
    await dry.apply([z], dec("manual", null), read, { dryRun: true, now: MON + 1e6 });
    assert.strictEqual(ha2.calls.length, 0);
  });

  await ta("actuator: a hydronic valve switches around the setpoint and runs its shared heat source", async () => {
    const z = zone({ outputs: [{ kind: "hydronic", entity: "switch.office_valve", kw: 0.1, min_on_s: 0, min_off_s: 0, source_entity: "climate.heat_pump" }] });
    const ha = fakeHa({}), act = new ClimateActuator({ ha });
    const r = (temp) => new Map([["office", { temp, outputs: [{ on: false }] }]]);
    const dec = new Map([["office", { mode: "heat", setpoint: 20, reason: "test" }]]);
    await act.apply([z], dec, r(19), { dryRun: false, now: MON });
    assert.deepStrictEqual(ha.calls.map((c) => c.slice(0, 3)), [["switch", "turn_on", "switch.office_valve"], ["climate", "set_hvac_mode", "climate.heat_pump"]]);
    await act.apply([z], dec, r(20.1), { dryRun: false, now: MON + 60000 });
    assert.strictEqual(ha.calls.length, 2, "hysteresis keeps it on just past the setpoint");
    await act.apply([z], dec, r(20.4), { dryRun: false, now: MON + 120000 });
    assert.deepStrictEqual(ha.calls.slice(2).map((c) => c.slice(0, 3)), [["switch", "turn_off", "switch.office_valve"], ["climate", "set_hvac_mode", "climate.heat_pump"]]);
  });
};

t("mqtt: each zone is a child device of the brain, with short entity names", () => {
  const sink = new MqttSink({ enabled: true });
  const sent = {};
  sink.client = { connected: true, publish: (topic, payload) => { sent[topic] = payload; } };
  const snap = { zones: [{ id: "office", name: "Office", area: "Office", plan: { temp: 19.5, occupied: true, occProb: 0.8, comfort: { confidence: 0.5 } },
    decision: { mode: "heat", setpoint: 20, level: "comfort", reason: "comfort: heat to 20 °C", kw: 0.6 }, band: { low: 20, high: 25 }, model: { confidence: 0.4 }, flags: [] }] };
  sink.publishClimate(snap);
  const cfg = JSON.parse(sent["homeassistant/sensor/offgrid_brain/climate_office_target/config"]);
  assert.strictEqual(cfg.name, "Target");
  assert.strictEqual(cfg.has_entity_name, true);
  assert.strictEqual(cfg.device.via_device, "offgrid_brain");
  assert.strictEqual(cfg.device.name, "Climate zone");
  assert.strictEqual(cfg.device.suggested_area, "Office");
  assert.ok(!("friendly_name" in cfg));
  assert.strictEqual(sent["offgrid_brain/climate_office_target"], "20.0");
  assert.strictEqual(sent["offgrid_brain/climate_office_mode"], "heat");
  assert.strictEqual(sent["offgrid_brain/climate_office_occupancy_forecast"], "80");
  assert.strictEqual(sent["offgrid_brain/climate_office_occupied"], "ON");
  sink.publishClimate({ zones: [] });
  assert.strictEqual(sent["homeassistant/sensor/offgrid_brain/climate_office_target/config"], "", "a removed zone is retired");
});

t("settings: climate zones are normalised and checked", () => {
  const s = Settings.normalise({ climate: { enabled: true, zones: [{ id: "office", name: "Office", temp_entities: "sensor.a, sensor.b",
    outputs: [{ kind: "ac", entity: "climate.office", kw: 1.2, power_entity: "sensor.shelly_ac" }] }] } });
  assert.deepStrictEqual(s.climate.zones[0].temp_entities, ["sensor.a", "sensor.b"]);
  assert.deepStrictEqual(s.climate.zones[0].outputs[0].modes, ["heat", "cool"]);
  assert.strictEqual(s.climate.heat_c, 20);
  assert.deepStrictEqual(Settings.check(s).filter((p) => /climate|Office/.test(p)), []);
  const bad = Settings.normalise({ climate: { enabled: true, heat_c: 24, cool_c: 24, zones: [{ id: "Bad id", name: "", outputs: [{ kind: "ac", entity: "switch.x" }] }] } });
  const probs = Settings.check(bad).join("; ");
  for (const re of [/at least 1 °C above/, /lowercase/, /needs a name/, /temperature sensor/, /must be a climate entity/]) assert.ok(re.test(probs), `${re} in ${probs}`);
  assert.strictEqual(Settings.normalise({}).climate.enabled, false, "off by default");
});

t("seed: HA history (compressed format) replays into preferences and occupancy", () => {
  const s = (iso, state, a) => ({ s: state, ...(a ? { a } : {}), lu: at(iso) / 1000 });
  const hist = parseHistory({
    "sensor.office_t": [s("2026-11-02T06:00:00", "18", { unit_of_measurement: "°C" })],
    "climate.office": [s("2026-11-02T06:00:00", "off", {}), s("2026-11-02T19:00:00", "heat", { temperature: 22 })],
    "binary_sensor.office_occupancy": [s("2026-11-02T06:00:00", "off"), s("2026-11-02T18:30:00", "on"), s("2026-11-02T22:00:00", "off")],
  });
  assert.strictEqual(hist.get("climate.office")[1].attributes.temperature, 22);
  const { b } = brainWith({});
  const n = replay(b, b.zones, hist, { start: at("2026-11-02T06:00:00"), end: at("2026-11-03T06:00:00"), toutEntity: "" });
  assert.ok(n >= 6);
  near(b.prefs.preferred("office", at("2026-11-09T19:00:00"), "heat", 20).learned, 22, 0.01, "learned 22");
  assert.ok(b.occ.probability("office", at("2026-11-09T20:00:00")).p > b.occ.probability("office", at("2026-11-09T10:00:00")).p);
});

ta2().then(() => console.log(`\n${pass} passed`));
