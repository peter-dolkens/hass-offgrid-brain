/* Tests for the solar forecast source. Run: node test/forecast.test.js */
"use strict";
process.env.TZ = "Australia/Sydney";
const assert = require("assert");
const { SolarForecast, sumForecasts, dailyTotals } = require("../sources/forecast.js");
const { buildContext, LoadHistory } = require("../policy/context.js");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };

// Two planes, as energy/solar_forecast returns them (UTC; Sydney is +11 in November).
const plane = { wh_hours: {
  "2026-11-09T18:47:17+00:00": 48, "2026-11-09T22:00:00+00:00": 7000, "2026-11-10T01:00:00+00:00": 9000,  // 10 Nov local
  "2026-11-10T22:00:00+00:00": 3000, "2026-11-11T01:00:00+00:00": 4000,                                   // 11 Nov local
} };
const result = { a: plane, b: plane };

t("planes sum by hour, partial hours fold into their hour", () => {
  const h = sumForecasts(result);
  assert.strictEqual(h.length, 5);
  assert.strictEqual(h[0].t, Date.parse("2026-11-09T18:00:00Z"));
  assert.strictEqual(h[0].kwh, 0.096);
  assert.strictEqual(h[2].kwh, 18);
});

t("daily totals are local days", () => {
  const d = dailyTotals(sumForecasts(result));
  assert.deepStrictEqual(d.map((x) => x.date), ["2026-11-10", "2026-11-11"]);
  assert.strictEqual(Math.round(d[0].kwh * 1000), 32096);
  assert.strictEqual(d[1].kwh, 14);
});

t("read: worst of today/tomorrow, and the next 24 h", () => {
  const f = new SolarForecast({ ha: {} });
  f.hourly = sumForecasts(result); f.updated = Date.parse("2026-11-10T00:30:00Z"); f.entries = 2;
  const r = f.read(Date.parse("2026-11-10T00:30:00Z"));  // 11:30 local on the 10th
  assert.strictEqual(r.worstDayKwh, 14);
  assert.strictEqual(r.next24Kwh, 18 + 6);   // 01:00Z on the 11th is past 24 h
  assert.strictEqual(r.entries, 2);
  assert.ok(r.ageSec < 1);
});

t("read with nothing yet is NaN, and autonomy then assumes no PV", () => {
  const r = new SolarForecast({ ha: {} }).read();
  assert.ok(Number.isNaN(r.worstDayKwh) && r.ageSec === Infinity);
  const ctx = buildContext({ now: new Date(), soc: 60, pvKw: 0, loadKw: 1, toutC: 20, forecastKwh: NaN,
    history: new LoadHistory(7, 30), battery: { capacity_kwh: 51.8, reserve_pct: 10 } });
  assert.strictEqual(ctx.forecast, 1);
  assert.ok(Math.abs(ctx.autonomy - 51.8 * 0.5 / 30) < 1e-9);
});

t("the forecast variable uses the next 24 h, autonomy the worst day", () => {
  const ctx = buildContext({ now: new Date(), soc: 60, pvKw: 0, loadKw: 1, toutC: 20, forecastKwh: 14, forecastNext24Kwh: 45,
    history: new LoadHistory(7, 30), battery: { capacity_kwh: 51.8, reserve_pct: 10 } });
  assert.strictEqual(ctx.forecast, 1.5);
  assert.ok(Math.abs(ctx.autonomy - 25.9 / 16) < 1e-9);
});

console.log(`\n${pass} passed`);
