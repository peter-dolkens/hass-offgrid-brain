/* Tests for irradiance parsing and the available-solar estimate. Run: node test/solar.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { parseIrradiance } = require("../sources/ecowitt.js");
const { SolarEstimator, isUnconstrained, PRIOR_K } = require("../policy/solar.js");
const { MqttSink } = require("../sinks/mqtt.js");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const live = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "ecowitt-livedata.json"), "utf8"));
const withSolar = (val) => ({ ...live, common_list: live.common_list.map((x) => (x.id === "0x15" ? { ...x, val } : x)) });

t("irradiance from a real GW3000 document (0x15)", () => {
  assert.strictEqual(parseIrradiance(live), 0);
  assert.strictEqual(parseIrradiance(withSolar("845.32 W/m2")), 845.32);
});

t("irradiance in lux is converted, unknown units are rejected", () => {
  near(parseIrradiance(withSolar("107.10 Klux")), 107100 / 126.7, 1e-9);
  assert.ok(Number.isNaN(parseIrradiance(withSolar("12.0 fc"))));
  assert.ok(Number.isNaN(parseIrradiance({})));
});

t("unconstrained only while the battery is taking charge, well below the charge limit", () => {
  // 2026-11-09 06:30: topping up in Long Term Float, +1.17 kW into the battery.
  const base = { socPct: 98.4, batteryKw: 1.2, pvKw: 2.6, loadKw: 0.1, chargeLimitKw: 9 };
  assert.strictEqual(isUnconstrained(base), true, "topping up in Long Term Float still counts");
  assert.strictEqual(isUnconstrained({ ...base, batteryKw: 0.3 }), false, "only the taper's trickle");
  assert.strictEqual(isUnconstrained({ ...base, batteryKw: -0.4 }), false, "discharging");
  assert.strictEqual(isUnconstrained({ ...base, socPct: 99.8 }), false, "full");
  assert.strictEqual(isUnconstrained({ ...base, pvKw: 8 }), false, "near the charge limit, may be held back");
  assert.strictEqual(isUnconstrained({ ...base, socPct: NaN }), false, "unknown SoC");
});

const inv = (kw) => [{ key: "right", kwp: 14.725, kw }];
const at = (h, m = 0) => new Date(2026, 10, 9, h, m);

t("before learning, the prior performance ratio is used", () => {
  const e = new SolarEstimator();
  const [a] = e.estimate({ now: at(12), irradiance: 1000, inverters: inv(0.05) });
  near(a.availableKw, Math.min(10, 14.725 * PRIOR_K));
  assert.strictEqual(a.samples, 0);
  assert.strictEqual(a.curtailed, true, "50 W delivered under full sun is throttled");
});

t("learns the ratio from unthrottled moments, per half-hour bin", () => {
  const e = new SolarEstimator();
  // 07:00 today: 75 W/m², 1.286 kW from a 14.725 kWp array -> k ~1.16 (tilt beats a flat sensor).
  for (let m = 0; m < 30; m++) {
    e.learn({ now: at(7, m), irradiance: 75, inverters: inv(1.286), unconstrained: true });
  }
  const [a] = e.estimate({ now: at(7, 10), irradiance: 75, inverters: inv(1.286) });
  assert.strictEqual(a.samples, 30, "one sample per minute");
  assert.ok(a.k > 1.1 && a.k < 1.17, `k=${a.k}`);
  assert.strictEqual(a.curtailed, false, "delivering what the sun allows");
  // A different half-hour bin hasn't learned anything.
  assert.strictEqual(e.estimate({ now: at(13), irradiance: 75, inverters: inv(1) })[0].samples, 0);
});

t("doesn't learn while throttled, in low light, or at the AC limit", () => {
  const e = new SolarEstimator();
  assert.strictEqual(e.learn({ now: at(12), irradiance: 1000, inverters: inv(0.05), unconstrained: false }), 0);
  assert.strictEqual(e.learn({ now: at(6), irradiance: 10, inverters: inv(0.3), unconstrained: true }), 0);
  assert.strictEqual(e.learn({ now: at(12), irradiance: 1100, inverters: inv(9.8), unconstrained: true }), 0);
});

t("available power is capped at the inverter's AC rating", () => {
  const e = new SolarEstimator({ acKw: 10 });
  assert.strictEqual(e.estimate({ now: at(12), irradiance: 1200, inverters: inv(0.1) })[0].availableKw, 10);
});

t("learned state survives a round trip", () => {
  const e = new SolarEstimator();
  e.learn({ now: at(7), irradiance: 80, inverters: inv(1.3), unconstrained: true });
  const e2 = new SolarEstimator({ state: JSON.parse(JSON.stringify(e.toJSON())) });
  assert.deepStrictEqual(e2.factor("right", at(7)), e.factor("right", at(7)));
});

t("solar entities are published over MQTT", () => {
  const sink = new MqttSink({ enabled: true });
  const sent = {};
  sink.client = { connected: true, publish: (topic, payload) => { sent[topic] = payload; } };
  sink.publishSolar({
    irradiance: { value: 845.3, ageSec: 4 }, availableKw: 18.6, headroomKw: 18.5, curtailed: true,
    arrays: [{ key: "right", name: "Solar Inverter (Right)", availableKw: 9.3 }],
  }, { unit_of_measurement: "W", device_class: "power", state_class: "measurement" });
  assert.strictEqual(sent["offgrid_brain/irradiance"], "845");
  assert.strictEqual(sent["offgrid_brain/solar_available_power"], "18600");
  assert.strictEqual(sent["offgrid_brain/solar_curtailed"], "ON");
  assert.strictEqual(sent["offgrid_brain/solar_right_available_power"], "9300");
  assert.strictEqual(JSON.parse(sent["homeassistant/sensor/offgrid_brain/irradiance/config"]).device_class, "irradiance");
});

console.log(`\n${pass} passed`);
