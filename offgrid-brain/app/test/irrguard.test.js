/* Tests for the blocked-irradiance-sensor guard. Run: node test/irrguard.test.js */
"use strict";
const assert = require("assert");
const { IrradianceGuard } = require("../policy/irrguard.js");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };
const S = 1000;
const noon = { forecastKw: 11, deliveredKw: 0.3, kwp: 29.45 };   // forecast expects sun; battery full, so delivery is low

t("10 Nov 12:53: a bird on the sensor is held, then let go when it flies off", () => {
  const g = new IrradianceGuard();
  const out = [];
  let t0 = 0;
  for (let s = 0; s < 300; s += 10) out.push(g.filter(t0 + s * S, 1026, noon));
  // 12:53:08 -> 13:00:38: the readings the Ecowitt actually gave
  const block = [28, 42, 43, 46, 42, 40, 49, 43, 49, 50, 46, 43, 41, 39, 42, 41, 36, 35, 43, 50, 48, 44, 40, 43, 21, 20, 21, 20, 23, 21, 19, 18, 10, 21, 20];
  t0 = 300 * S;
  const during = block.map((v, i) => g.filter(t0 + i * 12.9 * S, v, noon));
  const after = g.filter(t0 + 460 * S, 1037, noon);
  assert.strictEqual(during[0].event.type, "start");
  assert.ok(during.every((r) => r.held && r.value === 1026), "the last good level is held throughout");
  assert.strictEqual(after.held, false);
  assert.strictEqual(after.value, 1037);
  assert.deepStrictEqual([after.event.type, after.event.how, after.event.lowest_wm2], ["end", "recovered", 10]);
  assert.ok(Math.abs(after.event.minutes - 7.7) < 0.2, String(after.event.minutes));
});

t("a block that lasts past 10 minutes is accepted as weather", () => {
  const g = new IrradianceGuard();
  for (let s = 0; s < 300; s += 10) g.filter(s * S, 900, noon);
  g.filter(300 * S, 40, noon);
  assert.strictEqual(g.filter(800 * S, 40, noon).held, true);
  const r = g.filter(901 * S, 40, noon);
  assert.deepStrictEqual([r.held, r.value, r.event.how], [false, 40, "accepted as weather"]);
});

t("a cloud edge (a 60% dip) is believed, not held", () => {
  const g = new IrradianceGuard();
  for (let s = 0; s < 300; s += 10) g.filter(s * S, 1000, noon);
  const r = g.filter(300 * S, 400, noon);
  assert.deepStrictEqual([r.held, r.value, r.event], [false, 400, null]);
});

t("a drop the forecast expected (evening) is believed", () => {
  const g = new IrradianceGuard();
  const dusk = { forecastKw: 0.3, deliveredKw: 0.1, kwp: 29.45 };
  for (let s = 0; s < 300; s += 10) g.filter(s * S, 350, dusk);
  assert.strictEqual(g.filter(300 * S, 20, dusk).held, false);
});

t("but even then, inverters delivering more than the reading allows mean the sensor is wrong", () => {
  const g = new IrradianceGuard();
  const ctx = { forecastKw: 0.3, deliveredKw: 6, kwp: 29.45 };
  for (let s = 0; s < 300; s += 10) g.filter(s * S, 800, ctx);
  assert.strictEqual(g.filter(300 * S, 20, ctx).held, true);
});

t("low levels (dawn, dusk, overcast) are never held", () => {
  const g = new IrradianceGuard();
  for (let s = 0; s < 300; s += 10) g.filter(s * S, 200, noon);
  assert.strictEqual(g.filter(300 * S, 5, noon).held, false);
});

console.log(`\n${pass} passed`);
