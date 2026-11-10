/* Tests for the hourly forecast-vs-actual log. Run: node test/hourlog.test.js */
"use strict";
process.env.TZ = "Australia/Sydney";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { HourLog } = require("../policy/hourlog.js");
const { parseOutdoorTemp } = require("../sources/ecowitt.js");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };
const H = 3600000, MIN = 60000;
const T0 = Date.parse("2026-11-10T02:00:00Z");   // 13:00 local
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "hourlog-"));

t("forecast vintages: the latest value at 24 h, 6 h and 0 h ahead", () => {
  const l = new HourLog();
  const target = T0 + 30 * H;
  l.noteForecast(target - 30 * H, [{ t: target, kwh: 5 }]);
  l.noteForecast(target - 25 * H, [{ t: target, kwh: 6 }]);   // still >= 24 h: day-ahead becomes 6
  l.noteForecast(target - 10 * H, [{ t: target, kwh: 7 }]);   // >= 6 h
  l.noteForecast(target - 2 * H, [{ t: target, kwh: 8 }]);    // only "last"
  l.noteForecast(target + 10 * MIN, [{ t: target, kwh: 9 }]); // the hour has begun: ignored
  assert.deepStrictEqual(l.vintages[target].forecast, { d1: 6, h6: 7, last: 8 });
});

t("projection vintages: battery % for the end of each hour", () => {
  const l = new HourLog();
  const steps = [{ t: T0 + 30 * MIN, soc: 50 }, { t: T0 + H, soc: 60 }, { t: T0 + 7 * H, soc: 70 }, { t: T0 + 24 * H, soc: 80 }];
  l.noteProjection(T0, steps);
  assert.deepStrictEqual(l.vintages[T0].proj_soc, {});                 // lead 0: no vintage
  assert.deepStrictEqual(l.vintages[T0 + 6 * H].proj_soc, { h6: 70 });
  assert.deepStrictEqual(l.vintages[T0 + 23 * H].proj_soc, { d1: 80, h6: 80 });
});

t("each ended hour becomes one row of actuals beside its vintages, written to the year's file", () => {
  const d = dir(), l = new HourLog({ dir: d });
  l.closeHours(T0 + 5 * MIN, []);   // starts with the hour now running
  l.noteForecast(T0 - 7 * H, [{ t: T0, kwh: 4.2 }]);
  const ss = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * MIN, soc: 90 + i / 10, loadKw: 0.6, pvKw: 2, availKw: i < 30 ? 2 : 3, battKw: 1.4, irr: 800, tout: 25, dcV: i < 3 ? 20 : 350 }));
  const rows = l.closeHours(T0 + H + 2 * MIN, ss);
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.local, "2026-11-10 13:00");
  assert.deepStrictEqual(r.forecast, { h6: 4.2, last: 4.2 });
  assert.deepStrictEqual([r.pv_kwh, r.load_kwh, r.battery_in_kwh, r.battery_out_kwh, r.available_kwh], [2, 0.6, 1.4, 0, 2.5]);
  assert.deepStrictEqual([r.irradiance_wm2, r.outdoor_c, r.soc_end, r.throttled_min, r.samples], [800, 25, 95.9, 30, 60]);
  assert.deepStrictEqual([r.dc_volts_max, r.dc_light_min], [350, 3]);
  assert.strictEqual(l.vintages[T0], undefined, "written vintages are dropped");
  const back = l.read(1, T0 + H + 2 * MIN);
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].pv_kwh, 2);
});

t("hours with no samples still get a row; a long outage only back-fills two days", () => {
  const l = new HourLog({ state: { vintages: {}, lastClosed: T0 - 100 * H } });
  const rows = l.closeHours(T0 + 10 * MIN, []);
  assert.strictEqual(rows.length, 47);   // the 47 complete hours before the one now running
  assert.strictEqual(rows[0].samples, 0);
  assert.strictEqual(rows[0].pv_kwh, null);
});

t("Ecowitt outdoor temperature, in °C or converted from °F", () => {
  assert.strictEqual(parseOutdoorTemp({ common_list: [{ id: "0x02", val: "27.1", unit: "C" }] }), 27.1);
  assert.ok(Math.abs(parseOutdoorTemp({ common_list: [{ id: "0x02", val: "77", unit: "F" }] }) - 25) < 1e-9);
  assert.ok(Number.isNaN(parseOutdoorTemp({ common_list: [] })));
});

console.log(`\n${pass} passed`);
