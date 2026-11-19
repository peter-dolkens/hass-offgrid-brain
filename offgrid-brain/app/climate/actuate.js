/* Turns zone decisions into climate commands: hvac mode and setpoint for climate
   entities, on/off for valves and pumps, and a shared heat source that runs while
   any of its zones calls.

   It reconciles with reality every tick: what each unit is actually doing (its
   reading) against what the brain wants. Anything that differs is sent again, with
   a backoff (1 min doubling to 30 min) so a unit that ignores or rejects commands
   isn't hammered.

   Guards, as in sinks/actuator.js:
     - dry run (or a zone's advise_only): decide and advise, call nothing, change nothing;
     - minimum run and off times per output, timed from when the unit was SEEN to
       change (persisted, so a restart doesn't forget a dwell; a unit seen for the
       first time is assumed to owe one); heat <-> cool goes through off;
     - setpoints rounded to the unit's own step and clamped to its range;
     - a zone held at a person's setting (mode "manual") is not commanded, but its
       running valves still keep a shared heat source on.
   Every command is remembered (`commanded`, persisted) so a later change on the
   unit that the brain didn't make can be recognised as a person's. */
"use strict";
const log = require("../log.js");

const BACKOFF_MS = [60e3, 120e3, 300e3, 600e3, 1800e3];
const PROTECT_CAP_MS = 300e3;   // protection is resent at least every 5 min
const ERROR_RETRY_MS = 60e3;    // a failed call (HA down, socket closed) is retried every minute

/** A setpoint the unit will accept: its step, inside its range. */
function fitSetpoint(sp, reading) {
  if (!Number.isFinite(sp)) return sp;
  const step = reading && reading.step > 0 ? reading.step : 0.5;
  const lo = reading && Number.isFinite(reading.minTemp) ? reading.minTemp : -Infinity;
  const hi = reading && Number.isFinite(reading.maxTemp) ? reading.maxTemp : Infinity;
  const v = Math.round(sp / step) * step;
  return Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100;
}

class ClimateActuator {
  constructor({ ha, state = {} } = {}) {
    this.ha = ha;
    this.obs = new Map();         // output key -> { on, mode, changedAt } as SEEN on the unit
    this.commanded = new Map();   // entity -> { mode, setpoint, at, step }
    this.resend = new Map();      // entity -> { tries, next }
    this.advice = new Map();      // entity -> last advisory line
    for (const [k, v] of Object.entries((state && state.obs) || {})) {
      if (v && typeof v.on === "boolean" && Number.isFinite(v.changedAt)) this.obs.set(k, { on: v.on, mode: v.mode || "off", changedAt: v.changedAt });
    }
    for (const [k, v] of Object.entries((state && state.commanded) || {})) {
      if (v && typeof v.mode === "string" && Number.isFinite(v.at)) this.commanded.set(k, v);
    }
  }

  toJSON() { return { obs: Object.fromEntries(this.obs), commanded: Object.fromEntries(this.commanded) }; }

  /** Forget outputs no longer configured. */
  retain(keys, entities) {
    for (const k of this.obs.keys()) if (!keys.has(k)) this.obs.delete(k);
    for (const k of this.commanded.keys()) if (!entities.has(k)) this.commanded.delete(k);
  }

  /** Track what the unit is seen doing; its last change time drives the dwell. */
  _observe(key, actual, now) {
    const s = this.obs.get(key);
    if (!s) { const n = { ...actual, changedAt: now }; this.obs.set(key, n); return n; }   // first sight: a dwell is owed
    if (s.on !== actual.on || (actual.on && s.mode !== actual.mode)) { s.on = actual.on; s.mode = actual.mode; s.changedAt = now; }
    return s;
  }

  /** Minimum run/off times. Returns the state to aim for and why it was held, if it was.
      While held, the unit keeps its own current setpoint (`actualSp`): a held heat unit
      must not be sent the cooling side's setpoint. */
  _dwell(s, want, o, now, actualSp = NaN) {
    const since = (now - s.changedAt) / 1000;
    // heat <-> cool goes through off.
    if (s.on && want.on && want.mode !== s.mode) want = { on: false, mode: "off", setpoint: want.setpoint, via: true };
    if (s.on && !want.on && since < o.min_on_s) return { want: { on: true, mode: s.mode, setpoint: actualSp }, held: `minimum run (${Math.ceil(o.min_on_s - since)} s left)` };
    if (!s.on && want.on && since < o.min_off_s) return { want: { on: false, mode: "off", setpoint: want.setpoint }, held: `minimum off (${Math.ceil(o.min_off_s - since)} s left)` };
    return { want, held: want.via ? "changing between heat and cool: off first" : null };
  }

  async _send(entity, want, reading, { dryRun, now, zone, why, level }, out) {
    const dom = entity.split(".")[0];
    const desc = dom === "climate" ? (want.on ? `${want.mode}${Number.isFinite(want.setpoint) ? ` ${want.setpoint} °C` : ""}` : "off") : want.on ? "on" : "off";
    if (dryRun) {
      const line = `would set ${desc}`;
      if (this.advice.get(entity) !== line) log.info(`DRY RUN climate ${zone}: would set ${entity} ${desc} — ${why}`);
      this.advice.set(entity, line);
      out.push({ zone, entity, action: "dry_run", detail: desc });
      return;
    }
    // Backoff for a unit that doesn't follow. A different want starts afresh.
    let rs = this.resend.get(entity);
    if (rs && rs.desc !== desc) rs = null;
    if (rs && now < rs.next) { out.push({ zone, entity, action: "waiting", detail: `${desc}: resend in ${Math.ceil((rs.next - now) / 1000)} s` }); return; }
    const tries = rs ? rs.tries + 1 : 1;
    const wait = Math.min(BACKOFF_MS[Math.min(tries - 1, BACKOFF_MS.length - 1)], level === "protect" ? PROTECT_CAP_MS : Infinity);
    this.resend.set(entity, { tries, desc, next: now + wait });
    try {
      if (dom === "climate") {
        if (want.on && Number.isFinite(want.setpoint)) await this.ha.callService("climate", "set_temperature", entity, { temperature: want.setpoint, hvac_mode: want.mode });
        else if (want.on) await this.ha.callService("climate", "set_hvac_mode", entity, { hvac_mode: want.mode });   // a heat source: its own setpoint stands
        else await this.ha.callService("climate", "set_hvac_mode", entity, { hvac_mode: "off" });
      } else if (dom === "valve") await this.ha.callService("valve", want.on ? "open_valve" : "close_valve", entity);
      else await this.ha.callService(dom, want.on ? "turn_on" : "turn_off", entity);
      this.commanded.set(entity, { mode: want.on ? want.mode : "off", setpoint: want.setpoint, at: now, step: reading && reading.step });
      this.advice.set(entity, `set ${desc}${tries > 1 ? ` (attempt ${tries})` : ""}`);
      log.info(`climate ${zone}: ${entity} ${desc}${tries > 1 ? ` (attempt ${tries}: the unit hadn't followed)` : ""} — ${why}`);
      out.push({ zone, entity, action: "set", detail: desc, attempt: tries });
    } catch (e) {
      // A failure says nothing about the unit (HA down, socket closed): retry in a
      // minute, without escalating the backoff.
      this.resend.set(entity, { tries: tries - 1, desc, next: now + ERROR_RETRY_MS });
      log.error(`climate ${zone}: failed to set ${entity} ${desc}`, e.message);
      this.advice.set(entity, `failed to set ${desc}: ${e.message}`);
      out.push({ zone, entity, action: "error", detail: e.message });
    }
  }

  /**
   * @param {object[]} zones     normalised zones
   * @param {Map} decisions      zone id -> resolve() decision
   * @param {Map} readings       zone id -> readZone() result
   * @param {{dryRun: boolean, now: number, get?: Function}} opt  get(entity) reads a heat source's state
   */
  async apply(zones, decisions, readings, { dryRun, now = Date.now(), get = () => null }) {
    const out = [];
    const sources = new Map();   // source entity -> { on, o, zone }
    const callFor = (o, zone, on) => {
      if (!o.source_entity) return;
      const src = sources.get(o.source_entity) || { on: false, o, zone };
      src.on = src.on || on;
      sources.set(o.source_entity, src);
    };
    for (const z of zones) {
      const d = decisions.get(z.id), r = readings.get(z.id) || { outputs: [] };
      for (const [i, o] of z.outputs.entries()) {
        if (!o.entity) continue;
        const key = `${z.id}#${i}`, reading = r.outputs[i];
        if (!reading || !reading.available) { callFor(o, z.id, false); this.advice.set(o.entity, "unavailable"); continue; }
        const actual = { on: !!reading.on, mode: reading.on ? reading.mode : "off" };
        const s = this._observe(key, actual, now);
        // Not ours to command: held at a person's setting, advice-only, or no decision.
        // Its running valve still needs the shared source.
        if (!d || d.mode === "manual" || z.advise_only) { callFor(o, z.id, actual.on && actual.mode === "heat"); continue; }
        const isClimate = o.entity.startsWith("climate.");
        let want;
        if (isClimate) {
          const mode = o.modes.includes(d.mode) ? d.mode : "off";
          want = { on: mode !== "off", mode, setpoint: fitSetpoint(d.setpoint, reading) };
        } else if (d.state === "fallback" || !Number.isFinite(r.temp)) {
          want = { ...actual };   // no room temperature and no thermostat: leave the valve as it is
        } else {
          // A valve or pump: switch around the setpoint with a little hysteresis.
          const T = r.temp, sp = d.setpoint, heat = d.mode === "heat" && Number.isFinite(sp);
          const on = heat && (T < sp - 0.2 || (actual.on && T < sp + 0.3));
          want = { on, mode: on ? "heat" : "off", setpoint: NaN };
        }
        const { want: w, held } = this._dwell(s, want, o, now, reading.setpoint);
        if (held) out.push({ zone: z.id, entity: o.entity, action: "held", detail: held });
        const tol = (reading.step || 0.5) / 2 + 1e-6;
        const matches = w.on === actual.on && (!w.on || (w.mode === actual.mode && (!isClimate || !Number.isFinite(w.setpoint) || Math.abs(w.setpoint - reading.setpoint) <= tol)));
        if (matches) { this.resend.delete(o.entity); if (dryRun) this.advice.set(o.entity, "as wanted"); }
        else await this._send(o.entity, w, reading, { dryRun, now, zone: z.id, why: d.reason, level: d.level }, out);
        callFor(o, z.id, w.on && w.mode === "heat");
      }
    }
    // A shared heat source runs while any of its zones calls for heat.
    for (const [entity, src] of sources) {
      const st = get(entity);
      if (!st || st.state === "unavailable" || st.state === "unknown") { this.advice.set(entity, "unavailable"); continue; }
      const actual = { on: st.state !== "off", mode: st.state === "off" ? "off" : "heat" };
      const s = this._observe(`source:${entity}`, actual, now);
      const { want: w, held } = this._dwell(s, { on: src.on, mode: src.on ? "heat" : "off", setpoint: NaN }, src.o, now);
      if (held) out.push({ zone: src.zone, entity, action: "held", detail: held });
      if (w.on === actual.on) { this.resend.delete(entity); continue; }
      await this._send(entity, w, null, { dryRun, now, zone: src.zone, why: w.on ? "a zone calls for heat" : "no zone calls for heat" }, out);
    }
    return out;
  }
}

module.exports = { ClimateActuator, fitSetpoint };
