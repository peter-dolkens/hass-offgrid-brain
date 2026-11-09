/* The Live timeline: the last day as recorded, and the next day as projected.

   Recorder keeps one sample a minute (numbers averaged over the minute's ticks,
   run/shed as of its last tick) for `keepHours`, persisted to /data so a restart
   doesn't blank the chart.

   project() walks forward from now in fixed steps. Solar is the hourly forecast
   (what the sun could give, already capped at each inverter's AC rating); load
   repeats the last day's measured load for that time of day. At each step the
   dispatch list is walked with that step's variables, so the projection shows
   which loads the brain would shed and when, and the battery is integrated the way
   the SP PRO does it: solar serves the load first, the surplus charges up to the
   charger limit, the shortfall discharges. Like the simulator it holds the battery
   at the reserve and flags the hours that would need the Shark or a generator. */
"use strict";
const fs = require("fs");
const log = require("../log.js");
const { decide } = require("./dispatch.js");
const { seasonOf, houseOcc, dayOfYear, autonomyOf } = require("./context.js");

const MIN = 60 * 1000, HOUR = 60 * MIN;
const NUMS = ["soc", "loadKw", "pvKw", "availKw", "battKw"];

class Recorder {
  constructor({ keepHours = 26, stepSec = 60 } = {}) {
    this.keepMs = keepHours * HOUR;
    this.stepMs = stepSec * 1000;
    this.samples = [];   // finished minutes
    this.cur = null;     // the minute being filled: running sums + count
  }

  static fromJSON(o, opts) {
    const r = new Recorder(opts);
    if (o && Array.isArray(o.samples)) r.samples = o.samples.filter((s) => s && Number.isFinite(s.t));
    return r;
  }
  toJSON() { return { samples: this.all() }; }

  /** One tick's reading. Numbers may be NaN (not recorded for the minute then). */
  add(t, s) {
    const bucket = Math.floor(t / this.stepMs) * this.stepMs;
    if (this.cur && this.cur.t !== bucket) this._close();
    if (!this.cur) this.cur = { t: bucket, sum: {}, n: {} };
    for (const k of NUMS) {
      if (!Number.isFinite(s[k])) continue;
      this.cur.sum[k] = (this.cur.sum[k] || 0) + s[k];
      this.cur.n[k] = (this.cur.n[k] || 0) + 1;
    }
    this.cur.run = s.run || [];
    this.cur.shed = s.shed || [];
    this.cur.floorPct = s.floorPct;
  }

  _close() {
    const c = this.cur, out = { t: c.t, run: c.run, shed: c.shed, floorPct: c.floorPct };
    for (const k of NUMS) out[k] = c.n[k] ? +(c.sum[k] / c.n[k]).toFixed(4) : null;
    this.samples.push(out);
    this.cur = null;
    const cutoff = out.t - this.keepMs;
    if (this.samples.length && this.samples[0].t < cutoff) this.samples = this.samples.filter((x) => x.t >= cutoff);
  }

  /** Finished minutes plus the one in progress. */
  all() {
    if (!this.cur) return this.samples.slice();
    const c = this.cur, open = { t: c.t, run: c.run, shed: c.shed, floorPct: c.floorPct };
    for (const k of NUMS) open[k] = c.n[k] ? +(c.sum[k] / c.n[k]).toFixed(4) : null;
    return [...this.samples, open];
  }

  since(t) { return this.all().filter((s) => s.t >= t); }

  save(file) {
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.toJSON()));
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) { log.warn("could not persist the timeline", e.message); }
  }
  static load(file, opts) {
    try { return Recorder.fromJSON(JSON.parse(fs.readFileSync(file, "utf8")), opts); } catch { return new Recorder(opts); }
  }
}

/** Load (kW) by time of day from recorded samples: the mean of each hour of the
    day, falling back to the overall mean, then to `fallbackKw`. */
function loadProfile(samples, fallbackKw) {
  const sum = new Array(24).fill(0), n = new Array(24).fill(0);
  let all = 0, alln = 0;
  for (const s of samples) {
    if (!Number.isFinite(s.loadKw)) continue;
    const h = new Date(s.t).getHours();
    sum[h] += s.loadKw; n[h]++; all += s.loadKw; alln++;
  }
  const mean = alln ? all / alln : fallbackKw;
  return (t) => { const h = new Date(t).getHours(); return n[h] ? sum[h] / n[h] : Number.isFinite(mean) ? mean : 0; };
}

/** Forecast kW at a time: the hour's kWh, which is its mean kW. NaN past the forecast. */
function forecastAt(hourly) {
  const m = new Map(hourly.map((h) => [h.t, h.kwh]));
  const last = hourly.length ? hourly[hourly.length - 1].t : -Infinity;
  return (t) => { const k = Math.floor(t / HOUR) * HOUR; return m.has(k) ? m.get(k) : k <= last ? 0 : NaN; };
}

/**
 * Walk forward from `now`.
 *   soc          battery % now
 *   ctx          this tick's context (the variables nothing here recomputes carry over)
 *   policy, limits  as for decide()
 *   battery      settings.battery (capacity_kwh, reserve_pct, max_charge_kw)
 *   forecast     [{t, kwh}] hourly
 *   load         (t) => kW
 *   autonomy     { expectedLoadKwh, forecastKwh } for each step's autonomy
 */
function project({ now, soc, ctx, policy, limits, battery, forecast, load, autonomy = {}, hours = 24, stepMin = 30 }) {
  const pvAt = forecastAt(forecast || []);
  const stepH = stepMin / 60, cap = battery.capacity_kwh, reserve = battery.reserve_pct;
  const out = [];
  let s = soc;
  const steps = Math.round((hours * 60) / stepMin);
  for (let k = 0; k <= steps; k++) {
    const t = now + k * stepMin * MIN, d = new Date(t);
    const fc = pvAt(t), known = Number.isFinite(fc), pv = known ? fc : 0;
    const loadKw = Math.max(0, load(t));
    const hour = d.getHours(), dow = (d.getDay() + 6) % 7;
    const c = {
      ...ctx, hour, dow, weekend: dow >= 5 ? 1 : 0, month: d.getMonth() + 1, season: seasonOf(dayOfYear(d)),
      occ: houseOcc(hour), dark: pv < 0.3 ? 1 : 0, sun: pv >= 0.3 ? 1 : 0, soc: s, pv,
      surplus: Math.max(0, pv - loadKw),
      autonomy: autonomyOf({ socPct: s, capacityKwh: cap, reservePct: reserve, ...autonomy }),
    };
    const r = decide(policy, c, limits);
    const chargeRoom = s < 99.5 ? battery.max_charge_kw : 0;
    const used = Math.min(pv, loadKw + chargeRoom);
    const battKw = used - loadKw;
    out.push({
      t, soc: +s.toFixed(2), loadKw: +loadKw.toFixed(4), pvKw: +used.toFixed(4), availKw: known ? +pv.toFixed(4) : null, battKw: +battKw.toFixed(4),
      run: r.decisions.filter((x) => x.run).map((x) => x.id), shed: r.shed.map((x) => x.id), floorPct: r.floorPct,
      deficit: s <= reserve + 0.01 && battKw < -0.01, forecast: known,
    });
    s = Math.max(reserve, Math.min(100, s + ((battKw * stepH) / cap) * 100));
  }
  return out;
}

module.exports = { Recorder, project, loadProfile, forecastAt };
