/* Storm signal, from Home Assistant: BoM warnings and forecast, and Blitzortung
   lightning strikes. Three policy variables come out of it:

     storm        1 when a storm is on the house now: an active BoM thunderstorm,
                  severe-weather or cyclone warning for the area, or lightning within
                  near_km in the last window_min minutes. Otherwise 0.
     storm_ahead  1 when BoM forecasts storms today or tomorrow (a lightning icon or
                  "storm" in the short summary), or `storm` is 1. Time to bank charge.
     lightning    km to the nearest strike in the last window_min minutes; 999 none.

   Sources (all optional; a missing one simply never raises the signal):
     storm_warnings      BoM warnings sensor (bureau_of_meteorology), its
                         `warnings` attribute: [{ type, title, phase, expiry_time }]
     storm_forecast      BoM forecast entity prefix, e.g. sensor.tugrabakh: reads
                         <prefix>_mdi_icon_0/1 and <prefix>_short_text_0/1
     lightning_distance  Blitzortung's distance to the latest strike (km)
     lightning_counter   Blitzortung's strike counter: each rise is a strike at the
                         distance reported with it */
"use strict";

const MIN = 60 * 1000;
const STORM_WARNING = /thunderstorm|severe[ _]weather|cyclone/i;
const STORM_FORECAST = /storm/i;
const NONE_KM = 999;

/** Active storm warnings out of the BoM warnings sensor's attribute list. */
function stormWarnings(list, nowMs = Date.now()) {
  return (Array.isArray(list) ? list : []).filter((w) => {
    if (!w || typeof w !== "object") return false;
    if (/marine|coastal waters/i.test(`${w.type || ""} ${w.title || ""}`)) return false;
    if (!STORM_WARNING.test(`${w.type || ""} ${w.title || ""} ${w.short_title || ""}`)) return false;
    if (/cancel|final/i.test(w.phase || "")) return false;
    const exp = Date.parse(w.expiry_time || "");
    return !(Number.isFinite(exp) && exp < nowMs);
  });
}

/** Does the forecast for a day say storms? */
const stormForecast = (icon, text) => /lightning/i.test(icon || "") || STORM_FORECAST.test(text || "");

class StormWatch {
  constructor({ ha, sources = {}, near_km = 30, window_min = 30 } = {}) {
    this.ha = ha;
    this.strikes = [];        // [[ms, km]] within the window
    this.lastCount = null;
    this.configure({ sources, near_km, window_min });
  }

  configure({ sources = {}, near_km = 30, window_min = 30 } = {}) {
    this.src = {
      warnings: sources.storm_warnings || "", forecast: sources.storm_forecast || "",
      distance: sources.lightning_distance || "", counter: sources.lightning_counter || "",
    };
    this.nearKm = near_km;
    this.windowMs = window_min * MIN;
  }

  /** Entities to mirror from HA. */
  entities() {
    const f = this.src.forecast;
    return [this.src.warnings, this.src.distance, this.src.counter,
      ...(f ? [0, 1].flatMap((d) => [`${f}_mdi_icon_${d}`, `${f}_short_text_${d}`]) : [])].filter(Boolean);
  }

  state(id) { return id ? this.ha.states.get(id) : null; }

  /** One tick: note new strikes, then the variables and what raised them. */
  read(nowMs = Date.now()) {
    const counter = this.state(this.src.counter), dist = this.state(this.src.distance);
    const count = counter ? Number(counter.state) : NaN, km = dist ? Number(dist.state) : NaN;
    if (Number.isFinite(count)) {
      // A rise is a strike (or several, at the latest one's distance). A drop is HA restarting the count.
      if (this.lastCount != null && count > this.lastCount && Number.isFinite(km)) this.strikes.push([nowMs, km]);
      this.lastCount = count;
    }
    this.strikes = this.strikes.filter(([t]) => nowMs - t <= this.windowMs);
    const nearest = this.strikes.length ? Math.min(...this.strikes.map(([, k]) => k)) : NONE_KM;

    const w = this.state(this.src.warnings);
    const warnings = stormWarnings(w && w.attributes && w.attributes.warnings, nowMs);

    const forecastDays = [];
    if (this.src.forecast) {
      for (const d of [0, 1]) {
        const icon = this.state(`${this.src.forecast}_mdi_icon_${d}`), text = this.state(`${this.src.forecast}_short_text_${d}`);
        if (stormForecast(icon && icon.state, text && text.state)) forecastDays.push({ day: d, text: text ? text.state : "" });
      }
    }

    const storm = warnings.length > 0 || nearest <= this.nearKm ? 1 : 0;
    return {
      vars: { storm, storm_ahead: storm || forecastDays.length ? 1 : 0, lightning: +nearest.toFixed(1) },
      detail: {
        warnings: warnings.map((x) => x.title || x.short_title || x.type),
        forecast: forecastDays,
        strikes: this.strikes.length, nearestKm: nearest === NONE_KM ? null : nearest, nearKm: this.nearKm,
        configured: Boolean(this.src.warnings || this.src.forecast || this.src.counter),
      },
    };
  }
}

module.exports = { StormWatch, stormWarnings, stormForecast, NONE_KM };
