/* The hourly log: forecast against actual, kept for good, for tuning the model.

   Home Assistant keeps irradiance and solar statistics forever, but not what the
   forecast said a day earlier, and the brain's own projections only live 26 hours.
   So for every hour the brain writes one row, when the hour has ended:

     forecast  kWh the solar forecast gave for that hour, as it stood
                 d1    at least 24 h before the hour began (the day-ahead view)
                 h6    at least 6 h before
                 last  just before the hour began
     proj_soc  the battery % the brain projected for the END of the hour, at the
               same leads (d1 is "23 h or more": the projection runs 24 h ahead)
     actuals   from the minute-by-minute recording: mean irradiance (W/m²),
               outdoor temperature, solar delivered and available (kWh), load,
               battery charged/discharged, battery % at the end of the hour, and the
               minutes the arrays were being throttled (available - delivered > 0.3 kW),
               and the DC string voltage: hourly mean, peak, and the first minute it
               showed light

   Rows go to <dir>/hourly-<year>.jsonl, one JSON object per line, in the add-on's
   config folder so Home Assistant backups include them. ~9,000 rows a year. */
"use strict";
const fs = require("fs");
const path = require("path");
const log = require("../log.js");

const HOUR = 3600 * 1000;
const LEADS = { d1: 24 * HOUR, h6: 6 * HOUR, last: 0 };
const PROJ_LEADS = { d1: 23 * HOUR, h6: 6 * HOUR };
const THROTTLED_KW = 0.3;
const DC_LIGHT_V = 50;   // string voltage that means the panels see light

class HourLog {
  constructor({ dir, state } = {}) {
    this.dir = dir;
    this.vintages = (state && state.vintages) || {};   // hour start (ms, as string) -> { forecast: {d1,h6,last}, proj_soc: {d1,h6} }
    this.lastClosed = state && Number.isFinite(state.lastClosed) ? state.lastClosed : null;   // start of the last hour written
  }

  /** Every forecast refresh: remember each future hour's kWh at each lead. */
  noteForecast(nowMs, hourly) {
    for (const h of hourly || []) {
      const lead = h.t - nowMs;
      if (lead < 0 || !Number.isFinite(h.kwh)) continue;
      const v = (this.vintages[h.t] = this.vintages[h.t] || {});
      v.forecast = v.forecast || {};
      for (const [k, min] of Object.entries(LEADS)) if (lead >= min) v.forecast[k] = +h.kwh.toFixed(4);
    }
  }

  /** A projection (timeline steps): the battery % it gives for each hour's end. */
  noteProjection(nowMs, steps) {
    for (const s of steps || []) {
      if (s.t % HOUR !== 0 || !Number.isFinite(s.soc)) continue;   // hour boundaries only
      const hourStart = s.t - HOUR, lead = hourStart - nowMs;
      if (lead < 0) continue;
      const v = (this.vintages[hourStart] = this.vintages[hourStart] || {});
      v.proj_soc = v.proj_soc || {};
      for (const [k, min] of Object.entries(PROJ_LEADS)) if (lead >= min) v.proj_soc[k] = +s.soc.toFixed(2);
    }
  }

  /** Write a row for every hour that has ended since the last one written.
      samples: the recorder's minute samples (t, soc, loadKw, pvKw, availKw, battKw, irr, tout). */
  closeHours(nowMs, samples) {
    const current = Math.floor(nowMs / HOUR) * HOUR;
    if (this.lastClosed == null) this.lastClosed = current - HOUR;   // start with the hour now running
    // After a long outage only the last two days can have samples; don't write empty rows for the rest.
    if (current - this.lastClosed > 48 * HOUR) this.lastClosed = current - 48 * HOUR;
    const rows = [];
    for (let h = this.lastClosed + HOUR; h < current; h += HOUR) {
      rows.push(this.row(h, samples.filter((s) => s.t >= h && s.t < h + HOUR)));
      this.lastClosed = h;
    }
    for (const r of rows) this.append(r);
    for (const k of Object.keys(this.vintages)) if (Number(k) <= this.lastClosed) delete this.vintages[k];
    return rows;
  }

  row(h, ss) {
    const v = this.vintages[h] || {};
    const mean = (k) => { const x = ss.map((s) => s[k]).filter(Number.isFinite); return x.length ? x.reduce((a, b) => a + b, 0) / x.length : null; };
    const kwh = (f) => { const x = ss.map(f).filter(Number.isFinite); return x.length ? +(x.reduce((a, b) => a + b, 0) / 60).toFixed(4) : null; };   // minute samples
    const r1 = (x, d = 1) => (x == null ? null : +x.toFixed(d));
    const last = [...ss].reverse().find((s) => Number.isFinite(s.soc));
    return {
      hour: new Date(h).toISOString(), local: localHour(h), samples: ss.length,
      forecast: v.forecast || {}, proj_soc: v.proj_soc || {},
      irradiance_wm2: r1(mean("irr"), 0), outdoor_c: r1(mean("tout")),
      pv_kwh: kwh((s) => s.pvKw), available_kwh: kwh((s) => s.availKw), load_kwh: kwh((s) => s.loadKw),
      battery_in_kwh: kwh((s) => (Number.isFinite(s.battKw) ? Math.max(0, s.battKw) : NaN)),
      battery_out_kwh: kwh((s) => (Number.isFinite(s.battKw) ? Math.max(0, -s.battKw) : NaN)),
      soc_end: last ? r1(last.soc, 2) : null,
      throttled_min: ss.filter((s) => Number.isFinite(s.availKw) && Number.isFinite(s.pvKw) && s.availKw - s.pvKw > THROTTLED_KW).length,
      // DC string voltage (mean of the inverters): its hourly mean and peak, and the
      // first minute of the hour it showed light (> DC_LIGHT_V): sunrise, before power.
      // minutes the irradiance sensor looked blocked and its last good level was held
      irradiance_held_min: +ss.reduce((t, s) => t + (Number.isFinite(s.irrHeld) ? s.irrHeld : 0), 0).toFixed(1),
      dc_volts_mean: r1(mean("dcV"), 0),
      dc_volts_max: (() => { const x = ss.map((s) => s.dcV).filter(Number.isFinite); return x.length ? Math.round(Math.max(...x)) : null; })(),
      dc_light_min: (() => { const s = ss.find((x) => x.dcV > DC_LIGHT_V); return s ? Math.round((s.t - h) / 60000) : null; })(),
    };
  }

  file(h) { return path.join(this.dir, `hourly-${new Date(h).getFullYear()}.jsonl`); }

  /** Something worth a line of its own (e.g. a blocked irradiance sensor), in events-<year>.jsonl. */
  event(e) {
    if (!this.dir) return;
    const at = e.end || e.start || Date.now();
    const row = { at: new Date(at).toISOString(), local: localTime(at), ...e,
      ...(e.start ? { start: new Date(e.start).toISOString() } : {}), ...(e.end ? { end: new Date(e.end).toISOString() } : {}) };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(path.join(this.dir, `events-${new Date(at).getFullYear()}.jsonl`), JSON.stringify(row) + "\n");
    } catch (err) { log.warn("could not write the events log", err.message); }
  }

  append(row) {
    if (!this.dir) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.file(Date.parse(row.hour)), JSON.stringify(row) + "\n");
    } catch (e) { log.warn("could not write the hourly log", e.message); }
  }

  /** Rows from the last `days` days, oldest first. */
  read(days, nowMs = Date.now()) {
    if (!this.dir) return [];
    const from = nowMs - days * 24 * HOUR, out = [];
    for (let y = new Date(from).getFullYear(); y <= new Date(nowMs).getFullYear(); y++) {
      let text = "";
      try { text = fs.readFileSync(path.join(this.dir, `hourly-${y}.jsonl`), "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); if (Date.parse(r.hour) >= from) out.push(r); } catch { /* a torn last line */ }
      }
    }
    return out;
  }

  toJSON() { return { vintages: this.vintages, lastClosed: this.lastClosed }; }
}

/** "2026-11-10 12:53:08" in the process time zone. */
function localTime(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** "2026-11-10 13:00" in the process time zone, for reading the file by eye. */
function localHour(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:00`;
}

module.exports = { HourLog, LEADS, PROJ_LEADS };
