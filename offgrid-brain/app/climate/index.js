/* ClimateBrain: the one object main.js talks to.

     configure(settings.climate, { toutEntity })   zones and options (live)
     entities()                    what to mirror from HA
     tick(now, { tout, sun, soc, irradiance })  read zones, learn, plan; returns plans
     expand(policy)                the policy with climate entries made walkable
     resolve(result, shadowFn)     one decision per zone from the dispatch walk
     apply({ dryRun })             command the outputs (advise only in dry run)
     markFailed()                  a tick failed: let go of the zones' devices
     expandAt(policy, t, ctx, now) the same expansion for a projected moment
     setOutlook(future, now)       the low-case projection, for soak/coast choices
     snapshot() / toJSON()         for the panel, MQTT and /data

   Learning (preferences, occupancy, thermal model, consumption curves) is in
   learn.js / thermal.js / consumption.js; planning in plan.js; the ladder in
   ladder.js; commands in actuate.js. This file wires readings into them. */
"use strict";
const log = require("../log.js");
const Zones = require("./zones.js");
const { Preferences, Occupancy } = require("./learn.js");
const { ThermalModel } = require("./thermal.js");
const { ConsumptionCurves, attribute } = require("./consumption.js");
const { planZone, plain } = require("./plan.js");
const Ladder = require("./ladder.js");
const { ClimateActuator } = require("./actuate.js");
const { houseOcc } = require("../policy/context.js");

const STATE_VERSION = 2;
const MIN = 60000, HOUR = 60 * MIN;
const WINDOW_MS = 15 * MIN;            // thermal-model sample window
const UNRESPONSIVE_MS = 10 * MIN;      // running by its own account (or ours) but ~0 W this long
const LAG_TAU_H = 2;                   // hydronic heat lag smoothing

const priorAt = (t) => (houseOcc(new Date(t).getHours()) ? 0.6 : 0.2);
const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});

/** A learning context: what was last seen, partial windows. Live ticks and the
    history replay each have their own, so seeding can't confuse the live view. */
const newCtx = () => ({ seen: new Map(), acc: new Map(), presentAt: new Map(), openSince: new Map(),
  holdSampleAt: new Map(), curveAt: new Map(), energy: new Map(), quiet: new Map(), loud: new Map(), lag: new Map() });

/** Is this setting the brain's own command? Commands are sent on the unit's step, so
    anything a step away (a person's one press) is not: under half a step matches. */
function sameAsCommanded(cmd, cur, step = 0.5) {
  if (!cmd || cmd.mode !== cur.mode) return false;
  if (cur.mode === "off" || !Number.isFinite(cmd.setpoint)) return true;
  return Math.abs(cmd.setpoint - cur.setpoint) < (cmd.step || step) / 2;
}

// How much a change teaches, by who made it.
const WEIGHT = { human: 1, unknown: 0.3 };

class ClimateBrain {
  constructor({ ha, state = {}, actuator } = {}) {
    state = obj(state);
    if (Number.isFinite(state.version) && state.version > STATE_VERSION) {
      log.warn(`climate: learned state is from a newer version (${state.version}); starting fresh`);
      state = {};
    }
    this.ha = ha;
    this.get = (id) => (ha && ha.entity ? ha.entity(id) : null);
    this.prefs = new Preferences(state.prefs);
    this.occ = new Occupancy(state.occ);
    this.curves = new ConsumptionCurves(state.curves);
    this.modelState = obj(state.models);
    this.models = new Map();
    this.seeded = obj(state.seeded);
    this.overrides = obj(state.overrides);
    this.latch = obj(state.latch);
    this.baselines = obj(state.baselines);
    this.actuator = actuator || new ClimateActuator({ ha, state: state.actuator });
    this.cfg = Zones.normalise({});
    this.zones = [];
    this.live = newCtx();
    this.plans = new Map(); this.readings = new Map(); this.decisions = new Map();
    this.flags = new Map(); this.metered = new Map(); this.prevSide = new Map(); this.humid = new Map();
    this.suppress = new Set();
    this.outlook = {};
    this.toutForecast = [];      // [{ t, temp }] hourly
    this.toutDaily = [];         // [{ t, min, max }]
    this.toutProfile = null;     // (t) => °C from the recorded last day
    this.lastTout = NaN;
    this.forecastAt = 0;
    this.lastAdvisories = [];
    this.warnings = [];
    this.failed = false;
    this.seeding = false;
  }

  get enabled() { return this.cfg.enabled && this.zones.length > 0; }

  configure(cfg, { toutEntity = "" } = {}) {
    this.cfg = Zones.normalise(cfg);
    this.zones = this.cfg.enabled ? this.cfg.zones : [];
    this.toutEntity = toutEntity;
    for (const z of this.zones) {
      const m = this.models.get(z.id);
      if (!m || m.area_m2 !== z.area_m2) {
        this.models.set(z.id, new ThermalModel({ area_m2: z.area_m2, state: m ? m.toJSON() : this.modelState[z.id] }));
      }
    }
    // Forget zones (and outputs) that are gone, so a re-used id starts clean.
    if (this.cfg.enabled) {
      const ids = new Set(this.cfg.zones.map((z) => z.id));
      for (const store of [this.prefs, this.occ]) for (const id of Object.keys(store.z)) if (!ids.has(id)) store.forget(id);
      for (const map of [this.modelState, this.seeded, this.overrides, this.latch]) for (const id of Object.keys(map)) if (!ids.has(id)) delete map[id];
      for (const id of [...this.models.keys()]) if (!ids.has(id)) this.models.delete(id);
      const outs = this.cfg.zones.flatMap((z) => z.outputs.map((o, i) => ({ key: `${z.id}#${i}`, o })));
      this.curves.retain(outs.map((x) => x.o.entity));
      this.actuator.retain(new Set([...outs.map((x) => x.key), ...outs.filter((x) => x.o.source_entity).map((x) => `source:${x.o.source_entity}`)]),
        new Set(outs.flatMap((x) => [x.o.entity, x.o.source_entity]).filter(Boolean)));
    }
  }

  entities() {
    return [...new Set([...this.zones.flatMap(Zones.zoneEntities), this.cfg.presence_entity, this.cfg.weather_entity].filter(Boolean))];
  }

  // ---------------------------------------------------------------- readings
  /** Metered kW per output key (`zone#i`), attributing shared meters; an energy
      counter stands in for a missing power entity. */
  _metered(now, get, ctx) {
    const outs = [], srcOuts = [];
    for (const z of this.zones) z.outputs.forEach((o, i) => {
      const key = `${z.id}#${i}`, running = Zones.claimsRunning(get(o.entity));
      outs.push({ key, power_entity: o.power_entity, kw: o.kw, running, climateOnly: o.meter_climate_only });
      if (o.source_power_entity) srcOuts.push({ key, power_entity: o.source_power_entity, kw: o.kw, running, climateOnly: true });
    });
    const read = (e) => Zones.powerKwOf(get(e));
    const own = attribute(outs, read, this.baselines), src = attribute(srcOuts, read, this.baselines);
    const res = new Map();
    for (const z of this.zones) z.outputs.forEach((o, i) => {
      const key = `${z.id}#${i}`;
      let kw = own.get(key);
      if (!Number.isFinite(kw) && o.energy_entity) kw = this._fromEnergy(key, get(o.energy_entity), now, ctx);
      const s = src.has(key) ? src.get(key) : NaN;
      res.set(key, Number.isFinite(kw) || Number.isFinite(s) ? (Number.isFinite(kw) ? kw : 0) + (Number.isFinite(s) ? s : 0) : NaN);
    });
    return res;
  }

  /** kW from a kWh counter: the rate since an anchor at least a minute old (a counter
      that ticks every few seconds must not reset it), 0 after 30 min unchanged. */
  _fromEnergy(key, st, now, ctx) {
    if (!st || Zones.UNKNOWN.has(st.state)) return NaN;
    const unit = String((st.attributes || {}).unit_of_measurement || "kWh").toLowerCase();
    const kwh = parseFloat(st.state) * (unit === "wh" ? 0.001 : 1);
    if (!Number.isFinite(kwh)) return NaN;
    const e = ctx.energy.get(key);
    if (!e || kwh < e.kwh) { ctx.energy.set(key, { kwh, t: now, kw: NaN, changedAt: now }); return NaN; }
    if (kwh !== e.kwh) e.changedAt = now;
    const h = (now - e.t) / HOUR;
    if (h >= 1 / 60 && kwh !== e.kwh) {
      const kw = (kwh - e.kwh) / h;
      ctx.energy.set(key, { kwh, t: now, kw, changedAt: now });
      return kw;
    }
    return now - e.changedAt > 30 * MIN ? 0 : e.kw;
  }

  // ---------------------------------------------------------------- learning
  _learnSetpoint(zoneId, t, cur, weight) {
    if (cur.mode === "heat") this.prefs.observe(zoneId, t, "heat", cur.setpoint, weight);
    else if (cur.mode === "cool") this.prefs.observe(zoneId, t, "cool", cur.setpoint, weight);
    else if (cur.mode === "heat_cool" || cur.mode === "auto") {
      this.prefs.observe(zoneId, t, "heat", cur.low, weight);
      this.prefs.observe(zoneId, t, "cool", cur.high, weight);
    }
  }

  /** Who made a change, from Home Assistant's state context:
        "ours"       one of the brain's own calls (its context, or its HA user), or a
                     setting equal to its last command with no other user on it;
        "human"      a user other than the brain (the UI, an app);
        "automation" a context with a parent (an automation or script reacting to
                     something);
        "unknown"    a bare context (no user, no parent: a time- or sun-triggered
                     automation, or someone at the unit's own buttons), or none (the
                     recorder's history has no context).
      People teach; unknown teaches weakly and never holds as an override. */
  classify(cur, context, cmd, step) {
    const c = context && typeof context === "object" ? context : null;
    if (c) {
      if (this.ha && this.ha.ourContexts && c.id && this.ha.ourContexts.has(c.id)) return "ours";
      if (this.ha && this.ha.userId && c.user_id === this.ha.userId) return "ours";
      if (c.user_id) return "human";
    }
    if (sameAsCommanded(cmd, cur, step)) return "ours";
    if (c && c.parent_id) return "automation";
    return "unknown";
  }

  /** Everything learned from one zone's readings at time `now`. */
  _observe(z, r, now, tout, ctx, { live, away = false, irradiance = NaN }) {
    const cfg = this.cfg;
    // Occupancy history: only from real presence readings (unknown is not counted),
    // and not while the house is away (a holiday isn't the weekly pattern).
    if (z.presence_entities.length && !away) this.occ.observe(z.id, now, r.presence);
    if (r.presence === true) ctx.presentAt.set(z.id, now);

    // Windows: blocked once open for the delay.
    if (r.windowOpen) { if (!ctx.openSince.has(z.id)) ctx.openSince.set(z.id, now); }
    else ctx.openSince.delete(z.id);

    // People's setpoints, and overrides of the brain's.
    for (const [i, o] of z.outputs.entries()) {
      const out = r.outputs[i];
      if (!o.entity.startsWith("climate.") || !out || !out.available) continue;
      const cur = { mode: out.mode, setpoint: out.setpoint, low: out.low, high: out.high };
      const prev = ctx.seen.get(o.entity);
      ctx.seen.set(o.entity, cur);
      const cmd = this.actuator.commanded.get(o.entity);
      const step = out.step || 0.5;
      if (prev) {
        const moved = (a, b) => Number.isFinite(a) !== Number.isFinite(b) || (Number.isFinite(a) && Math.abs(a - b) >= Math.min(0.25, step / 2));
        const changed = prev.mode !== cur.mode || moved(prev.setpoint, cur.setpoint) || moved(prev.low, cur.low) || moved(prev.high, cur.high);
        if (changed) {
          // History replay has no context: its changes are at best "unknown".
          const who = this.classify(cur, live ? out.context : null, cmd, step);
          if (WEIGHT[who]) this._learnSetpoint(z.id, now, cur, WEIGHT[who] * (who === "human" && cmd ? 1.5 : 1));
          if (who === "human") {
            if (live && cmd && cfg.override_hold_min > 0) {
              this.overrides[z.id] = { mode: cur.mode, setpoint: cur.setpoint, until: now + cfg.override_hold_min * MIN, at: now };
              log.info(`climate ${z.id}: ${o.entity} changed by hand to ${cur.mode}${Number.isFinite(cur.setpoint) ? ` ${cur.setpoint} °C` : ""}; respecting it for ${cfg.override_hold_min} min`);
            }
          } else log.debug(`climate ${z.id}: ${o.entity} changed to ${cur.mode} ${cur.setpoint} by ${who}; not learned`);
        }
      }
      // A setting left alone is a preference too (weakly), sampled hourly while
      // occupied, unless it is what the brain itself set.
      const occupied = r.presence === true || (r.presence == null && houseOcc(new Date(now).getHours()));
      if (live && !sameAsCommanded(cmd, cur, step) && occupied && (cur.mode === "heat" || cur.mode === "cool")
          && this.classify(cur, out.context, cmd, step) === "human" && now - (ctx.holdSampleAt.get(o.entity) || 0) >= HOUR) {
        ctx.holdSampleAt.set(o.entity, now);
        this._learnSetpoint(z.id, now, cur, 0.15);
      }
    }

    // Consumption curves (metered outputs, once a minute while running).
    for (const [i, o] of z.outputs.entries()) {
      const out = r.outputs[i];
      if (!out || !Number.isFinite(out.meteredKw) || !Number.isFinite(tout)) continue;
      if (now - (ctx.curveAt.get(o.entity) || 0) < MIN) continue;
      const side = out.coolKw > 0 ? "cool" : out.heatKw > 0 ? "heat" : null;
      if (!side) continue;
      const set = Number.isFinite(out.setpoint) ? out.setpoint : side === "cool" ? (z.cool_c ?? cfg.cool_c) : (z.heat_c ?? cfg.heat_c);
      if (this.curves.observe(o.entity, side, side === "cool" ? tout - set : set - tout, out.meteredKw, now)) ctx.curveAt.set(o.entity, now);
    }

    // Lagged heat (slab / radiators): heating power smoothed over ~2 h.
    const hydronic = z.outputs.some((o) => o.kind === "hydronic");
    const lagPrev = ctx.lag.get(z.id) || { v: 0, t: now };
    const lag = hydronic ? lagPrev.v + (r.heatKw - lagPrev.v) * Math.min(1, (now - lagPrev.t) / HOUR / LAG_TAU_H) : 0;
    ctx.lag.set(z.id, { v: lag, t: now });

    // Thermal model: 15-minute windows of room temperature, outdoor temperature, power,
    // irradiance and lagged heat. A window is spoiled by an open window, a missing
    // reading, or a change in which sensors make up the room temperature.
    const model = this.models.get(z.id);
    let a = ctx.acc.get(z.id);
    if (!a || !Number.isFinite(a.t0)) { a = { start: now, t0: r.temp, ids: r.tempIds, tout: 0, ph: 0, pc: 0, irr: 0, lag: 0, n: 0, dirty: false }; ctx.acc.set(z.id, a); }
    if (Number.isFinite(tout)) { a.tout += tout; a.ph += r.heatKw; a.pc += r.coolKw; a.irr += Number.isFinite(irradiance) ? irradiance : 0; a.lag += lag; a.n++; } else a.dirty = true;
    if (r.windowOpen || !Number.isFinite(r.temp) || r.tempIds !== a.ids) a.dirty = true;
    if (now - a.start >= WINDOW_MS) {
      if (!a.dirty && a.n && model) {
        model.update({ t0: a.t0, t1: r.temp, tout: a.tout / a.n, ph: a.ph / a.n, pc: a.pc / a.n, irr: a.irr / a.n, plag: a.lag / a.n, hours: (now - a.start) / HOUR });
      }
      ctx.acc.set(z.id, { start: now, t0: r.temp, ids: r.tempIds, tout: 0, ph: 0, pc: 0, irr: 0, lag: 0, n: 0, dirty: false });
    }
  }

  /** Metered outputs that should be running but read ~0 W (or the reverse). */
  _checkResponse(z, r, now, ctx) {
    const flags = [];
    if (!Number.isFinite(r.temp)) flags.push({ entity: z.temp_entities.join(", "), problem: "no temperature reading: the unit's own thermostat holds the setback" });
    for (const [i, o] of z.outputs.entries()) {
      const out = r.outputs[i], key = `${z.id}#${i}`;
      if (!out || !Number.isFinite(out.meteredKw)) continue;
      const cmd = this.actuator.commanded.get(o.entity);
      const expected = out.running || (cmd && cmd.mode !== "off" && now - cmd.at > UNRESPONSIVE_MS && Number.isFinite(r.temp) && Number.isFinite(cmd.setpoint)
        && (cmd.mode === "cool" ? r.temp > cmd.setpoint + 0.5 : r.temp < cmd.setpoint - 0.5));
      const track = (map, cond, text) => {
        if (!cond) { map.delete(key); return; }
        if (!map.has(key)) map.set(key, now);
        if (now - map.get(key) >= UNRESPONSIVE_MS) flags.push({ entity: o.entity, problem: text });
      };
      track(ctx.quiet, expected && out.meteredKw < 0.05, `${out.running ? `says ${out.action || out.mode}` : `commanded ${cmd && cmd.mode}`} but the meter reads ~0 W: unresponsive, or idling`);
      track(ctx.loud, !out.on && out.meteredKw > 0.2, `off, but the meter reads ${Math.round(out.meteredKw * 1000)} W`);
    }
    return flags;
  }

  // ---------------------------------------------------------------- weather
  _toutLater(now, tout) {
    const h = this.toutForecast.filter((x) => x.t >= now - HOUR && x.t <= now + 12 * HOUR).map((x) => x.temp);
    if (h.length >= 3) return { min: Math.min(...h), max: Math.max(...h) };
    const d = this.toutDaily.filter((x) => x.t >= now - 24 * HOUR && x.t <= now + 24 * HOUR);
    if (d.length) return { min: Math.min(...d.map((x) => x.min)), max: Math.max(...d.map((x) => x.max)) };
    if (this.toutProfile) {
      const xs = Array.from({ length: 13 }, (_, k) => this.toutProfile(now + k * HOUR)).filter(Number.isFinite);
      if (Number.isFinite(tout)) xs.push(tout);
      if (xs.length) return { min: Math.min(...xs), max: Math.max(...xs) };
    }
    return null;
  }

  /** Outdoor °C at a time: the hourly forecast, else the recorded day's profile, else NaN. */
  toutAt(t) {
    const k = Math.floor(t / HOUR) * HOUR;
    const f = this.toutForecast.find((x) => Math.floor(x.t / HOUR) * HOUR === k);
    if (f) return f.temp;
    return this.toutProfile ? this.toutProfile(t) : NaN;
  }

  /** Recorded samples ({t, tout}) of the last day: a diurnal fallback for the weather. */
  setPastTout(samples) {
    const sum = Array(24).fill(0), n = Array(24).fill(0);
    for (const s of samples) if (Number.isFinite(s.tout)) { const h = new Date(s.t).getHours(); sum[h] += s.tout; n[h]++; }
    this.toutProfile = n.some(Boolean) ? (t) => { const h = new Date(t).getHours(); return n[h] ? sum[h] / n[h] : NaN; } : null;
  }

  async refreshForecast(now = Date.now()) {
    const ent = this.cfg.weather_entity;
    if (!ent || !this.ha || !this.ha.ready || now - this.forecastAt < 30 * MIN) return;
    this.forecastAt = now;
    for (const type of ["hourly", "daily"]) {
      try {
        const res = await this.ha.send({ type: "call_service", domain: "weather", service: "get_forecasts",
          target: { entity_id: ent }, service_data: { type }, return_response: true });
        const fc = (((res && res.response) || {})[ent] || {}).forecast || [];
        if (!fc.length) continue;
        if (type === "hourly") this.toutForecast = fc.map((x) => ({ t: Date.parse(x.datetime), temp: x.temperature })).filter((x) => Number.isFinite(x.t) && Number.isFinite(x.temp));
        else this.toutDaily = fc.map((x) => ({ t: Date.parse(x.datetime), max: x.temperature, min: Number.isFinite(x.templow) ? x.templow : x.temperature })).filter((x) => Number.isFinite(x.t) && Number.isFinite(x.max));
        return;
      } catch (e) { log.debug(`weather ${type} forecast unavailable`, e.message); }
    }
  }

  // ---------------------------------------------------------------- planning
  _comfort(z, t) {
    const h = this.prefs.preferred(z.id, t, "heat", z.heat_c != null ? z.heat_c : this.cfg.heat_c);
    const c = this.prefs.preferred(z.id, t, "cool", z.cool_c != null ? z.cool_c : this.cfg.cool_c);
    return { heat: h.value, cool: c.value, confidence: (h.confidence + c.confidence) / 2, heatConf: h.confidence, coolConf: c.confidence };
  }

  _cap(z, tout, comfort) {
    return Zones.capability(z, (o, i, side) => {
      if (!o.power_entity && !o.energy_entity) return o.kw;
      const lift = side === "cool" ? tout - comfort.cool : comfort.heat - tout;
      return this.curves.predict(o.entity, side, lift, o.kw).kw;
    });
  }

  _occupancy(z, now, away, presence, ctx) {
    const thr = this.cfg.occupancy_threshold;
    const prob = this.occ.probability(z.id, now, priorAt(now));
    let occupied;
    if (presence === true) occupied = true;
    else if (presence === false) occupied = now - (ctx.presentAt.get(z.id) || 0) < this.cfg.vacancy_delay_min * MIN;
    else occupied = !away && prob.p >= thr;     // no reading: the learned pattern
    const nextOccMin = this.occ.nextOccupied(z.id, now, this.cfg.precondition_max_min, thr, priorAt);
    let expect = occupied;
    for (let k = 1; !expect && k <= 12; k++) expect = this.occ.probability(z.id, now + k * HOUR, priorAt(now + k * HOUR)).p >= thr;
    return { occupied, prob: prob.p, probConfidence: prob.confidence, nextOccMin, expectOcc: expect && !away };
  }

  /** Read every zone, learn, and plan. Returns Map zone id -> plan. */
  tick(now, { tout = NaN, sun, soc, irradiance = NaN } = {}) {
    this.failed = false;
    if (!this.enabled) { this.plans = new Map(); return this.plans; }
    if (Number.isFinite(tout)) this.lastTout = tout;
    this.refreshForecast(now).catch(() => {});
    const get = this.get, ctx = this.live;
    const metered = this._metered(now, get, ctx);
    this.metered = metered;
    const housePresence = this.cfg.presence_entity ? Zones.presenceOf(get(this.cfg.presence_entity)) : null;
    const away = housePresence === false;
    for (const [id, o] of Object.entries(this.overrides)) if (!(o && o.until > now)) delete this.overrides[id];
    const plans = new Map();
    for (const z of this.zones) {
      const r = Zones.readZone(z, get, (k) => metered.get(k));
      this.readings.set(z.id, r);
      this._observe(z, r, now, tout, ctx, { live: true, away, irradiance });
      this.flags.set(z.id, this._checkResponse(z, r, now, ctx));
      const occ = this._occupancy(z, now, away, r.presence, ctx);
      const comfort = this._comfort(z, now);
      // Humidity with hysteresis: muggy above 70%, dry again below 65%.
      const wasHumid = this.humid.get(z.id) || false;
      const humid = Number.isFinite(r.humidity) ? (wasHumid ? r.humidity > 65 : r.humidity > 70) : false;
      this.humid.set(z.id, humid);
      // Pre-conditioning: once begun for an expected arrival it stays on until people
      // come or the grace runs out; after an arrival that didn't happen, it rests
      // until the pattern moves on.
      if (occ.occupied) { delete this.latch[z.id]; this.suppress.delete(z.id); }
      if (this.latch[z.id] && now >= this.latch[z.id]) { delete this.latch[z.id]; this.suppress.add(z.id); }
      if (this.suppress.has(z.id) && occ.nextOccMin !== 0) this.suppress.delete(z.id);
      const nextOccMin = this.suppress.has(z.id) ? null : occ.nextOccMin;
      const model = this.models.get(z.id);
      const plan = planZone({
        zone: z, cfg: this.cfg, cap: this._cap(z, tout, comfort), model: model.forPlanning(this.prevSide.get(z.id) || undefined), now,
        temp: r.temp, humidity: r.humidity, humid, tout, toutLater: this._toutLater(now, tout), comfort, noReading: !Number.isFinite(r.temp),
        occupied: occ.occupied, away, nextOccMin, precondLatched: !!this.latch[z.id] && !occ.occupied, expectOcc: occ.expectOcc,
        windowOpen: ctx.openSince.has(z.id) && now - ctx.openSince.get(z.id) >= this.cfg.window_delay_s * 1000,
        override: this.overrides[z.id] || null, outlook: this.outlookFor(z), sun, soc, prevSide: this.prevSide.get(z.id) || null,
      });
      if (plan.levels.precondition.active && !this.latch[z.id]) this.latch[z.id] = now + ((nextOccMin || 0) + this.cfg.precondition_grace_min) * MIN;
      plan.occProb = occ.prob; plan.occConfidence = occ.probConfidence;
      plan.modelConfidence = model.confidence(plan.side || undefined);
      plan.modelSource = model.source || "prior";
      plans.set(z.id, plan);
      if (plan.side) this.prevSide.set(z.id, plan.side);
    }
    this.plans = plans;
    return plans;
  }

  outlookFor(z) {
    const o = this.outlook || {};
    return { fullSoon: !!o.fullSoon, tight: !!o.tight, shedSoon: !!(o.shedSoon && o.shedSoon.has(Ladder.devIdOf(z))) };
  }

  /** The low-case projection (timeline.projectRange output): will the battery fill
      (surplus to bank), and will climate be shed or the reserve be reached? */
  setOutlook(future, now = Date.now()) {
    const ahead = (future || []).filter((s) => s.t > now && s.t <= now + 12 * HOUR);
    const devs = new Set(this.zones.map(Ladder.devIdOf));
    const shedSoon = new Set();
    for (const s of ahead) for (const id of s.shed || []) if (devs.has(id)) shedSoon.add(id);
    this.outlook = {
      fullSoon: ahead.some((s) => (Number.isFinite(s.socLow) ? s.socLow : s.soc) >= 98),
      tight: ahead.some((s) => s.deficit) || shedSoon.size > 0,
      shedSoon,
    };
  }

  /** The policy for the real walk (advisory zones left out), or the shadow walk. */
  expand(policy, plans = this.plans, { advisory = false } = {}) {
    if (!this.enabled) return policy;
    const out = Ladder.expand(policy, this.zones, plans, { advisory });
    if (!advisory) this.warnings = out.warnings || [];
    return out;
  }

  /** Decisions from the real walk; advisory zones' from a shadow walk with them in.
      `shadowFn()` returns decide() over expand(policy, plans, { advisory: true }). */
  resolve(result, shadowFn = null) {
    if (!this.enabled) { this.decisions = new Map(); return this.decisions; }
    let shadow = null;
    if (shadowFn && this.zones.some(Zones.isAdvisory)) {
      try { shadow = shadowFn(); } catch (e) { log.warn("climate: shadow walk failed", e.message); }
    }
    this.decisions = Ladder.resolve(this.zones, this.plans, result, shadow);
    // A person's setting the battery couldn't afford is dropped, not resumed later:
    // when comfort comes back the brain plans it, from preferences that already learned
    // the setting (at 1.5x). Resuming a stale setting hours later would surprise more.
    for (const [id, d] of this.decisions) {
      if (d.overruled && this.overrides[id]) {
        log.info(`climate ${id}: the setting by hand (${this.overrides[id].mode} ${this.overrides[id].setpoint}) isn't affordable now; dropped, the brain plans this zone again`);
        delete this.overrides[id];
      }
    }
    return this.decisions;
  }

  /** A tick failed part-way: drop the decisions and let go of the zones' devices, so
      the switch actuator runs them from the policy as written. */
  markFailed() { this.failed = true; this.decisions = new Map(); }

  async apply({ dryRun, now = Date.now() }) {
    if (!this.enabled || this.failed) return [];
    this.lastAdvisories = await this.actuator.apply(this.zones, this.decisions, this.readings, { dryRun, now, get: this.get });
    return this.lastAdvisories;
  }

  /** The policy expanded for a projected moment (projection start `now`): rooms held
      at their band (steady state), except the first hour of occupancy after a setback,
      which pays to recover; occupancy from the learned pattern; outdoor temperature
      from the forecast. Advisory zones are left out: they draw nothing real. */
  expandAt(policy, t, c, now = Date.now()) {
    if (!this.enabled) return policy;
    const plans = new Map(), thr = this.cfg.occupancy_threshold;
    for (const z of this.zones) {
      if (Zones.isAdvisory(z)) continue;
      const tf = this.toutAt(t);
      const tout = Number.isFinite(tf) ? tf : this.lastTout;
      const comfort = this._comfort(z, t);
      const nowPlan = this.plans.get(z.id);
      const occAt = (x) => (x - now < 30 * MIN && nowPlan ? nowPlan.occupied : this.occ.probability(z.id, x, priorAt(x)).p >= thr);
      const occupied = occAt(t);
      const model = this.models.get(z.id).forPlanning(nowPlan ? nowPlan.side || undefined : undefined);
      const args = {
        zone: z, cfg: this.cfg, cap: this._cap(z, tout, comfort), model, now: t,
        temp: NaN, humidity: NaN, tout, toutLater: null, comfort, occupied, away: nowPlan ? nowPlan.away : false,
        nextOccMin: occupied ? null : this.occ.nextOccupied(z.id, t, this.cfg.precondition_max_min, thr, priorAt),
        expectOcc: true, windowOpen: false, override: null, outlook: {}, sun: c.sun, soc: c.soc, prevSide: nowPlan ? nowPlan.side : null,
      };
      let p = planZone(args);
      // Recovery: arriving to a room left at its setback costs more than holding it.
      if (occupied && !occAt(t - HOUR) && p.side && p.levels.setback.setpoint != null) p = planZone({ ...args, temp: p.levels.setback.setpoint });
      plans.set(z.id, p);
    }
    return Ladder.expand(policy, this.zones, plans);
  }

  /** Is this policy device driven by the climate brain (not the switch actuator)?
      Not after a failed tick, and not for a zone with no outputs of its own. */
  owns(devId) { return this.enabled && !this.failed && this.zones.some((z) => !Zones.isAdvisory(z) && Ladder.devIdOf(z) === devId); }

  /** Measured climate draw now (kW), for the recorder: metered where there are meters,
      the rating while running elsewhere. */
  measuredKw() {
    let kw = 0;
    for (const z of this.zones) { const r = this.readings.get(z.id); if (r) kw += (r.heatKw || 0) + (r.coolKw || 0); }
    return kw;
  }

  // ---------------------------------------------------------------- seeding
  /** Replay HA history into the learners, once per zone, a day at a time. */
  async seed(now = Date.now()) {
    if (this.seeding || !this.enabled || !this.ha || !this.ha.ready || !(this.cfg.learn_days > 0)) return;
    const todo = this.zones.filter((z) => !this.seeded[z.id]);
    if (!todo.length) return;
    this.seeding = true;
    try {
      const { seedFromHistory } = require("./seed.js");
      const n = await seedFromHistory(this, todo, { start: now - this.cfg.learn_days * 24 * HOUR, end: now, toutEntity: this.toutEntity });
      for (const z of todo) this.seeded[z.id] = true;
      log.info(`climate: learned from up to ${this.cfg.learn_days} days of history for ${todo.map((z) => z.id).join(", ")} (${n} states)`);
    } catch (e) { log.warn("climate: could not read history to learn from", e.message); }
    finally { this.seeding = false; }
  }

  // ---------------------------------------------------------------- output
  snapshot() {
    if (!this.enabled) return { enabled: false, zones: [] };
    return {
      enabled: true, failed: this.failed, warnings: this.warnings,
      outlook: { fullSoon: !!this.outlook.fullSoon, tight: !!this.outlook.tight },
      forecast: this.toutForecast.length ? "hourly" : this.toutDaily.length ? "daily" : this.toutProfile ? "recorded" : "none",
      zones: this.zones.map((z) => {
        const p = this.plans.get(z.id), d = this.decisions.get(z.id), r = this.readings.get(z.id) || {}, m = this.models.get(z.id);
        const lvl = d && d.level && !(d.level === "rule") ? d.level : null;
        const band = p && d && d.level ? (lvl ? p.band(lvl) : { low: d.side === "heat" ? d.setpoint : null, high: d.side === "cool" ? d.setpoint : null }) : null;
        return {
          id: z.id, name: z.name, area: z.area, advisory: Zones.isAdvisory(z), adviseOnly: z.advise_only,
          plan: p ? plain(p) : null, decision: d || null, band,
          window: !!r.windowOpen, presence: r.presence == null ? null : r.presence,
          outputs: z.outputs.map((o, i) => ({ entity: o.entity, kind: o.kind, ...(r.outputs ? r.outputs[i] : {}),
            advice: this.actuator.advice.get(o.entity) || null,
            curve: o.power_entity || o.energy_entity ? ["heat", "cool"].filter((s) => o.modes.includes(s)).map((s) => ({ side: s, ...this.curves.predict(o.entity, s, 10, o.kw) })) : null })),
          model: m ? { ...m.params, confidence: m.confidence(), planningWith: m.source || "prior", samples: m.n } : null,
          flags: this.flags.get(z.id) || [],
          override: this.overrides[z.id] || null,
          preconditionUntil: this.latch[z.id] || null,
          seeded: !!this.seeded[z.id],
        };
      }),
    };
  }

  toJSON() {
    const models = { ...this.modelState };
    for (const [id, m] of this.models) models[id] = m.toJSON();
    return { version: STATE_VERSION, prefs: this.prefs.toJSON(), occ: this.occ.toJSON(), curves: this.curves.toJSON(), models,
             seeded: this.seeded, overrides: this.overrides, latch: this.latch, baselines: this.baselines, actuator: this.actuator.toJSON() };
  }
}

module.exports = { ClimateBrain, newCtx, sameAsCommanded, STATE_VERSION };
