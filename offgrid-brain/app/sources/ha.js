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
    const reg = new Map(entities.map((e) => [e.entity_id, e]));
    return states.map((st) => {
      const r = reg.get(st.entity_id) || {};
      const area = r.area_id || deviceArea.get(r.device_id) || null;
      return {
        entity_id: st.entity_id,
        domain: st.entity_id.split(".")[0],
        name: (st.attributes && st.attributes.friendly_name) || st.entity_id,
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
    this.states.set(entityId, { state: st.state, attributes: st.attributes || {}, updated: Date.now() });
  }

  async _afterAuth() {
    try {
      await this.send({ type: "subscribe_events", event_type: "state_changed" });
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

  /** Numeric value of an entity, with age in seconds. NaN when absent/unavailable. */
  number(entityId) {
    if (!entityId) return { value: NaN, ageSec: Infinity };
    const s = this.states.get(entityId);
    if (!s || s.state === "unavailable" || s.state === "unknown") return { value: NaN, ageSec: Infinity };
    return { value: parseFloat(s.state), ageSec: (Date.now() - s.updated) / 1000 };
  }

  callService(domain, service, entityId, data = {}) {
    return this.send({ type: "call_service", domain, service, target: { entity_id: entityId }, service_data: data });
  }
}

module.exports = { HAClient };
