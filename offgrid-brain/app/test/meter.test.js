/* Tests for the brain's own energy meters. Run: node test/meter.test.js */
"use strict";
const assert = require("assert");
const { EnergyMeter } = require("../policy/meter.js");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

t("nothing is counted until it's seeded", () => {
  const m = new EnergyMeter();
  m.add(0, { batteryKw: -1, loadKw: 1 }); m.add(5000, { batteryKw: -1, loadKw: 1 });
  assert.ok(!m.seeded && Number.isNaN(m.totals.loadKwh));
});

t("integrates power into energy, split by direction, from the seed", () => {
  const m = new EnergyMeter();
  m.seed({ batteryInKwh: 1, batteryOutKwh: 2, loadKwh: 3 });
  for (let s = 0; s <= 3600; s += 5) m.add(s * 1000, { batteryKw: s <= 1800 ? -0.2 : 0.4, loadKw: 0.1 });
  close(m.totals.batteryOutKwh, 2 + 0.2 * 0.5);
  close(m.totals.batteryInKwh, 1 + 0.4 * 0.5);
  close(m.totals.loadKwh, 3 + 0.1);
});

t("a long gap counts at most a minute, and NaN counts nothing", () => {
  const m = new EnergyMeter(); m.seed({});
  m.add(0, { batteryKw: -6, loadKw: NaN });
  m.add(3600 * 1000, { batteryKw: -6, loadKw: NaN });   // an hour later: only 60 s counted
  close(m.totals.batteryOutKwh, 6 * 60 / 3600);
  assert.strictEqual(m.totals.loadKwh, 0);
});

t("totals survive a restart and never go down", () => {
  const m = new EnergyMeter(); m.seed({ loadKwh: 5 });
  m.add(0, { loadKw: 1 }); m.add(10000, { loadKw: 1 });
  const back = new EnergyMeter(JSON.parse(JSON.stringify(m.toJSON())));
  assert.ok(back.seeded);
  close(back.totals.loadKwh, m.totals.loadKwh);
  back.seed({ loadKwh: 0 });   // a later seed doesn't overwrite
  close(back.totals.loadKwh, m.totals.loadKwh);
});

console.log(`\n${pass} passed`);
