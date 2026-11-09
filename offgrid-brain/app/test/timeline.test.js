/* Tests for the Live timeline: recorder and projection. Run: node test/timeline.test.js */
"use strict";
process.env.TZ = "Australia/Sydney";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Recorder, project, loadProfile, forecastAt, learnOverhead } = require("../policy/timeline.js");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };
const MIN = 60000, HOUR = 60 * MIN;
const T0 = Date.parse("2026-11-10T00:00:00Z");   // 11:00 local

t("recorder averages a minute's ticks and keeps the latest run/shed", () => {
  const r = new Recorder();
  r.add(T0 + 1000, { soc: 50, loadKw: 1, run: ["a"], shed: [] });
  r.add(T0 + 31000, { soc: 51, loadKw: NaN, run: ["a", "b"], shed: ["c"] });
  r.add(T0 + MIN + 1000, { soc: 52, loadKw: 3 });
  const all = r.all();
  assert.strictEqual(all.length, 2);
  assert.deepStrictEqual([all[0].soc, all[0].loadKw, all[0].run, all[0].shed], [50.5, 1, ["a", "b"], ["c"]]);
  assert.strictEqual(all[0].pvKw, null);
  assert.strictEqual(all[1].soc, 52);
});

t("recorder drops samples older than it keeps, and round-trips through a file", () => {
  const r = new Recorder({ keepHours: 1 });
  for (let m = 0; m < 90; m++) r.add(T0 + m * MIN, { soc: m });
  const all = r.all();
  assert.ok(all[0].t >= T0 + 28 * MIN && all.length <= 62, `${all.length} samples from ${(all[0].t - T0) / MIN}`);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tl-")), "timeline.json");
  r.save(f);
  assert.strictEqual(Recorder.load(f).all().length, all.length);
  assert.strictEqual(Recorder.load(f + ".missing").all().length, 0);
});

t("load profile is by hour of day, with fallbacks", () => {
  const p = loadProfile([{ t: T0, loadKw: 2 }, { t: T0 + 10 * MIN, loadKw: 4 }, { t: T0 + 2 * HOUR, loadKw: 1 }], 9);
  assert.strictEqual(p(T0 + 24 * HOUR + 5 * MIN), 3);
  assert.strictEqual(p(T0 + 5 * HOUR), 7 / 3);
  assert.strictEqual(loadProfile([], 0.5)(T0), 0.5);
});

t("forecast lookup: the hour's kWh, zero inside the series, NaN past it", () => {
  const f = forecastAt([{ t: T0, kwh: 6 }, { t: T0 + 2 * HOUR, kwh: 2 }]);
  assert.strictEqual(f(T0 + 30 * MIN), 6);
  assert.strictEqual(f(T0 + HOUR), 0);
  assert.ok(Number.isNaN(f(T0 + 5 * HOUR)));
});

const policy = {
  devices: [{ id: "base", kw: 0.5 }, { id: "ev", kw: 7 }],
  list: [{ type: "load", dev: "base", cond: "1", gen: true }, { type: "charge", to: 40 }, { type: "load", dev: "ev", cond: "1" }],
};
const battery = { capacity_kwh: 50, reserve_pct: 10, max_charge_kw: 5, inverter_kw: 7.5 };
const limits = { ...battery, tick_hours: 5 / 3600 };
const ctx = { hour: 11, soc: 50, pv: 0, surplus: 0, tout: 20, forecast: 1, used: 0, gap: 0, autonomy: 1 };

t("projection: sun charges up to the charger limit, night discharges", () => {
  const fc = [{ t: T0, kwh: 8 }, { t: T0 + HOUR, kwh: 8 }];
  const steps = project({ now: T0, soc: 50, ctx, policy, limits, battery, forecast: fc, load: () => 1, hours: 4, stepMin: 60 });
  assert.strictEqual(steps.length, 5);
  assert.deepStrictEqual(steps.map((s) => s.battKw), [5, 5, -1, -1, -1]);
  assert.deepStrictEqual(steps.map((s) => s.soc), [50, 60, 70, 68, 66]);
  assert.strictEqual(steps[0].pvKw, 6);
  assert.strictEqual(steps[0].availKw, 8);
  assert.deepStrictEqual(steps.map((s) => s.forecast), [true, true, false, false, false]);
});

t("projection: the dispatch walk sheds below a floor; the reserve holds and flags a deficit", () => {
  const steps = project({ now: T0, soc: 12, ctx, policy, limits, battery, forecast: [{ t: T0, kwh: 0 }], load: () => 6, hours: 2, stepMin: 60 });
  assert.deepStrictEqual(steps[0].shed, ["ev"]);
  assert.deepStrictEqual(steps[0].run, ["base"]);
  assert.strictEqual(steps[0].floorPct, 40);
  assert.strictEqual(steps[1].soc, 10);
  assert.ok(steps[1].deficit && !steps[0].deficit);
  assert.strictEqual(steps[2].forecast, false);
});

t("projection: a full battery takes no charge, so solar only meets the load", () => {
  const steps = project({ now: T0, soc: 100, ctx, policy, limits, battery, forecast: [{ t: T0, kwh: 9 }], load: () => 0.2, hours: 0, stepMin: 60 });
  assert.deepStrictEqual([steps[0].pvKw, steps[0].battKw, steps[0].soc], [0.2, 0, 100]);
});

t("overhead: median of discharge minus load, at night only, once there's enough", () => {
  const night = (k) => ({ t: T0 + k * MIN, battKw: -0.112 - (k === 3 ? 2 : 0), loadKw: 0.071, pvKw: 0 });
  const xs = Array.from({ length: 12 }, (_, k) => night(k));
  xs.push({ t: T0, battKw: -0.5, loadKw: 0.1, pvKw: 3 });       // sunny: ignored
  xs.push({ t: T0, battKw: 2, loadKw: 0.1, pvKw: 0 });          // charging: ignored
  assert.ok(Math.abs(learnOverhead(xs) - 0.041) < 1e-9, String(learnOverhead(xs)));
  assert.strictEqual(learnOverhead(xs.slice(0, 5)), 0, "too few minutes");
});

t("projection: the overhead drains the battery at night and is met from solar by day", () => {
  const steps = project({ now: T0, soc: 50, ctx, policy, limits, battery, forecast: [{ t: T0, kwh: 0.5 }, { t: T0 + HOUR, kwh: 0 }],
    load: () => 0.4, overheadKw: 0.1, hours: 1, stepMin: 60 });
  assert.deepStrictEqual(steps.map((s) => [s.pvKw, s.battKw]), [[0.5, 0], [0, -0.5]]);
});

console.log(`\n${pass} passed`);
