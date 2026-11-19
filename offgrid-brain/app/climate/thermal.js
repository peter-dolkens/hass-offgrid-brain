/* A first-order (RC) thermal model of one zone, fit online.

     dT/dt [°C/h] = a (Tout - T) + bh Ph - bc Pc + g

   T room °C, Tout outdoor °C, Ph / Pc electrical kW of heating / cooling,
   a the envelope loss rate (1/h), bh / bc °C/h per kW, g internal and solar gains
   (°C/h). Parameters are fit by recursive least squares over fixed windows (the
   caller averages a window and calls update()), with a forgetting factor so the
   model follows the seasons. The prior comes from the zone's floor area using the
   simulator's envelope (1.2 W/°C per m²), mass (0.03 kWh/°C per m²) and COP 3.5, and
   no parameter's variance may grow past its prior: a direction that is never
   excited (cooling in winter) keeps the prior instead of winding up. */
"use strict";

const N = 4;                       // [a, bh, bc, g]
const NOISE = 0.4;                 // °C/h, the derivative noise of a 15-min window at 0.1 °C resolution
const LAMBDA = 0.999;              // forgetting per window (~10 days of 15-min windows)
const BOUNDS = [[0.003, 3], [0, 30], [0, 30], [-3, 3]];

function prior({ area_m2 = 20, cop = 3.5 } = {}) {
  const area = area_m2 > 0 ? area_m2 : 20;
  const C = area * 0.03;                      // kWh/°C
  const ua = (area * 1.2) / 1000;             // kW/°C
  return { a: ua / C, bh: cop / C, bc: cop / C, g: 0.15 / C };
}

class ThermalModel {
  constructor({ area_m2, cop, state } = {}) {
    const p = prior({ area_m2, cop });
    this.prior = [p.a, p.bh, p.bc, p.g];
    // Prior standard deviations, relative to the prior itself (g absolute).
    const sd = [Math.max(0.02, p.a), Math.max(1, p.bh), Math.max(1, p.bc), 0.5];
    this.p0 = sd.map((s) => (s * s) / (NOISE * NOISE));
    if (state && Array.isArray(state.theta) && state.theta.length === N) {
      this.theta = state.theta.slice();
      this.P = state.P.map((r) => r.slice());
      this.n = { passive: 0, heat: 0, cool: 0, ...state.n };
      this.mse = Number.isFinite(state.mse) ? state.mse : NOISE * NOISE;
    } else this.reset();
  }

  reset() {
    this.theta = this.prior.slice();
    this.P = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (i === j ? this.p0[i] : 0)));
    this.n = { passive: 0, heat: 0, cool: 0 };
    this.mse = NOISE * NOISE;
  }

  toJSON() { return { theta: this.theta, P: this.P, n: this.n, mse: this.mse }; }

  get params() { const [a, bh, bc, g] = this.theta; return { a, bh, bc, g, tauH: 1 / a }; }

  /** One window: room temperature at its start and end, mean outdoor temperature and
      mean heating/cooling kW, over `hours`. Returns false when the sample is unusable. */
  update({ t0, t1, tout, ph = 0, pc = 0, hours }) {
    if (![t0, t1, tout, ph, pc, hours].every(Number.isFinite) || hours <= 0) return false;
    const y = (t1 - t0) / hours;
    if (Math.abs(y) > 12) return false;                       // a sensor glitch or a door left open
    const tm = (t0 + t1) / 2;
    const x = [tout - tm, ph, -pc, 1];
    const Px = this.P.map((r) => r.reduce((s, v, j) => s + v * x[j], 0));
    const denom = LAMBDA + x.reduce((s, v, i) => s + v * Px[i], 0);
    const k = Px.map((v) => v / denom);
    const err = y - x.reduce((s, v, i) => s + v * this.theta[i], 0);
    this.theta = this.theta.map((v, i) => v + k[i] * err);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) this.P[i][j] = (this.P[i][j] - k[i] * Px[j]) / LAMBDA;
    // No direction may become less certain than the prior (windup guard).
    for (let i = 0; i < N; i++) {
      if (this.P[i][i] > this.p0[i]) {
        const f = Math.sqrt(this.p0[i] / this.P[i][i]);
        for (let j = 0; j < N; j++) { this.P[i][j] *= f; this.P[j][i] *= f; }
      }
    }
    this.theta = this.theta.map((v, i) => Math.min(BOUNDS[i][1], Math.max(BOUNDS[i][0], v)));
    this.mse = 0.98 * this.mse + 0.02 * err * err;
    if (ph > 0.05) this.n.heat++;
    else if (pc > 0.05) this.n.cool++;
    else this.n.passive++;
    return true;
  }

  /** 0..1: how far to trust the model. Needs passive windows (the envelope) and
      windows with the output running (its effect), and a small residual. */
  confidence(mode) {
    const pass = 1 - Math.exp(-this.n.passive / 48);
    const act = mode === "heat" ? this.n.heat : mode === "cool" ? this.n.cool : Math.max(this.n.heat, this.n.cool);
    const quality = 1 / (1 + Math.max(0, Math.sqrt(this.mse) - 0.3) / 0.5);
    return pass * (1 - Math.exp(-act / 16)) * quality;
  }

  /** °C/h now. */
  rate(T, tout, ph = 0, pc = 0) { const [a, bh, bc, g] = this.theta; return a * (tout - T) + bh * ph - bc * pc + g; }

  /** Where the room settles with constant power (kW, heating if side "heat"). */
  settle(tout, kw, side) {
    const [a, bh, bc, g] = this.theta;
    return tout + (g + (side === "cool" ? -bc : bh) * kw) / a;
  }

  /** Steady-state kW to hold `T` (0 when the room holds it unaided). */
  holdKw(T, tout, side) {
    const [a, bh, bc, g] = this.theta;
    const need = side === "cool" ? (a * (tout - T) + g) / bc : (a * (T - tout) - g) / bh;
    return Math.max(0, need);
  }

  /** Constant kW that brings the room from T0 to Tset in `hours` (0 if it gets there
      unaided, uncapped above: the caller caps at the outputs' rating). */
  kwToReach(T0, Tset, tout, hours, side) {
    const [a, bh, bc, g] = this.theta;
    const b = side === "cool" ? bc : bh, s = side === "cool" ? -1 : 1;
    if (!(b > 0) || !(hours > 0)) return 0;
    const e = Math.exp(-a * hours);
    const Tinf = (Tset - T0 * e) / (1 - e);
    return Math.max(0, (s * (a * (Tinf - tout) - g)) / b);
  }

  /** Hours from T0 until the room reaches Tset at constant kW (Infinity if it can't). */
  hoursToReach(T0, Tset, tout, kw, side) {
    const heat = side !== "cool";
    if (heat ? T0 >= Tset : T0 <= Tset) return 0;
    return cross(T0, Tset, this.settle(tout, kw, side), this.theta[0]);
  }

  /** Hours the room coasts (no power) from T0 before crossing `limit`. */
  coastHours(T0, limit, tout) {
    return cross(T0, limit, this.settle(tout, 0, "heat"), this.theta[0]);
  }
}

/** Hours for an exponential approach from T0 toward Tinf to cross `target`. */
function cross(T0, target, Tinf, a) {
  if (T0 === target) return 0;
  const ratio = (target - Tinf) / (T0 - Tinf);
  if (!(ratio > 0 && ratio < 1)) return Infinity;
  return -Math.log(ratio) / a;
}

module.exports = { ThermalModel, prior };
