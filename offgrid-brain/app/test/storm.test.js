/* Tests for the storm signal. Run: node test/storm.test.js */
"use strict";
const assert = require("assert");
const { StormWatch, stormWarnings, stormForecast } = require("../sources/storm.js");
const { buildContext, LoadHistory } = require("../policy/context.js");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };
const MIN = 60000, T0 = Date.parse("2026-11-13T03:00:00Z");

function fakeHa(states) {
  const m = new Map(Object.entries(states).map(([k, v]) => [k, typeof v === "object" ? v : { state: String(v), attributes: {} }]));
  return { states: m, set(k, v) { m.set(k, typeof v === "object" ? v : { state: String(v), attributes: {} }); } };
}
const sources = { storm_warnings: "sensor.w", storm_forecast: "sensor.tug", lightning_distance: "sensor.ld", lightning_counter: "sensor.lc" };

t("warnings: thunderstorm and severe weather count; marine, cancelled and expired don't", () => {
  const w = stormWarnings([
    { type: "severe_thunderstorm_warning", title: "Severe Thunderstorm Warning for Mid North Coast", phase: "new" },
    { type: "severe_weather_warning", title: "Severe Weather Warning", phase: "update" },
    { type: "marine_wind_warning", title: "Strong Wind Warning for Coastal Waters", phase: "new" },
    { type: "severe_thunderstorm_warning", title: "Severe Thunderstorm Warning", phase: "cancelled" },
    { type: "severe_thunderstorm_warning", title: "old", expiry_time: "2026-11-13T01:00:00Z" },
    { type: "flood_watch", title: "Flood Watch" },
  ], T0);
  assert.deepStrictEqual(w.map((x) => x.type), ["severe_thunderstorm_warning", "severe_weather_warning"]);
});

t("forecast: a lightning icon or 'storm' in the summary", () => {
  assert.ok(stormForecast("mdi:weather-lightning-rainy", "Showers."));
  assert.ok(stormForecast("mdi:weather-rainy", "Showers. Storms developing."));
  assert.ok(!stormForecast("mdi:weather-rainy", "Showers."));
});

t("lightning: counter rises are strikes; near ones raise storm, and age out of the window", () => {
  const ha = fakeHa({ "sensor.lc": 5, "sensor.ld": 80 });
  const s = new StormWatch({ ha, sources, near_km: 30, window_min: 30 });
  assert.deepStrictEqual(s.read(T0).vars, { storm: 0, storm_ahead: 0, lightning: 999 });   // first sight: a baseline, not a strike
  ha.set("sensor.lc", 6); ha.set("sensor.ld", 45);
  assert.deepStrictEqual(s.read(T0 + MIN).vars, { storm: 0, storm_ahead: 0, lightning: 45 });
  ha.set("sensor.lc", 9); ha.set("sensor.ld", 12.34);
  assert.deepStrictEqual(s.read(T0 + 2 * MIN).vars, { storm: 1, storm_ahead: 1, lightning: 12.3 });
  assert.deepStrictEqual(s.read(T0 + 40 * MIN).vars, { storm: 0, storm_ahead: 0, lightning: 999 });
  ha.set("sensor.lc", 0);   // HA restarted the count
  assert.strictEqual(s.read(T0 + 41 * MIN).detail.strikes, 0);
});

t("a BoM warning raises storm; a forecast storm raises only storm_ahead", () => {
  const ha = fakeHa({ "sensor.tug_mdi_icon_1": "mdi:weather-lightning-rainy", "sensor.tug_short_text_1": "Showers. Storm developing.",
    "sensor.w": { state: "0", attributes: { warnings: [] } } });
  const s = new StormWatch({ ha, sources });
  const r = s.read(T0);
  assert.deepStrictEqual(r.vars, { storm: 0, storm_ahead: 1, lightning: 999 });
  assert.deepStrictEqual(r.detail.forecast, [{ day: 1, text: "Showers. Storm developing." }]);
  ha.set("sensor.w", { state: "1", attributes: { warnings: [{ type: "severe_thunderstorm_warning", title: "Severe Thunderstorm Warning" }] } });
  assert.deepStrictEqual(s.read(T0 + MIN).vars.storm, 1);
  assert.deepStrictEqual(s.entities().sort(), ["sensor.lc", "sensor.ld", "sensor.tug_mdi_icon_0", "sensor.tug_mdi_icon_1", "sensor.tug_short_text_0", "sensor.tug_short_text_1", "sensor.w"]);
});

t("unconfigured: never a storm; the context defaults to no storm", () => {
  const s = new StormWatch({ ha: fakeHa({}) });
  assert.deepStrictEqual(s.read(T0).vars, { storm: 0, storm_ahead: 0, lightning: 999 });
  const ctx = buildContext({ now: new Date(T0), soc: 50, pvKw: 0, loadKw: 1, toutC: 20, history: new LoadHistory(), battery: { capacity_kwh: 50, reserve_pct: 10 } });
  assert.deepStrictEqual([ctx.storm, ctx.storm_ahead, ctx.lightning], [0, 0, 999]);
});

console.log(`\n${pass} passed`);
