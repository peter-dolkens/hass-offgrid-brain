/* Learning from Home Assistant's history on first start.

   The recorder already knows how each zone's rooms have behaved: temperatures,
   presence, windows, thermostat settings and meters. Its history is fetched over
   the WebSocket (history/history_during_period) one entity and one day at a time
   (only climate entities with their attributes), yielding between days so the
   brain keeps ticking, and replayed minute by minute through the same learning
   code the live ticks use, with a separate learning context. Days the recorder
   has already purged simply come back empty.

   Changes are classified as they are live: the brain's own commands (persisted)
   and automations (a context with a parent) don't teach preferences. */
"use strict";
const Zones = require("./zones.js");

const MIN = 60000, DAY = 24 * 60 * MIN;

/** Rows -> [{ t, state, attributes, context }] oldest first. Accepts the compressed
    (s/a/c/lu/lc) and full state formats; attributes carry over when omitted. */
function parseRows(rows) {
  let attrs = {};
  const list = [];
  for (const r of rows || []) {
    const sec = r.lu != null ? r.lu : r.lc != null ? r.lc : null;
    const t = sec != null ? sec * 1000 : Date.parse(r.last_updated || r.last_changed);
    if (!Number.isFinite(t)) continue;
    if (r.a || r.attributes) attrs = r.a || r.attributes;
    const c = r.c != null ? r.c : r.context;
    list.push({ t, state: r.s != null ? r.s : r.state, attributes: attrs, context: c && typeof c === "object" ? c : c ? { id: c } : null });
  }
  return list.sort((a, b) => a.t - b.t);
}

/** A whole history response: Map entity -> rows. */
function parseHistory(res) {
  const out = new Map();
  for (const [id, rows] of Object.entries(res || {})) out.set(id, parseRows(rows));
  return out;
}

async function fetchEntityDay(ha, id, start, end) {
  const res = await ha.send({
    type: "history/history_during_period",
    start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(),
    entity_ids: [id], include_start_time_state: true, significant_changes_only: false,
    minimal_response: false, no_attributes: !id.startsWith("climate."),
  });
  return parseRows((res || {})[id]);
}

/** Replay rows for [start, end) a minute at a time. `cur` carries each entity's state
    from one call to the next. Returns the number of states replayed. */
function replayRange(brain, zones, hist, cur, ctx, { start, end, toutEntity, stepMs = MIN }) {
  const idx = new Map([...hist.keys()].map((id) => [id, 0]));
  const get = (id) => cur.get(id) || null;
  let n = 0;
  const saved = brain.zones;
  brain.zones = zones;              // meters are attributed among the zones being seeded
  try {
    for (let t = start; t < end; t += stepMs) {
      for (const [id, rows] of hist) {
        let i = idx.get(id);
        while (i < rows.length && rows[i].t <= t) { cur.set(id, { state: rows[i].state, attributes: rows[i].attributes || {}, ageSec: 0, context: rows[i].context }); i++; n++; }
        idx.set(id, i);
      }
      const ts = toutEntity ? get(toutEntity) : null;
      const tout = ts && !Zones.UNKNOWN.has(ts.state) ? parseFloat(ts.state) : NaN;
      const metered = brain._metered(t, get, ctx);
      const away = brain.cfg.presence_entity ? Zones.presenceOf(get(brain.cfg.presence_entity)) === false : false;
      for (const z of zones) {
        const r = Zones.readZone(z, get, (k) => metered.get(k));
        brain._observe(z, r, t, tout, ctx, { live: false, away });
      }
    }
  } finally { brain.zones = saved; }
  return n;
}

/** Replay an already-fetched history (tests, tools). */
function replay(brain, zones, hist, { start, end, toutEntity }) {
  const { newCtx } = require("./index.js");
  return replayRange(brain, zones, hist, new Map(), newCtx(), { start, end: end + 1, toutEntity });
}

/** Fetch and replay, a day at a time. */
async function seedFromHistory(brain, zones, { start, end, toutEntity, parts = null }) {
  const { newCtx } = require("./index.js");
  const ids = [...new Set([...zones.flatMap(Zones.zoneEntities), toutEntity, brain.cfg.presence_entity].filter(Boolean))];
  const ctx = newCtx(parts), cur = new Map();
  let n = 0;
  for (let d = start; d < end; d += DAY) {
    const dayEnd = Math.min(end, d + DAY), hist = new Map();
    for (const id of ids) {
      try { hist.set(id, await fetchEntityDay(brain.ha, id, d, dayEnd)); } catch { hist.set(id, []); }
    }
    n += replayRange(brain, zones, hist, cur, ctx, { start: d, end: dayEnd, toutEntity });
    await new Promise((r) => setImmediate(r));   // let the brain tick
  }
  return n;
}

module.exports = { parseHistory, parseRows, replay, replayRange, seedFromHistory };
