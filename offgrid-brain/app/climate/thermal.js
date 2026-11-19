/* A first-order (RC) thermal model of one zone, fit online.

     dT/dt [°C/h] = a (Tout - T) + bh Ph - bc Pc + g + s I + bl Plag

   T room °C, Tout outdoor °C, Ph / Pc electrical kW heating / cooling (measured
   where metered: the heat delivered is COP x kW, and bh/bc absorb the COP), I
   irradiance (kW/m², solar gain through glazing), Plag heating power smoothed over
   ~2 h (a slab or radiator keeps giving heat after the pump stops; zero for zones
   without hydronic outputs). a is the envelope loss rate (1/h), g internal gains.

   Fit by recursive least squares over 15-minute windows with a forgetting factor so
   it follows the seasons. The prior comes from the zone's floor area using the
   simulator's envelope (1.2 W/°C per m²), mass (0.03 kWh/°C per m²) and COP 3.5; no
   parameter's variance may grow past its prior (an unexcited direction, cooling in
   winter, keeps the prior), and a window whose residual is far outside the model's
   recent error is skipped. Planning uses the fit only above a confidence gate
   (forPlanning); below it, the prior. */
"use strict";

const N = 6;                       // [a, bh, bc, g, s, bl]
const NOISE = 0.4;                 // °C/h, the derivative noise of a 15-min window at 0.1 °C resolution
const LAMBDA = 0.999;              // forgetting per window (~10 days of 15-min windows)
const BOUNDS = [[0.003, 3], [0, 30], [0, 30], [-3, 3], [0, 10], [0, 30]];
const GATE = 0.3;                  // confidence below which planning uses the prior

function prior({ area_m2 = 20, cop = 3.5 } = {}) {
  const area = area_m2 > 0 ? area_m2 : 20;
  const C = area * 0.03;                      // kWh/°C
  const ua = (area * 1.2) / 1000;             // kW/°C
  return { a: ua / C, bh: cop / C, bc: cop / C, g: 0.15 / C, s: 0.3 / C, bl: 0 };
}

const finite = (x) => typeof x === "number" && Number.isFinite(x);

class ThermalModel {
  constructor({ area_m2, cop, state } = {}) {
    const p = prior({ area_m2, cop });
    this.area_m2 = area_m2;
    this.prior = [p.a, p.bh, p.bc, p.g, p.s, p.bl];
    const sd = [Math.max(0.02, p.a), Math.max(1, p.bh), Math.max(1, p.bc), 0.5, 1, Math.max(1, p.bh)];
    this.p0 = sd.map((x) => (x * x) / (NOISE * NOISE));
    this.reset();
    this.load(state);
  }

  reset() {
    this.theta = this.prior.slice();
    this.P = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (i === j ? this.p0[i] : 0)));
    this.n = { passive: 0, heat: 0, cool: 0, rejected: 0 };
    this.mse = NOISE * NOISE;
  }

  /** Restore saved state if it is whole and sane; otherwise keep the prior.
      A 4-parameter state (0.34.0 drafts) is extended with the new terms' priors. */
  load(state) {
    if (!state || !Array.isArray(state.theta) || !Array.isArray(state.P)) return false;
    const k = state.theta.length;
    if (!(k === 4 || k === N) || state.P.length !== k || !state.P.every((r) => Array.isArray(r) && r.length === k && r.every(finite))
        || !state.theta.every(finite)) return false;
    this.theta = this.prior.map((v, i) => (i < k ? Math.min(BOUNDS[i][1], Math.max(BOUNDS[i][0], state.theta[i])) : v));
    this.P = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (i < k && j < k ? state.P[i][j] : i === j ? this.p0[i] : 0)));
    const n = state.n || {};
    this.n = { passive: finite(n.passive) ? n.passive : 0, heat: finite(n.heat) ? n.heat : 0, cool: finite(n.cool) ? n.cool : 0, rejected: finite(n.rejected) ? n.rejected : 0 };
    this.mse = finite(state.mse) && state.mse > 0 ? state.mse : NOISE * NOISE;
    return true;
  }

  toJSON() { return { theta: this.theta, P: this.P, n: this.n, mse: this.mse }; }

  get params() { const [a, bh, bc, g, s, bl] = this.theta; return { a, bh, bc, g, s, bl, tauH: 1 / a }; }

  /** One window: room temperature at its start and end, mean outdoor temperature,
      mean heating/cooling kW, mean irradiance (W/m²) and lagged heating kW, over
      `hours`. Returns false when the sample is unusable or an outlier. */
  update({ t0, t1, tout, ph = 0, pc = 0, irr = 0, plag = 0, hours }) {
    if (![t0, t1, tout, ph, pc, hours].every(Number.isFinite) || hours <= 0) return false;
    const y = (t1 - t0) / hours;
    if (Math.abs(y) > 12) return false;                       // a sensor glitch or a door left open
    const tm = (t0 + t1) / 2;
    const x = [tout - tm, ph, -pc, 1, (Number.isFinite(irr) ? irr : 0) / 1000, Number.isFinite(plag) ? plag : 0];
    const err = y - x.reduce((s, v, i) => s + v * this.theta[i], 0);
    // Residual gate: once the model has some history, skip windows it can't explain
    // (a door left open, a shower next door, a sensor in the sun).
    const seen = this.n.passive + this.n.heat + this.n.cool;
    if (seen > 24 && Math.abs(err) > 4 * Math.sqrt(this.mse) + 0.5) { this.n.rejected++; return false; }
    const Px = this.P.map((r) => r.reduce((s, v, j) => s + v * x[j], 0));
    const denom = LAMBDA + x.reduce((s, v, i) => s + v * Px[i], 0);
    const k = Px.map((v) => v / denom);
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
    if (ph > 0.05 || plag > 0.05) this.n.heat++;
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

  /** The model to plan with: this fit once it's confident enough, else the prior. */
  forPlanning(mode, gate = GATE) {
    if (this.confidence(mode) >= gate) { this.source = "fitted"; return this; }
    if (!this._prior) { this._prior = new ThermalModel({ area_m2: this.area_m2 }); this._prior.source = "prior"; }
    this.source = "prior";
    return this._prior;
  }

  // Heating's effect: immediate (bh) plus what a slab/radiator gives later (bl).
  // Holding a temperature gets both; reaching one within a few hours, half the lag.
  _bh(hold) { return this.theta[1] + (hold ? 1 : 0.5) * this.theta[5]; }

  /** °C/h now (no sun). */
  rate(T, tout, ph = 0, pc = 0) { const [a, bh, bc, g] = this.theta; return a * (tout - T) + bh * ph - bc * pc + g; }

  /** Where the room settles with constant power (kW, heating if side "heat"). */
  settle(tout, kw, side, hold = false) {
    const [a, , bc, g] = this.theta;
    return tout + (g + (side === "cool" ? -bc : this._bh(hold)) * kw) / a;
  }

  /** Steady-state kW to hold `T` (0 when the room holds it unaided). */
  holdKw(T, tout, side) {
    const [a, , bc, g] = this.theta;
    const need = side === "cool" ? (a * (tout - T) + g) / bc : (a * (T - tout) - g) / this._bh(true);
    return Math.max(0, need);
  }

  /** Constant kW that brings the room from T0 to Tset in `hours` (0 if it gets there
      unaided, uncapped above: the caller caps at the outputs' rating). */
  kwToReach(T0, Tset, tout, hours, side) {
    const [a, , bc, g] = this.theta;
    const b = side === "cool" ? bc : this._bh(false), s = side === "cool" ? -1 : 1;
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

module.exports = { ThermalModel, prior, GATE };
