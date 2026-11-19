/* Turns zone decisions into climate commands: hvac mode and setpoint for climate
   entities, on/off for valves and pumps, and a shared heat source that runs while
   any of its zones calls.

   Guards, as in sinks/actuator.js:
     - dry run: decide and advise, call nothing;
     - minimum run and off times per output (compressors and pumps must not
       short-cycle); a heat <-> cool change counts as stopping;
     - a zone being held at a person's setting (mode "manual") is not commanded.
   Every command the brain sends is remembered (`commanded`) so a later change on
   the unit that the brain didn't make can be recognised as a person's. */
"use strict";
const log = require("../log.js");

const half = (x) => Math.round(x * 2) / 2;

class ClimateActuator {
  constructor({ ha }) {
    this.ha = ha;
    this.st = new Map();          // key -> { on, mode, setpoint, changedAt }
    this.commanded = new Map();   // entity -> { mode, setpoint, at }
    this.advice = new Map();      // entity -> last advisory line
  }

  _state(key, reading, now) {
    if (!this.st.has(key)) {
      // First sight: start from what the unit is doing, with no dwell owed.
      this.st.set(key, { on: !!(reading && reading.on), mode: reading && reading.on ? reading.mode : "off",
                         setpoint: reading ? reading.setpoint : NaN, changedAt: now - 1e9 });
    }
    return this.st.get(key);
  }

  /** Apply minimum run/off times. Returns the wanted state, or the held one. */
  _dwell(s, want, o, now) {
    const changing = want.on !== s.on || (want.on && s.on && want.mode !== s.mode);
    if (!changing) return { want, held: null };
    const since = (now - s.changedAt) / 1000;
    if (s.on && since < o.min_on_s) return { want: { on: true, mode: s.mode, setpoint: s.setpoint }, held: `minimum run (${Math.ceil(o.min_on_s - since)} s left)` };
    if (!s.on && want.on && since < o.min_off_s) return { want: { on: false, mode: "off", setpoint: s.setpoint }, held: `minimum off (${Math.ceil(o.min_off_s - since)} s left)` };
    return { want, held: null };
  }

  async _send(entity, want, { dryRun, now, zone, why }, out) {
    const dom = entity.split(".")[0];
    const desc = dom === "climate" ? (want.on ? `${want.mode}${Number.isFinite(want.setpoint) ? ` ${want.setpoint} °C` : ""}` : "off") : want.on ? "on" : "off";
    if (dryRun) {
      const line = `would set ${desc}`;
      if (this.advice.get(entity) !== line) log.info(`DRY RUN climate ${zone}: would set ${entity} ${desc} — ${why}`);
      this.advice.set(entity, line);
      out.push({ zone, entity, action: "dry_run", detail: desc });
      return true;
    }
    try {
      if (dom === "climate") {
        if (want.on && Number.isFinite(want.setpoint)) await this.ha.callService("climate", "set_temperature", entity, { temperature: want.setpoint, hvac_mode: want.mode });
        else if (want.on) await this.ha.callService("climate", "set_hvac_mode", entity, { hvac_mode: want.mode });   // a heat source: its own setpoint stands
        else await this.ha.callService("climate", "set_hvac_mode", entity, { hvac_mode: "off" });
      } else if (dom === "valve") await this.ha.callService("valve", want.on ? "open_valve" : "close_valve", entity);
      else await this.ha.callService(dom, want.on ? "turn_on" : "turn_off", entity);
      this.commanded.set(entity, { mode: want.on ? want.mode : "off", setpoint: want.setpoint, at: now });
      this.advice.set(entity, `set ${desc}`);
      log.info(`climate ${zone}: ${entity} ${desc} — ${why}`);
      out.push({ zone, entity, action: "set", detail: desc });
      return true;
    } catch (e) {
      log.error(`climate ${zone}: failed to set ${entity} ${desc}`, e.message);
      out.push({ zone, entity, action: "error", detail: e.message });
      return false;
    }
  }

  /**
   * @param {object[]} zones     normalised zones
   * @param {Map} decisions      zone id -> resolve() decision
   * @param {Map} readings       zone id -> readZone() result
   * @param {{dryRun: boolean, now: number}} opt
   */
  async apply(zones, decisions, readings, { dryRun, now = Date.now() }) {
    const out = [];
    const sources = new Map();   // source entity -> { on, o, zone }
    for (const z of zones) {
      const d = decisions.get(z.id), r = readings.get(z.id) || { outputs: [] };
      if (!d || d.mode === "manual") continue;
      for (const [i, o] of z.outputs.entries()) {
        if (!o.entity) continue;
        const key = `${z.id}#${i}`, reading = r.outputs[i];
        const s = this._state(key, reading, now);
        const sp = Number.isFinite(d.setpoint) ? half(d.setpoint) : s.setpoint;
        let want;
        if (o.entity.startsWith("climate.")) {
          const mode = o.modes.includes(d.mode) ? d.mode : "off";
          want = { on: mode !== "off", mode, setpoint: sp };
        } else {
          // A valve or pump: switch around the setpoint with a little hysteresis.
          const T = r.temp, heat = d.mode === "heat" && Number.isFinite(T) && Number.isFinite(sp);
          const on = heat && (T < sp - 0.2 || (s.on && T < sp + 0.3));
          want = { on, mode: on ? "heat" : "off", setpoint: sp };
        }
        const { want: w, held } = this._dwell(s, want, o, now);
        if (held) out.push({ zone: z.id, entity: o.entity, action: "held", detail: held });
        const differs = w.on !== s.on || (w.on && (w.mode !== s.mode || (o.entity.startsWith("climate.") && w.setpoint !== s.setpoint)));
        if (differs && await this._send(o.entity, w, { dryRun, now, zone: z.id, why: d.reason }, out)) {
          if (w.on !== s.on || w.mode !== s.mode) s.changedAt = now;
          Object.assign(s, { on: w.on, mode: w.on ? w.mode : "off", setpoint: w.setpoint });
        }
        if (o.source_entity) {
          const src = sources.get(o.source_entity) || { on: false, o, zone: z.id };
          src.on = src.on || (s.on && s.mode === "heat");
          sources.set(o.source_entity, src);
        }
      }
    }
    // A shared heat source runs while any of its zones calls for heat.
    for (const [entity, src] of sources) {
      const key = `source:${entity}`, s = this._state(key, null, now);
      const { want: w, held } = this._dwell(s, { on: src.on, mode: src.on ? "heat" : "off", setpoint: s.setpoint }, src.o, now);
      if (held) out.push({ zone: src.zone, entity, action: "held", detail: held });
      if (w.on !== s.on && await this._send(entity, { ...w, setpoint: NaN },
        { dryRun, now, zone: src.zone, why: w.on ? "a zone calls for heat" : "no zone calls for heat" }, out)) {
        s.changedAt = now; s.on = w.on; s.mode = w.mode;
      }
    }
    return out;
  }
}

module.exports = { ClimateActuator };
