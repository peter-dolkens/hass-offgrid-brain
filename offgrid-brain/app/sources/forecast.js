/* Solar forecast, from Home Assistant's Energy integration.

   Every forecast integration HA knows (Forecast.Solar, Solcast, ...) answers the
   `energy/solar_forecast` WebSocket command with hourly Wh per config entry, for
   whichever entries are attached to a solar source in the Energy dashboard. We
   sum them into one hourly series, so adding a roof plane in HA needs no change
   here.

   The brain uses it two ways:
     worstDayKwh  the smaller of today's and tomorrow's totals: sim.js's autonomy
                  denominator banks battery ahead of the WORST upcoming day, not
                  the average, so a sunny tomorrow can't mask a dull today
     hourly       the projection on the Live timeline */
"use strict";
const log = require("../log.js");

const HOUR = 3600 * 1000;

/** Sum `energy/solar_forecast`'s {entry: {wh_hours: {iso: Wh}}} into [{t, kwh}] by hour. */
function sumForecasts(result) {
  const byHour = new Map();
  for (const entry of Object.values(result || {})) {
    for (const [iso, wh] of Object.entries((entry && entry.wh_hours) || {})) {
      const t = Math.floor(Date.parse(iso) / HOUR) * HOUR;
      if (!Number.isFinite(t) || !Number.isFinite(wh)) continue;
      byHour.set(t, (byHour.get(t) || 0) + wh / 1000);
    }
  }
  return [...byHour].sort((a, b) => a[0] - b[0]).map(([t, kwh]) => ({ t, kwh }));
}

/** Local-date key ("2026-11-10") of an epoch ms, in the process time zone. */
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** Daily totals of an hourly series: [{date, kwh}] in date order. */
function dailyTotals(hourly) {
  const m = new Map();
  for (const h of hourly) m.set(dayKey(h.t), (m.get(dayKey(h.t)) || 0) + h.kwh);
  return [...m].sort().map(([date, kwh]) => ({ date, kwh }));
}

class SolarForecast {
  constructor({ ha, refreshMinutes = 15 }) {
    this.ha = ha;
    this.refreshMs = refreshMinutes * 60 * 1000;
    this.hourly = [];
    this.entries = 0;
    this.updated = 0;
    this.timer = null;
  }

  start() {
    const run = () => this.refresh().catch((e) => log.debug("solar forecast refresh failed", e.message));
    this.timer = setInterval(run, this.refreshMs);
    run();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async refresh() {
    if (!this.ha.ready) return;
    const result = await this.ha.send({ type: "energy/solar_forecast" });
    const hourly = sumForecasts(result);
    const entries = Object.keys(result || {}).length;
    if (entries !== this.entries) log.info(`solar forecast: ${entries} forecast ${entries === 1 ? "entry" : "entries"} attached in the Energy dashboard`);
    this.entries = entries;
    this.hourly = hourly;
    this.updated = Date.now();
  }

  /** What the tick needs: worst full day today/tomorrow, the next 24 h, and the age. */
  read(now = Date.now()) {
    const ageSec = this.updated ? (now - this.updated) / 1000 : Infinity;
    if (!this.hourly.length) return { worstDayKwh: NaN, next24Kwh: NaN, days: [], ageSec, entries: this.entries };
    const today = dayKey(now), tomorrow = dayKey(now + 24 * HOUR);
    const days = dailyTotals(this.hourly).filter((d) => d.date >= today);
    const pick = days.filter((d) => d.date === today || d.date === tomorrow).map((d) => d.kwh);
    const from = Math.floor(now / HOUR) * HOUR;
    const next24Kwh = this.hourly.filter((h) => h.t >= from && h.t < from + 24 * HOUR).reduce((a, h) => a + h.kwh, 0);
    return { worstDayKwh: pick.length ? Math.min(...pick) : NaN, next24Kwh, days, ageSec, entries: this.entries };
  }

  /** Hourly kWh between two epoch ms, for the timeline. */
  between(from, to) { return this.hourly.filter((h) => h.t >= from && h.t < to); }
}

/* A second forecast kept for comparison, not for planning: Solcast publishes its
   hour-by-hour forecast for today and tomorrow as the `detailedHourly` attribute of
   <prefix>_forecast_today / _forecast_tomorrow, each entry
   { period_start, pv_estimate, pv_estimate10, pv_estimate90 } in kW for the hour. */
function parseDetailedHourly(states) {
  const out = [];
  for (const st of states) {
    for (const h of (st && st.attributes && st.attributes.detailedHourly) || []) {
      const t = Date.parse(h.period_start);
      if (!Number.isFinite(t) || !Number.isFinite(h.pv_estimate)) continue;
      out.push({ t, kwh: h.pv_estimate, p10: h.pv_estimate10, p90: h.pv_estimate90 });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

class CompareForecast {
  constructor({ ha, prefix }) { this.ha = ha; this.setPrefix(prefix); }
  setPrefix(prefix) {
    this.prefix = prefix || "";
    this.entities = this.prefix ? [`${this.prefix}_forecast_today`, `${this.prefix}_forecast_tomorrow`] : [];
  }
  /** Hourly [{t, kwh, p10, p90}] from the tracked entities' attributes. */
  hourly() { return parseDetailedHourly(this.entities.map((e) => this.ha.states.get(e))); }
}

module.exports = { SolarForecast, CompareForecast, sumForecasts, dailyTotals, parseDetailedHourly };
