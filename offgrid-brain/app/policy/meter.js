/* Lifetime energy counters built from the SP PRO's daily counters, corrected for
   their midnight reset: battery charged, battery discharged, house load and
   generator input.

   The bridge only has TODAY's figures. They tick in ~0.1 kWh steps and reset at the
   SP PRO's own midnight, by its own clock (which can be an hour or more out). Home
   Assistant reads a counter that drops to zero as a restart, and the energy the
   old day had built up since its last step was never reported, so the hour around
   the reset came out empty.

   So each counter keeps a lifetime total that only goes up:
     - while the daily figure rises, the rise is added (so energy counted while the
       brain was down still arrives, the next time it reads the counter);
     - when it drops, that's the reset: the new day's figure is added, plus the
       part of a step the old day had built up but never reported, estimated from
       the live power integrated since its last step (at most one step's worth).
   The SP PRO's counters stay the measurement; live power only fills that gap. */
"use strict";

const KEYS = ["batteryInKwh", "batteryOutKwh", "loadKwh", "generatorKwh"];
const MAX_GAP_SEC = 60;        // longest stretch of one power reading counted toward the gap estimate
const MAX_REMAINDER_KWH = 0.2; // a little over one step of the SP PRO's counters

class EnergyMeter {
  constructor(state) {
    const s = (state && state.counters) || {};
    this.counters = {};
    for (const k of KEYS) {
      const c = s[k] || {};
      this.counters[k] = {
        total: Number.isFinite(c.total) ? c.total : NaN,        // lifetime kWh
        daily: Number.isFinite(c.daily) ? c.daily : NaN,        // the SP PRO's figure last seen
        pending: Number.isFinite(c.pending) ? c.pending : 0,    // kWh from power since the figure last rose
      };
    }
    // 0.23.0 kept integrated totals; carry them on so Home Assistant sees no drop.
    const old = state && state.totals;
    if (old) for (const k of KEYS) if (!Number.isFinite(this.counters[k].total) && Number.isFinite(old[k])) this.counters[k].total = old[k];
    this.last = null;
  }

  get seeded() { return KEYS.every((k) => Number.isFinite(this.counters[k].total)); }
  get totals() { return Object.fromEntries(KEYS.map((k) => [k, this.counters[k].total])); }

  /** Start any counter without a total from a value (e.g. today's SP PRO figure). */
  seed(values) {
    for (const k of KEYS) {
      if (!Number.isFinite(this.counters[k].total)) this.counters[k].total = Number.isFinite(values && values[k]) ? values[k] : 0;
    }
  }

  /**
   * One tick.
   *   power  { batteryKw (+ charging), loadKw, generatorKw }: NaN counts nothing
   *   daily  { batteryInKwh, ... }: the SP PRO's figures for today, NaN when unread
   */
  add(nowMs, power = {}, daily = {}) {
    if (!this.seeded) return;
    const prev = this.last;
    this.last = nowMs;
    const h = prev == null ? 0 : Math.min(MAX_GAP_SEC, Math.max(0, (nowMs - prev) / 1000)) / 3600;
    const kw = {
      batteryInKwh: Math.max(0, power.batteryKw), batteryOutKwh: Math.max(0, -power.batteryKw),
      loadKwh: Math.max(0, power.loadKw), generatorKwh: Math.max(0, power.generatorKw),
    };
    for (const k of KEYS) {
      const c = this.counters[k];
      if (Number.isFinite(kw[k])) c.pending += kw[k] * h;
      const d = daily[k];
      if (!Number.isFinite(d)) continue;
      if (!Number.isFinite(c.daily)) { c.daily = d; c.pending = 0; continue; }   // first sight: nothing to add yet
      if (d > c.daily) { c.total += d - c.daily; c.pending = 0; }
      else if (d < c.daily) {
        // The SP PRO's midnight: what the old day never reported, then the new day so far.
        c.total += Math.min(MAX_REMAINDER_KWH, c.pending) + d;
        c.pending = 0;
      }
      c.daily = d;
    }
  }

  /** Readings in the shape inputs.energy uses. */
  readings() {
    const out = {};
    for (const k of KEYS) out[k] = { value: this.counters[k].total, ageSec: 0 };
    return out;
  }

  toJSON() { return { counters: this.counters }; }
}

/* Solar available energy: what the arrays COULD have generated, lifetime kWh.

   Off grid, delivered solar is throttled to what the house and battery take, so
   the inverters' own counters say little about the sun. This integrates, tick by
   tick, the larger of the estimated available power and what was delivered (the
   estimate can dip under a real reading). Home Assistant's long-term statistics of
   it give daily, monthly and yearly totals of the solar resource, for planning
   loads against the days the site actually gets. A gap longer than MAX_GAP_SEC
   counts only MAX_GAP_SEC, so a restart or outage leaves a hole rather than
   guessing; with no reading at all (no irradiance and no inverters) nothing is
   counted. */
class AvailableMeter {
  constructor(state) {
    this.total = state && Number.isFinite(state.total) ? state.total : 0;
    this.last = null;
  }

  add(nowMs, availableKw, deliveredKw) {
    const kw = Math.max(Number.isFinite(availableKw) ? availableKw : -Infinity, Number.isFinite(deliveredKw) ? deliveredKw : -Infinity);
    const prev = this.last;
    this.last = nowMs;
    if (prev == null || !Number.isFinite(kw)) return;
    this.total += Math.max(0, kw) * (Math.min(MAX_GAP_SEC, Math.max(0, (nowMs - prev) / 1000)) / 3600);
  }

  toJSON() { return { total: this.total }; }
}

module.exports = { EnergyMeter, AvailableMeter, MAX_GAP_SEC, MAX_REMAINDER_KWH };
