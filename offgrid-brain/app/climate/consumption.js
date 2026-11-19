/* What each climate unit really draws, learned from its meter.

   Nameplate kW is a ceiling; a heat pump's running draw depends on how hard it is
   lifting heat: roughly linear in the lift, the gap between the setpoint and the
   outdoor temperature (setpoint - outdoor when heating, outdoor - setpoint when
   cooling). Per output and side, a decayed weighted linear fit

     running kW = c0 + c1 * lift

   over the minutes the meter says it was running (above `runKw`). Until enough has
   been seen, prediction blends toward the configured kW by confidence. */
"use strict";

const DAY = 24 * 3600 * 1000;

class ConsumptionCurves {
  constructor(state, { halfLifeDays = 30, runKw = 0.08 } = {}) {
    this.c = state && typeof state === "object" ? state : {};
    this.hl = halfLifeDays * DAY;
    this.runKw = runKw;
  }
  toJSON() { return this.c; }

  /** A metered sample: output entity, side, lift °C, measured kW, at time t. */
  observe(entity, side, lift, kw, t) {
    if (!(side === "heat" || side === "cool") || !Number.isFinite(lift) || !Number.isFinite(kw) || kw < this.runKw) return false;
    const k = `${entity}|${side}`;
    const b = this.c[k] || { w: 0, x: 0, y: 0, xx: 0, xy: 0, t };
    const f = t > b.t ? Math.pow(0.5, (t - b.t) / this.hl) : 1;
    for (const p of ["w", "x", "y", "xx", "xy"]) b[p] *= f;
    b.w += 1; b.x += lift; b.y += kw; b.xx += lift * lift; b.xy += lift * kw; b.t = Math.max(b.t, t);
    this.c[k] = b;
    return true;
  }

  /** { kw, confidence, learned } for a lift; `nameplate` is the fallback and the scale. */
  predict(entity, side, lift, nameplate) {
    const b = this.c[`${entity}|${side}`];
    if (!b || !(b.w > 0)) return { kw: nameplate, confidence: 0, learned: null };
    const mx = b.x / b.w, my = b.y / b.w, vx = b.xx / b.w - mx * mx;
    // Too little spread in lift to fit a slope: use the mean draw.
    const c1 = vx > 1 ? (b.xy / b.w - mx * my) / vx : 0;
    const c0 = my - c1 * mx;
    const cap = nameplate > 0 ? nameplate * 1.5 : Infinity;
    const learned = Math.max(this.runKw, Math.min(cap, c0 + c1 * (Number.isFinite(lift) ? lift : mx)));
    const confidence = 1 - Math.exp(-b.w / 20);
    const kw = nameplate > 0 ? nameplate + confidence * (learned - nameplate) : learned;
    return { kw, confidence, learned, c0, c1, samples: Math.round(b.w) };
  }
}

/** Shared meters: one power entity on several outputs. The measured kW is split
    over the outputs on that meter that say they're running (by nameplate share),
    or over all of them by nameplate when none says. Approximate by nature.
    `outs`: [{ key, power_entity, kw, running }]; `read(entity)` -> kW or NaN.
    Returns Map key -> kW (NaN where there is no meter or no reading). */
function attribute(outs, read) {
  const res = new Map();
  const groups = new Map();
  for (const o of outs) {
    if (!o.power_entity) { res.set(o.key, NaN); continue; }
    if (!groups.has(o.power_entity)) groups.set(o.power_entity, []);
    groups.get(o.power_entity).push(o);
  }
  for (const [ent, g] of groups) {
    const total = read(ent);
    if (!Number.isFinite(total)) { for (const o of g) res.set(o.key, NaN); continue; }
    const share = g.some((o) => o.running) ? g.filter((o) => o.running) : g;
    const sum = share.reduce((t, o) => t + (o.kw > 0 ? o.kw : 1), 0);
    for (const o of g) res.set(o.key, share.includes(o) ? (total * (o.kw > 0 ? o.kw : 1)) / sum : 0);
  }
  return res;
}

module.exports = { ConsumptionCurves, attribute };
