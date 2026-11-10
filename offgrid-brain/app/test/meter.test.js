/* Tests for the lifetime energy counters. Run: node test/meter.test.js */
"use strict";
const assert = require("assert");
const { EnergyMeter } = require("../policy/meter.js");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const MIN = 60000;

t("nothing is counted until it's seeded", () => {
  const m = new EnergyMeter();
  m.add(0, {}, { loadKwh: 1 }); m.add(MIN, {}, { loadKwh: 2 });
  assert.ok(!m.seeded && Number.isNaN(m.totals.loadKwh));
});

t("rises in the daily figure add to the lifetime total; power doesn't", () => {
  const m = new EnergyMeter(); m.seed({ loadKwh: 10 });
  m.add(0, { loadKw: 5 }, { loadKwh: 0.342 });          // first sight: just remembered
  m.add(MIN, { loadKw: 5 }, { loadKwh: 0.342 });        // power alone changes nothing
  m.add(2 * MIN, { loadKw: 5 }, { loadKwh: 0.456 });
  close(m.totals.loadKwh, 10 + 0.114);
});

t("the SP PRO's reset adds the new day plus the unreported part of a step", () => {
  const m = new EnergyMeter(); m.seed({ batteryOutKwh: 5 });
  m.add(0, { batteryKw: -0.11 }, { batteryOutKwh: 1.107 });
  m.add(MIN, { batteryKw: -0.11 }, { batteryOutKwh: 1.23 });       // a step
  for (let s = 1; s <= 10; s++) m.add((1 + s) * MIN, { batteryKw: -0.11 }, { batteryOutKwh: 1.23 });   // 10 min, no step
  m.add(12 * MIN, { batteryKw: -0.11 }, { batteryOutKwh: 0 });     // midnight on the SP PRO's clock
  close(m.totals.batteryOutKwh, 5 + 0.123 + 0.11 * 11 / 60, 1e-6);   // the step, then 11 minutes estimated
  m.add(13 * MIN, { batteryKw: -0.11 }, { batteryOutKwh: 0.123 });
  close(m.totals.batteryOutKwh, 5 + 0.123 + 0.11 * 11 / 60 + 0.123, 1e-6);
});

t("the estimate at a reset is capped at about one step", () => {
  const m = new EnergyMeter(); m.seed({ loadKwh: 0 });
  m.add(0, { loadKw: 3 }, { loadKwh: 2 });
  for (let s = 1; s <= 30; s++) m.add(s * MIN, { loadKw: 3 }, { loadKwh: 2 });   // stuck counter, big power
  m.add(31 * MIN, { loadKw: 3 }, { loadKwh: 0.1 });
  close(m.totals.loadKwh, 0.2 + 0.1);
});

t("energy counted while the brain was down arrives with the next reading", () => {
  const m = new EnergyMeter(); m.seed({ loadKwh: 1 });
  m.add(0, {}, { loadKwh: 0.5 });
  const back = new EnergyMeter(JSON.parse(JSON.stringify(m.toJSON())));
  back.add(3 * 60 * MIN, {}, { loadKwh: 0.9 });   // three hours later
  close(back.totals.loadKwh, 1.4);
});

t("0.23.0's integrated totals carry on without a drop; generator starts at zero", () => {
  const m = new EnergyMeter({ totals: { batteryInKwh: 1.304, batteryOutKwh: 0.498, loadKwh: 0.748, generatorKwh: 0 } });
  assert.ok(m.seeded);
  assert.deepStrictEqual(m.totals, { batteryInKwh: 1.304, batteryOutKwh: 0.498, loadKwh: 0.748, generatorKwh: 0 });
  const old = new EnergyMeter({ totals: { batteryInKwh: 1, batteryOutKwh: 2, loadKwh: 3 } });
  old.seed({});
  assert.strictEqual(old.totals.generatorKwh, 0);
});
console.log(`
${pass} passed`);
