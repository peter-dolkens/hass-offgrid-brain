/* Learning from Home Assistant's history on first start.

   The recorder already knows how each zone's rooms have behaved: temperatures,
   presence, windows, thermostat settings and meters. Its history is fetched over
   the WebSocket (history/history_during_period) and replayed minute by minute
   through the same learning code the live ticks use, with a separate learning
   context, so the brain starts with preferences, an occupancy pattern, a thermal
   model and consumption curves instead of from scratch. */
"use strict";
const Zones = require("./zones.js");

const MIN = 60000;

/** History for entities over [start, end] ms: Map entity -> [{ t, state, attributes }] oldest first.
    Accepts both the compressed (s/a/lu/lc) and full state formats. */
async function fetchHistory(ha, entityIds, start, end) {
  const res = await ha.send({
    type: "history/history_during_period",
    start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(),
    entity_ids: entityIds, include_start_time_state: true, significant_changes_only: false,
    minimal_response: false, no_attributes: false,
  });
  return parseHistory(res);
}

function parseHistory(res) {
  const out = new Map();
  for (const [id, rows] of Object.entries(res || {})) {
    let attrs = {};
    const list = [];
    for (const r of rows || []) {
      const sec = r.lu != null ? r.lu : r.lc != null ? r.lc : null;
      const t = sec != null ? sec * 1000 : Date.parse(r.last_updated || r.last_changed);
      if (!Number.isFinite(t)) continue;
      if (r.a || r.attributes) attrs = r.a || r.attributes;   // minimal responses repeat attributes only when they change
      list.push({ t, state: r.s != null ? r.s : r.state, attributes: attrs });
    }
    list.sort((a, b) => a.t - b.t);
    out.set(id, list);
  }
  return out;
}

/** Replay `hist` through brain's learners for `zones`, one step a minute. Returns the
    number of states replayed. */
function replay(brain, zones, hist, { start, end, toutEntity, stepMs = MIN }) {
  const { newCtx } = require("./index.js");
  const ctx = newCtx();
  const idx = new Map(), cur = new Map();
  for (const id of hist.keys()) idx.set(id, 0);
  const get = (id) => cur.get(id) || null;
  let n = 0;
  const saved = brain.zones;
  brain.zones = zones;              // meters are attributed among the zones being seeded
  try {
    for (let t = start; t <= end; t += stepMs) {
      for (const [id, rows] of hist) {
        let i = idx.get(id);
        while (i < rows.length && rows[i].t <= t) { cur.set(id, { state: rows[i].state, attributes: rows[i].attributes || {}, ageSec: 0 }); i++; n++; }
        idx.set(id, i);
      }
      const ts = toutEntity ? get(toutEntity) : null;
      const tout = ts && !Zones.UNKNOWN.has(ts.state) ? parseFloat(ts.state) : NaN;
      const metered = brain._metered(t, get, ctx);
      for (const z of zones) {
        const r = Zones.readZone(z, get, (k) => metered.get(k));
        brain._observe(z, r, t, tout, ctx, { live: false });
      }
    }
  } finally { brain.zones = saved; }
  return n;
}

module.exports = { fetchHistory, parseHistory, replay };
