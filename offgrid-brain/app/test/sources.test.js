/* Tests for reading the battery and inverters through their integrations.
   Run: node test/sources.test.js */
"use strict";
const assert = require("assert");
const { readBattery } = require("../sources/battery.js");
const { InverterSet } = require("../sources/inverters.js");
const { HAClient } = require("../sources/ha.js");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };

// An HA client with a mirror and no socket.
function fakeHa(states) {
  const ha = new HAClient({ token: "x" });
  for (const [id, [state, unit]] of Object.entries(states)) {
    ha.states.set(id, { state: String(state), attributes: { unit_of_measurement: unit }, updated: Date.now() });
  }
  return ha;
}
const fresh = (value) => ({ value, ageSec: 2 });

t("HA power and energy are converted from the entity's own unit", () => {
  const ha = fakeHa({ "sensor.w": [1500, "W"], "sensor.kw": [1.5, "kW"], "sensor.wh": [2500, "Wh"], "sensor.odd": [3, "hp"] });
  assert.strictEqual(ha.powerKw("sensor.w").value, 1.5);
  assert.strictEqual(ha.powerKw("sensor.kw").value, 1.5);
  assert.strictEqual(ha.energyKwh("sensor.wh").value, 2.5);
  assert.ok(Number.isNaN(ha.powerKw("sensor.odd").value), "unknown unit is unknown, not a guess");
});

t("bridge battery passes the bridge's readings through", () => {
  const bridge = { soc: fresh(87), loadKw: fresh(0.6), batteryKw: fresh(1.2), energy: { loadKwh: fresh(3) },
                   charger: "Bulk", chargeLimitKw: 9 };
  const b = readBattery({ source: "bridge" }, bridge, fakeHa({}));
  assert.deepStrictEqual([b.soc.value, b.loadKw.value, b.batteryKw.value, b.charger, b.chargeLimitKw], [87, 0.6, 1.2, "Bulk", 9]);
});

t("HA battery: power entity is negated (HA: + = discharging; brain: + = charging)", () => {
  const ha = fakeHa({ "sensor.soc": [64, "%"], "sensor.batt": [800, "W"], "sensor.load": [1.1, "kW"], "sensor.in": [12, "kWh"] });
  const b = readBattery({ source: "ha", soc_entity: "sensor.soc", power_entity: "sensor.batt", load_entity: "sensor.load",
                          energy_in_entity: "sensor.in" }, {}, ha);
  assert.strictEqual(b.soc.value, 64);
  assert.strictEqual(b.batteryKw.value, -0.8, "800 W discharging in HA = -0.8 kW internally");
  assert.strictEqual(b.loadKw.value, 1.1);
  assert.strictEqual(b.energy.batteryInKwh.value, 12);
  assert.ok(Number.isNaN(b.energy.batteryOutKwh.value), "unset entity is unknown");
});

t("no battery integration: no SoC (the brain will be in safe mode)", () => {
  assert.ok(Number.isNaN(readBattery({ source: "none" }, {}, fakeHa({})).soc.value));
});

t("inverters are read through their own integrations", () => {
  const ha = fakeHa({ "sensor.shed_pv": [2400, "W"], "sensor.shed_pv_energy": [812.5, "kWh"] });
  const set = new InverterSet({ ha });
  set.configure([
    { id: "right", name: "Right", source: "bridge", bridge_key: "right", ac_kw: 10, kwp: null },
    { id: "shed", name: "Shed", source: "ha", power_entity: "sensor.shed_pv", energy_entity: "sensor.shed_pv_energy", ac_kw: 5, kwp: 6.6 },
    { id: "spare", name: "Spare", source: "none", ac_kw: 3, kwp: 4 },
  ]);
  const bridge = { inverters: [{ key: "right", kwp: 14.725, powerKw: fresh(3.1), energyKwh: fresh(102.4) }] };
  const [r, sh, sp] = set.read(bridge);
  assert.deepStrictEqual([r.powerKw.value, r.kwp, r.acKw, r.live], [3.1, 14.725, 10, true], "bridge: kWp from the inverter");
  assert.deepStrictEqual([sh.powerKw.value, sh.energyKwh.value, sh.kwp, sh.acKw], [2.4, 812.5, 6.6, 5], "ha: W converted, kWp entered");
  assert.deepStrictEqual([sp.live, sp.kwp, Number.isNaN(sp.powerKw.value)], [false, 4, true], "none: capacity only");
  assert.deepStrictEqual(set.entities(), ["sensor.shed_pv", "sensor.shed_pv_energy"]);
  set.stop();
});

t("a bridge inverter the bridge doesn't report reads as unknown", () => {
  const set = new InverterSet({ ha: fakeHa({}) });
  set.configure([{ id: "x", name: "X", source: "bridge", bridge_key: "gone", ac_kw: 10, kwp: null }]);
  const [x] = set.read({ inverters: [] });
  assert.ok(Number.isNaN(x.powerKw.value) && Number.isNaN(x.kwp));
});

console.log(`\n${pass} passed`);
