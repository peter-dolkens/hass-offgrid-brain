/* Guard against a blocked irradiance sensor.

   On 10 Nov at 12:53 the Ecowitt read 28 W/m² for 7½ minutes, then 1,035 again,
   while an unthrottled array next door held 7.5 kW throughout: something sat on the
   sensor. The sun doesn't do that. A cloud edge dims over tens of seconds and
   flickers, and even heavy overcast at midday leaves a few hundred W/m².

   So a reading is treated as a BLOCKED SENSOR when, in one step:
     - it falls below dropFrac (10%) of the recent level (the median of the last
       5 minutes of good readings), and that level was solid (>= minLevel W/m²),
     - and nothing else agrees the sun went: the solar forecast for now wasn't
       expecting darkness, or the inverters are delivering more than that darkness
       could give.
   While blocked, the last good level is held. It ends when the reading recovers to
   recoverFrac (50%) of the held level, or after holdSec (10 min), when the new
   level is accepted as real weather. Each start and end is returned as an event
   for the log. */
"use strict";

const MIN = 60 * 1000;

class IrradianceGuard {
  constructor({ dropFrac = 0.1, minLevel = 300, holdSec = 600, recoverFrac = 0.5, windowMin = 5 } = {}) {
    Object.assign(this, { dropFrac, minLevel, holdSec, recoverFrac, windowMs: windowMin * MIN });
    this.good = [];     // [[ms, W/m²]] recent readings taken as good
    this.held = null;   // { since, value, lowest } while a block is in progress
  }

  level(now) {
    this.good = this.good.filter(([t]) => now - t <= this.windowMs);
    if (!this.good.length) return NaN;
    const v = this.good.map(([, x]) => x).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  }

  /**
   * One reading. ctx: { forecastKw (solar forecast for now, kW), deliveredKw (what the
   * inverters are giving), kwp (total array) }; any may be NaN.
   * Returns { value (to use), held (bool), event (null | { type: "start"|"end", ... }) }.
   */
  filter(now, raw, ctx = {}) {
    if (!Number.isFinite(raw)) return { value: raw, held: false, event: null };
    if (this.held) {
      const h = this.held;
      h.lowest = Math.min(h.lowest, raw);
      const recovered = raw >= h.value * this.recoverFrac;
      const expired = (now - h.since) / 1000 >= this.holdSec;
      if (!recovered && !expired) return { value: h.value, held: true, event: null };
      this.held = null;
      this.good = [[now, raw]];
      return { value: raw, held: false,
        event: { type: "end", start: h.since, end: now, minutes: +((now - h.since) / MIN).toFixed(1), held_wm2: Math.round(h.value),
                 lowest_wm2: Math.round(h.lowest), how: recovered ? "recovered" : "accepted as weather" } };
    }
    const lvl = this.level(now);
    if (Number.isFinite(lvl) && lvl >= this.minLevel && raw < lvl * this.dropFrac && this.unexplained(raw, lvl, ctx)) {
      this.held = { since: now, value: lvl, lowest: raw };
      return { value: lvl, held: true, event: { type: "start", start: now, held_wm2: Math.round(lvl), reading_wm2: Math.round(raw) } };
    }
    this.good.push([now, raw]);
    return { value: raw, held: false, event: null };
  }

  /** Does anything else say the sun really went? If so, the drop is believed. */
  unexplained(raw, lvl, { forecastKw, deliveredKw, kwp } = {}) {
    // The inverters are delivering more than the new reading could give: the sensor is wrong.
    if (Number.isFinite(deliveredKw) && Number.isFinite(kwp) && deliveredKw > (raw / 1000) * kwp * 1.5 + 0.2) return true;
    // The forecast expected sun now (at least a quarter of what the recent level implies).
    if (Number.isFinite(forecastKw) && Number.isFinite(kwp) && kwp > 0) return forecastKw >= 0.25 * (lvl / 1000) * kwp * 0.8;
    return true;   // no forecast to say otherwise: a 90% step drop isn't weather
  }

  toJSON() { return { good: this.good, held: this.held }; }
  static fromJSON(o, opts) {
    const g = new IrradianceGuard(opts);
    if (o && Array.isArray(o.good)) g.good = o.good;
    if (o && o.held) g.held = o.held;
    return g;
  }
}

module.exports = { IrradianceGuard };
