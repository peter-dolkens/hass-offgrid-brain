/* Tests for what the MQTT sink publishes. Run: node test/mqtt.test.js */
"use strict";
const assert = require("assert");
const { MqttSink } = require("../sinks/mqtt.js");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };

function capture() {
  const sink = new MqttSink({ enabled: true });
  const sent = {};
  sink.client = { connected: true, publish: (topic, payload) => { sent[topic] = payload; } };
  return { sink, sent };
}
const fresh = (value) => ({ value, ageSec: 5 });
const tick = (inputs) => ({
  ctx: { pv: 1.2, autonomy: 2 }, safeMode: false, dryRun: true,
  result: { charge: 0.5, deficitKw: 0, floorPct: 40, shed: [] },
  inputs: { soc: fresh(80), loadKw: fresh(0.6), pvKw: fresh(1.2), ...inputs },
});

t("energy counters are announced for the Energy dashboard", () => {
  const { sink, sent } = capture();
  sink.publishTick(tick({ batteryKw: fresh(-0.4), energy: {
    batteryInKwh: fresh(1.354), batteryOutKwh: fresh(0.738), loadKwh: fresh(0.569), generatorKwh: fresh(0),
  } }));
  for (const key of ["battery_in_energy", "battery_out_energy", "load_energy", "generator_energy"]) {
    const cfg = JSON.parse(sent[`homeassistant/sensor/offgrid_brain/${key}/config`]);
    assert.strictEqual(cfg.device_class, "energy", key);
    assert.strictEqual(cfg.state_class, "total_increasing", key);
    assert.strictEqual(cfg.unit_of_measurement, "kWh", key);
  }
  assert.strictEqual(sent["offgrid_brain/battery_in_energy"], "1.354");
});

t("each solar inverter gets its own power and energy entities", () => {
  const { sink, sent } = capture();
  sink.publishTick(tick({ inverters: [
    { key: "right", name: "Solar Inverter (Right)", powerKw: fresh(1.5), energyKwh: fresh(102.4258) },
    { key: "left", name: "Solar Inverter (Left)", powerKw: fresh(0.75), energyKwh: { value: NaN, ageSec: Infinity } },
  ] }));
  assert.strictEqual(sent["offgrid_brain/solar_right_power"], "1500");
  assert.strictEqual(sent["offgrid_brain/solar_right_energy"], "102.426");
  assert.strictEqual(sent["offgrid_brain/solar_left_power"], "750");
  assert.ok(!("offgrid_brain/solar_left_energy" in sent), "no counter, no energy entity update");
  const cfg = JSON.parse(sent["homeassistant/sensor/offgrid_brain/solar_right_energy/config"]);
  assert.strictEqual(cfg.name, "Solar Inverter (Right) energy");
  assert.strictEqual(cfg.state_class, "total_increasing");
});

t("battery power is published for the Energy dashboard: positive while discharging", () => {
  const { sink, sent } = capture();
  sink.publishTick(tick({ batteryKw: fresh(-0.4), energy: null }));   // bridge: -0.4 kW = discharging
  assert.strictEqual(sent["offgrid_brain/battery_power"], "400");
  const cfg = JSON.parse(sent["homeassistant/sensor/offgrid_brain/battery_power/config"]);
  assert.deepStrictEqual([cfg.device_class, cfg.state_class, cfg.unit_of_measurement], ["power", "measurement", "W"]);
});

t("stale or missing counters are not published (the retained value stands)", () => {
  const { sink, sent } = capture();
  sink.publishTick(tick({ energy: { batteryInKwh: { value: 10, ageSec: 5000 }, loadKwh: { value: NaN, ageSec: Infinity } } }));
  assert.ok(!("offgrid_brain/battery_in_energy" in sent));
  assert.ok(!("offgrid_brain/load_energy" in sent));
});

t("without a bridge (HA-entity sources) nothing energy-related is announced", () => {
  const { sink, sent } = capture();
  sink.publishTick(tick({ batteryKw: null, energy: null }));
  assert.ok(!Object.keys(sent).some((k) => /energy|battery_power|solar_/.test(k)));
});

console.log(`\n${pass} passed`);
