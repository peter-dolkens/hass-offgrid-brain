/* The brain's own lifetime energy meters: battery charged, battery discharged,
   house load and generator input, integrated from the live power readings.

   Why not the SP PRO's counters: the bridge only has TODAY's figures. They tick in
   ~0.1 kWh steps and reset at the SP PRO's own midnight, and its clock can be well
   off (an hour, once). Home Assistant's Energy dashboard reads a counter that drops
   to zero as a reset, so the last tick before the reset was lost and the hour around
   it came out empty. These meters only ever go up, keep watt-hour resolution, and
   survive restarts in /data.

   A gap in the readings (the brain stopped, the bridge went stale) is not
   bridged: at most MAX_GAP_SEC of a reading is counted, so a long outage loses
   that time's energy rather than inventing it. */
"use strict";

const MAX_GAP_SEC = 60;
const KEYS = ["batteryInKwh", "batteryOutKwh", "loadKwh", "generatorKwh"];

class EnergyMeter {
  constructor(state) {
    this.totals = {};
    for (const k of KEYS) this.totals[k] = state && Number.isFinite(state.totals && state.totals[k]) ? state.totals[k] : NaN;
    this.last = null;   // epoch ms of the last reading counted
  }

  get seeded() { return KEYS.every((k) => Number.isFinite(this.totals[k])); }

  /** Start from the counters' current values (e.g. the SP PRO's today figures), so
      switching to these meters doesn't look like a reset. Only fills totals not yet set. */
  seed(values) {
    for (const k of KEYS) {
      if (!Number.isFinite(this.totals[k])) this.totals[k] = Number.isFinite(values && values[k]) ? values[k] : 0;
    }
  }

  /** Count one tick. batteryKw: + charging, - discharging. NaN readings count nothing. */
  add(nowMs, { batteryKw, loadKw, generatorKw }) {
    if (!this.seeded) return;
    const prev = this.last;
    this.last = nowMs;
    if (prev == null) return;
    const h = Math.min(MAX_GAP_SEC, Math.max(0, (nowMs - prev) / 1000)) / 3600;
    if (Number.isFinite(batteryKw)) {
      if (batteryKw > 0) this.totals.batteryInKwh += batteryKw * h;
      else this.totals.batteryOutKwh += -batteryKw * h;
    }
    if (Number.isFinite(loadKw) && loadKw > 0) this.totals.loadKwh += loadKw * h;
    if (Number.isFinite(generatorKw) && generatorKw > 0) this.totals.generatorKwh += generatorKw * h;
  }

  /** Readings in the shape inputs.energy uses, fresh as of now. */
  readings() {
    const out = {};
    for (const k of KEYS) out[k] = { value: this.totals[k], ageSec: 0 };
    return out;
  }

  toJSON() { return { totals: this.totals }; }
}

module.exports = { EnergyMeter, MAX_GAP_SEC };
