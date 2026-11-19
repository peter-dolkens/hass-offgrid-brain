/* What the brain learns about people: the setpoints they choose, and when they're in.

   Preferences: per zone, day type (weekday / weekend), hour and side (heat / cool),
   a decayed weighted mean of the setpoints people picked. One observation spreads
   over neighbouring hours with a Gaussian kernel, and a little into the other day
   type, so a single evening adjustment shapes the whole evening and a weekend with
   no data borrows from the weekdays. Old observations fade with a half-life.

   Occupancy: per zone, the fraction of each hour someone was in, kept per hour of
   the week (168 bins) and per day type x hour (48 bins), both decayed. The
   probability for a time shrinks the hour-of-week estimate toward the day-type one,
   and that toward a prior, so a new zone starts from the house schedule.

   Times are local (Date#getHours/getDay), as the rest of the brain uses them. */
"use strict";

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const dayType = (t) => { const d = new Date(t).getDay(); return d === 0 || d === 6 ? 1 : 0; };
const dowMon0 = (t) => (new Date(t).getDay() + 6) % 7;
const decayTo = (b, t, halfLifeMs) => (b && t > b.t ? Math.pow(0.5, (t - b.t) / halfLifeMs) : 1);

class Preferences {
  constructor(state, { halfLifeDays = 21, sigmaH = 1.5, crossDayType = 0.25 } = {}) {
    this.z = state && typeof state === "object" ? state : {};
    this.hl = halfLifeDays * DAY;
    this.sigma = sigmaH;
    this.cross = crossDayType;
  }
  toJSON() { return this.z; }
  forget(zone) { delete this.z[zone]; }

  _bins(zone, dt, side) {
    const z = (this.z[zone] = this.z[zone] || {});
    const k = `${dt}${side}`;
    return (z[k] = z[k] || Array.from({ length: 24 }, () => null));
  }

  /** Someone chose `value` °C for `side` ("heat" | "cool") at time t. */
  observe(zone, t, side, value, weight = 1) {
    if (!Number.isFinite(value) || value < 5 || value > 35 || !(side === "heat" || side === "cool")) return;
    const h = new Date(t).getHours(), dt = dayType(t);
    for (const [type, w0] of [[dt, weight], [1 - dt, weight * this.cross]]) {
      const bins = this._bins(zone, type, side);
      for (let dh = -4; dh <= 4; dh++) {
        const k = Math.exp(-(dh * dh) / (2 * this.sigma * this.sigma)) * w0;
        if (k < 0.02) continue;
        const i = (h + dh + 24) % 24;
        const b = bins[i] || { w: 0, x: 0, xx: 0, t };
        const f = decayTo(b, t, this.hl);
        b.w = b.w * f + k; b.x = b.x * f + k * value; b.xx = b.xx * f + k * value * value; b.t = Math.max(b.t, t);
        bins[i] = b;
      }
    }
  }

  /** The preferred setpoint at time t, blended from `fallback` by confidence. */
  preferred(zone, t, side, fallback) {
    const z = this.z[zone], b = z && z[`${dayType(t)}${side}`] && z[`${dayType(t)}${side}`][new Date(t).getHours()];
    if (!b || !(b.w > 0)) return { value: fallback, confidence: 0, learned: null };
    const w = b.w * decayTo(b, t, this.hl);
    const mean = b.x / b.w;
    const confidence = 1 - Math.exp(-w / 1.5);
    const value = Number.isFinite(fallback) ? fallback + confidence * (mean - fallback) : mean;
    return { value, confidence, learned: mean, spread: Math.sqrt(Math.max(0, b.xx / b.w - mean * mean)) };
  }
}

class Occupancy {
  constructor(state, { halfLifeDays = 28 } = {}) {
    this.z = state && typeof state === "object" ? state : {};
    this.hl = halfLifeDays * DAY;
  }
  toJSON() { return this.z; }
  forget(zone) { delete this.z[zone]; }

  _zone(zone) {
    return (this.z[zone] = this.z[zone] || { week: Array(168).fill(null), day: Array(48).fill(null), cur: null });
  }

  /** A reading at time t: occupied true/false, or null (unknown: not counted). */
  observe(zone, t, occupied) {
    const z = this._zone(zone), hourStart = Math.floor(t / HOUR) * HOUR;
    if (z.cur && z.cur.h !== hourStart) {
      if (z.cur.n > 0) this.addHour(zone, z.cur.h, z.cur.on / z.cur.n);
      z.cur = null;
    }
    if (occupied == null) return;
    z.cur = z.cur || { h: hourStart, on: 0, n: 0 };
    z.cur.n++; if (occupied) z.cur.on++;
  }

  /** The fraction of the hour starting at `hourStart` that the zone was occupied. */
  addHour(zone, hourStart, fraction) {
    const z = this._zone(zone), h = new Date(hourStart).getHours();
    const up = (arr, i) => {
      const b = arr[i] || { w: 0, s: 0, t: hourStart };
      const f = decayTo(b, hourStart, this.hl);
      b.w = b.w * f + 1; b.s = b.s * f + fraction; b.t = Math.max(b.t, hourStart);
      arr[i] = b;
    };
    up(z.week, dowMon0(hourStart) * 24 + h);
    up(z.day, dayType(hourStart) * 24 + h);
  }

  /** Probability the zone is occupied at time t; `prior` for a zone with no history. */
  probability(zone, t, prior = 0.5) {
    const z = this.z[zone];
    if (!z) return { p: prior, confidence: 0 };
    const h = new Date(t).getHours();
    const get = (b) => (b ? { w: b.w * decayTo(b, t, this.hl), s: b.s * decayTo(b, t, this.hl) } : { w: 0, s: 0 });
    const d = get(z.day[dayType(t) * 24 + h]), w = get(z.week[dowMon0(t) * 24 + h]);
    const pd = (d.s + prior * 1) / (d.w + 1);
    const p = (w.s + pd * 2) / (w.w + 2);
    return { p, confidence: 1 - Math.exp(-(w.w + d.w / 4) / 3) };
  }

  /** Minutes from `now` until the zone is likely occupied (p >= threshold), within
      `horizonMin`; null if not. `priorAt(t)` gives the prior for each time. */
  nextOccupied(zone, now, horizonMin, threshold, priorAt = () => 0.5) {
    for (let m = 0; m <= horizonMin; m += 15) {
      const t = now + m * 60000;
      if (this.probability(zone, t, priorAt(t)).p >= threshold) return m;
    }
    return null;
  }
}

module.exports = { Preferences, Occupancy, dayType };
