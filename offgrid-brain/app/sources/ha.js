/* Home Assistant WebSocket client.

   An add-on reaches core at ws://supervisor/core/websocket and authenticates with
   SUPERVISOR_TOKEN (granted by homeassistant_api: true in config.yaml). We hold a
   live mirror of only the entities we were told to care about, so a tick never
   blocks on network I/O. */
"use strict";
// Node 22 ships a WHATWG WebSocket as a global, so this file has NO npm dependency.
// That is deliberate: the HA socket is the brain's control path and must not be
// breakable by an npm registry outage during an add-on rebuild.
const log = require("../log.js");

class HAClient {
  constructor({ url, token }) {
    this.url = url || "ws://supervisor/core/websocket";
    this.token = token;
    this.ws = null;
    this.id = 1;
    this.pending = new Map();
    this.states = new Map();       // entity_id -> { state, attributes, updated: epoch_ms }
    this.watch = new Set();
    this.ready = false;
    this.onReady = () => {};
    this.backoff = 1000;
    // Who the brain is to Home Assistant, and the contexts of its own service calls,
    // so a state change it caused isn't mistaken for a person's (climate learning).
    this.userId = null;
    this.ourContexts = new Set();
  }

  /** Mirror these entities. New ones are fetched now if the socket is up, so a
      source changed in the settings is readable on the next tick. */
  track(entityIds) {
    const added = [];
    for (const e of entityIds) if (e && !this.watch.has(e)) { this.watch.add(e); added.push(e); }
    if (added.length && this.ready) {
      this.send({ type: "get_states" })
        .then((all) => { for (const st of all) if (added.includes(st.entity_id)) this._store(st.entity_id, st); })
        .catch((e) => log.warn("could not fetch newly tracked entities", e.message));
    }
  }

  /** Every entity, for the settings pickers: id, name, state, unit, device class
      and area. Live from HA, not the mirror, so it includes untracked entities. */
  async listEntities() {
    const [states, entities, devices, areas] = await Promise.all([
      this.send({ type: "get_states" }),
      this.send({ type: "config/entity_registry/list" }).catch(() => []),
      this.send({ type: "config/device_registry/list" }).catch(() => []),
      this.send({ type: "config/area_registry/list" }).catch(() => []),
    ]);
    const areaName = new Map(areas.map((a) => [a.area_id, a.name]));
    const deviceArea = new Map(devices.map((d) => [d.id, d.area_id]));
    const deviceName = new Map(devices.map((d) => [d.id, d.name_by_user || d.name || ""]));
    const reg = new Map(entities.map((e) => [e.entity_id, e]));
    // Home Assistant 2026.11 names device and entity once each (friendly_name is
    // deprecated): compose "Device Entity" from the registries, falling back to the
    // state's friendly_name for entities outside the registry.
    const composed = (r, st) => {
      const ent = r.name || r.original_name || "", dev = r.device_id ? deviceName.get(r.device_id) || "" : "";
      // has_entity_name: the entity's name is only its own part (none = the device's
      // main entity). Otherwise the entity's name is already the whole name.
      let n = ent;
      if (r.has_entity_name || r.name == null && r.original_name == null) {
        n = !ent ? dev : !dev || ent.toLowerCase().startsWith(dev.toLowerCase()) ? ent : `${dev} ${ent}`;
      }
      return n || (st.attributes && st.attributes.friendly_name) || st.entity_id;
    };
    return states.map((st) => {
      const r = reg.get(st.entity_id) || {};
      const area = r.area_id || deviceArea.get(r.device_id) || null;
      return {
        entity_id: st.entity_id,
        domain: st.entity_id.split(".")[0],
        name: composed(r, st),
        state: st.state,
        unit: (st.attributes && st.attributes.unit_of_measurement) || null,
        device_class: (st.attributes && st.attributes.device_class) || null,
        area: area ? areaName.get(area) || null : null,
      };
    });
  }

  connect() {
    log.info(`connecting to HA at ${this.url}`);
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("message", (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "auth_required") return ws.send(JSON.stringify({ type: "auth", access_token: this.token }));
      if (msg.type === "auth_invalid") { log.error("HA auth rejected", msg.message); return ws.close(); }
      if (msg.type === "auth_ok") { this.backoff = 1000; return this._afterAuth(); }
      if (msg.type === "result" && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        return msg.success ? resolve(msg.result) : reject(new Error(JSON.stringify(msg.error)));
      }
      if (msg.type === "event" && msg.event && msg.event.event_type === "state_changed") {
        const { entity_id, new_state } = msg.event.data;
        if (this.watch.has(entity_id) && new_state) this._store(entity_id, new_state);
      }
      // A sensor re-reporting the same value: only its last_reported moves.
      if (msg.type === "event" && msg.event && msg.event.event_type === "state_reported") {
        const d = msg.event.data || {}, cur = this.states.get(d.entity_id);
        if (cur && d.new_state) this._store(d.entity_id, d.new_state);
        else if (cur && d.last_reported) cur.reported = Date.parse(d.last_reported) || cur.reported;
      }
    });

    ws.addEventListener("close", () => {
      this.ready = false;
      const wait = Math.min(this.backoff, 30000);
      log.warn(`HA socket closed — reconnecting in ${wait}ms`);
      this.backoff *= 2;
      setTimeout(() => this.connect(), wait);
    });
    ws.addEventListener("error", (e) => log.warn("HA socket error", e.message || "socket error"));
  }

  _store(entityId, st) {
    const ms = (x) => { const v = Date.parse(x); return Number.isFinite(v) ? v : NaN; };
    this.states.set(entityId, {
      state: st.state, attributes: st.attributes || {}, updated: Date.now(),
      // Home Assistant's own times: when the value last changed, and when the device
      // last reported it (even unchanged). Freshness is judged from these.
      changed: ms(st.last_changed), reported: ms(st.last_reported || st.last_updated),
      context: st.context || null,
    });
  }

  async _afterAuth() {
    try {
      await this.send({ type: "subscribe_events", event_type: "state_changed" });
      this.send({ type: "subscribe_events", event_type: "state_reported" }).catch(() => {});
      this.send({ type: "auth/current_user" }).then((u) => { this.userId = (u && u.id) || null; }).catch(() => {});
      const all = await this.send({ type: "get_states" });
      for (const st of all) if (this.watch.has(st.entity_id)) this._store(st.entity_id, st);
      this.ready = true;
      const missing = [...this.watch].filter((e) => !this.states.has(e));
      log.info(`HA ready — tracking ${this.watch.size} entities, ${this.states.size} resolved`);
      if (missing.length) log.warn(`entities not found in HA (will read as unavailable): ${missing.join(", ")}`);
      this.onReady();
    } catch (e) { log.error("HA handshake failed", e.message); }
  }

  send(payload) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error("socket not open"));
      const id = this.id++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...payload, id }));
    });
  }

  /** An entity's mirrored state: { state, attributes, ageSec, context, changedMs },
      or null if not mirrored. Age is from when Home Assistant last heard from the
      device (last_reported), not from when the brain received it. */
  entity(entityId) {
    const s = entityId && this.states.get(entityId);
    if (!s) return null;
    const heard = Number.isFinite(s.reported) ? s.reported : s.updated;
    return { state: s.state, attributes: s.attributes, ageSec: Math.max(0, (Date.now() - heard) / 1000), context: s.context, changedMs: s.changed };
  }

  /** Numeric value of an entity, with age in seconds. NaN when absent/unavailable. */
  number(entityId) {
    if (!entityId) return { value: NaN, ageSec: Infinity };
    const s = this.states.get(entityId);
    if (!s || s.state === "unavailable" || s.state === "unknown") return { value: NaN, ageSec: Infinity };
    return { value: parseFloat(s.state), ageSec: (Date.now() - s.updated) / 1000 };
  }

  /** Power in kW, converting from the entity's own unit (W, kW, MW). */
  powerKw(entityId) { return this._scaled(entityId, { w: 1e-3, kw: 1, mw: 1e3 }); }

  /** Energy in kWh, converting from the entity's own unit (Wh, kWh, MWh). */
  energyKwh(entityId) { return this._scaled(entityId, { wh: 1e-3, kwh: 1, mwh: 1e3 }); }

  _scaled(entityId, factors) {
    const r = this.number(entityId);
    if (!Number.isFinite(r.value)) return r;
    const unit = String((this.states.get(entityId).attributes || {}).unit_of_measurement || "").toLowerCase();
    const f = factors[unit];
    return f == null ? { value: NaN, ageSec: Infinity } : { value: r.value * f, ageSec: r.ageSec };
  }

  async callService(domain, service, entityId, data = {}) {
    const res = await this.send({ type: "call_service", domain, service, target: { entity_id: entityId }, service_data: data });
    const id = res && res.context && res.context.id;
    if (id) {
      this.ourContexts.add(id);
      if (this.ourContexts.size > 500) this.ourContexts.delete(this.ourContexts.values().next().value);
    }
    return res;
  }
}

module.exports = { HAClient };
