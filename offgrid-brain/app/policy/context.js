/* Builds the expression-variable context for one tick.

   Mirrors the variable definitions in offgrid-sim/web/sim.js so an expression
   means the same thing in the simulator and in the live house. Where the
   simulator has perfect foresight, the brain has to approximate — those gaps
   are called out below and are the main source of sim/reality divergence. */
"use strict";

// Identical to sim.js
const houseOcc = (h) => (h < 6 || h >= 9 ? 1 : 0);
const seasonOf = (doy) => (1 - Math.cos((2 * Math.PI * (doy - 355)) / 365)) / 2;

function dayOfYear(d) {
  return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
}

/* Rolling record of realised daily load, used for the `autonomy` denominator.
   Persisted to /data so a restart does not reset the brain's memory of demand. */
class LoadHistory {
  constructor(windowDays, seedKwh) {
    this.windowDays = windowDays;
    this.seedKwh = seedKwh;
    this.days = [];        // [{date, kwh}]
    this.current = null;   // {date, kwh}
  }
  static fromJSON(o, windowDays, seedKwh) {
    const h = new LoadHistory(windowDays, seedKwh);
    if (o && Array.isArray(o.days)) h.days = o.days.slice(-windowDays);
    if (o && o.current) h.current = o.current;
    return h;
  }
  toJSON() { return { days: this.days, current: this.current }; }

  /** Accumulate kWh for the tick (loadKw sustained over dtSeconds). */
  add(date, loadKw, dtSeconds) {
    if (!this.current || this.current.date !== date) {
      if (this.current) {
        this.days.push(this.current);
        if (this.days.length > this.windowDays) this.days = this.days.slice(-this.windowDays);
      }
      this.current = { date, kwh: 0 };
    }
    if (Number.isFinite(loadKw)) this.current.kwh += (loadKw * dtSeconds) / 3600;
  }
  /** Trailing mean of COMPLETE days; seed until we have one. */
  expectedDailyKwh() {
    if (!this.days.length) return this.seedKwh;
    return this.days.reduce((a, d) => a + d.kwh, 0) / this.days.length;
  }
}

/* autonomy = usable battery (kWh) / predicted daily deficit, capped at 99.

   sim.js uses the WORST day in a 3-day lookahead of ACTUAL future PV. The brain
   has no such oracle: it uses the worse of today's and tomorrow's forecast totals
   (HA's Energy forecasts, or a mapped entity), else assumes no PV at all. This is the single
   biggest known sim/reality gap — but autonomy self-corrects every tick against
   real SoC, which is exactly why the worst-day ladder was chosen over separate
   per-regime ladders. */
function autonomyOf({ socPct, capacityKwh, reservePct, expectedLoadKwh, forecastKwh }) {
  const usable = Math.max(0, ((socPct - reservePct) / 100) * capacityKwh);
  const gen = Number.isFinite(forecastKwh) ? forecastKwh : 0;
  const netDeficit = expectedLoadKwh - gen;
  if (!(netDeficit > 0.1)) return 99;
  return Math.min(99, usable / netDeficit);
}

/** Assemble the full variable set for dispatch.decide(). */
function buildContext({ now, soc, pvKw, loadKw, toutC, forecastKwh, forecastNext24Kwh = forecastKwh, history, battery }) {
  const hour = now.getHours();
  const dow = (now.getDay() + 6) % 7;          // sim.js: 0 = Monday
  const doy = dayOfYear(now);
  const expectedLoadKwh = history.expectedDailyKwh();

  return {
    hour,
    dow,
    weekend: dow >= 5 ? 1 : 0,
    month: now.getMonth() + 1,
    season: seasonOf(doy),
    occ: houseOcc(hour),
    // sim.js derives dark/sun from modelled PV; here it is measured PV power.
    dark: pvKw < 0.3 ? 1 : 0,
    sun: pvKw >= 0.3 ? 1 : 0,
    soc,
    pv: pvKw,
    surplus: Math.max(0, pvKw - (loadKw || 0)),  // overwritten per-entry during the walk
    tout: toutC,
    // sim.js `forecast` = next 24 h PV / seasonal median. Approximated as the
    // next 24 h of forecast PV over the trailing expected daily load; 1.0 when unknown.
    forecast: Number.isFinite(forecastNext24Kwh) && expectedLoadKwh > 0
      ? forecastNext24Kwh / expectedLoadKwh
      : 1,
    used: 0,                                     // per-device daily budgets: v0.2
    gap: 0,                                      // zone temperature delta: v0.2
    autonomy: autonomyOf({
      socPct: soc,
      capacityKwh: battery.capacity_kwh,
      reservePct: battery.reserve_pct,
      expectedLoadKwh,
      forecastKwh,
    }),
  };
}

module.exports = { buildContext, LoadHistory, autonomyOf, seasonOf, houseOcc, dayOfYear };
