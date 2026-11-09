/* Available-solar estimate, per inverter.

   Off grid, the battery inverter throttles AC-coupled solar to the load once the
   battery is full. The inverters' output is then what was DELIVERED, not what the
   sun could give, so it can't tell the brain there is surplus to spend. This
   estimates what each array COULD produce from irradiance:

       available = irradiance/1000 × kWp × k   (capped at that inverter's AC rating)

   Each inverter carries its own array size (kWp) and AC rating: sites mix
   inverter models and array sizes. An inverter with no AC rating is capped at
   its kWp, which it can't exceed anyway, rather than at a guessed value.

   k folds in everything a horizontal irradiance sensor doesn't know about the
   array: tilt and azimuth (a tilted array beats a flat sensor early and late in
   the day), temperature, soiling and inverter losses. It's LEARNED per inverter
   and per half-hour of the day, but only from moments when the array was
   demonstrably not being throttled (battery charging, well below the charge
   limit), because only then does output equal what the sun allowed. Until a bin
   has samples, a typical performance ratio stands in. */
"use strict";

const PRIOR_K = 0.85;          // typical performance ratio, used until bins learn
const PRIOR_WEIGHT = 5;        // samples' worth of trust in the prior
const ALPHA_MIN = 0.05;        // slowest learning rate, so bins track the seasons
const SAMPLE_EVERY_MS = 60_000;// one sample per bin per minute: ticks are correlated
const BIN_MINUTES = 30;
const MIN_IRRADIANCE = 25;     // W/m²; below this the ratio is mostly noise. Kept low because a
                               // lightly loaded site is only unthrottled for the first hour of sun.
const K_RANGE = [0.1, 2.0];    // reject obviously broken samples

/** True when the inverters are producing all the sun allows: the battery is
    actually taking charge, and solar is well below what the battery inverter would
    accept. The charger STATE is deliberately not used: on a lightly loaded site the
    SP PRO stays in "Long Term Float" while it tops up from ~98% each morning, which
    is exactly when the arrays run unthrottled. Above ~99.6% it tapers the charge
    and throttles the arrays even though the battery still takes a little, hence the
    SoC ceiling. batteryKw follows the bridge: POSITIVE while charging. */
function isUnconstrained({ socPct, batteryKw, pvKw, loadKw, chargeLimitKw }) {
  if (!(socPct < 99.5)) return false;
  if (!(batteryKw >= 0.5)) return false;   // a real charge, not the taper's trickle
  if (!Number.isFinite(pvKw) || !Number.isFinite(loadKw)) return false;
  if (Number.isFinite(chargeLimitKw) && pvKw >= 0.8 * (loadKw + chargeLimitKw)) return false;
  return true;
}

/** An inverter's output ceiling: its AC rating, or its array peak if unrated. */
const capOf = (inv) => (inv.acKw > 0 ? inv.acKw : inv.kwp > 0 ? inv.kwp : Infinity);

const binOf = (date) => Math.floor((date.getHours() * 60 + date.getMinutes()) / BIN_MINUTES);

class SolarEstimator {
  constructor({ state } = {}) {
    this.bins = (state && state.bins) || {};   // inverter key -> bin -> { k, n, last }
  }

  toJSON() { return { bins: this.bins }; }

  /** Learn from one moment. inverters: [{ key, kwp, acKw, kw }]. Returns samples taken. */
  learn({ now, irradiance, inverters, unconstrained }) {
    if (!unconstrained || !(irradiance >= MIN_IRRADIANCE)) return 0;
    const bin = binOf(now);
    let taken = 0;
    for (const inv of inverters) {
      if (!(inv.kwp > 0) || !Number.isFinite(inv.kw)) continue;
      if (inv.kw >= 0.95 * capOf(inv)) continue;   // clipping at the AC limit hides the sun
      const sample = inv.kw / ((irradiance / 1000) * inv.kwp);
      if (sample < K_RANGE[0] || sample > K_RANGE[1]) continue;
      const byBin = (this.bins[inv.key] = this.bins[inv.key] || {});
      const b = byBin[bin];
      if (b && now - b.last < SAMPLE_EVERY_MS) continue;
      if (!b) byBin[bin] = { k: sample, n: 1, last: +now };
      else {
        const alpha = Math.max(ALPHA_MIN, 1 / (b.n + 1));   // fast at first, then steady
        b.k += alpha * (sample - b.k);
        b.n += 1;
        b.last = +now;
      }
      taken++;
    }
    return taken;
  }

  /** Factor for an inverter at a time: the learned bin, shrunk toward the prior
      while it has few samples. */
  factor(key, now) {
    const b = this.bins[key] && this.bins[key][binOf(now)];
    if (!b) return { k: PRIOR_K, n: 0 };
    return { k: (b.n * b.k + PRIOR_WEIGHT * PRIOR_K) / (b.n + PRIOR_WEIGHT), n: b.n };
  }

  /** Per-inverter available power and headroom. inverters: [{ key, kwp, acKw, kw }]. */
  estimate({ now, irradiance, inverters }) {
    return inverters.map((inv) => {
      const { k, n } = this.factor(inv.key, now);
      const availableKw = inv.kwp > 0 && Number.isFinite(irradiance)
        ? Math.min(capOf(inv), Math.max(0, irradiance / 1000) * inv.kwp * k)
        : NaN;
      const headroomKw = Number.isFinite(availableKw) && Number.isFinite(inv.kw) ? Math.max(0, availableKw - inv.kw) : NaN;
      // Small differences are model error, not throttling.
      const curtailed = Number.isFinite(headroomKw) && headroomKw > Math.max(0.3, 0.15 * availableKw);
      return { key: inv.key, kwp: inv.kwp, acKw: inv.acKw > 0 ? inv.acKw : null, kw: inv.kw,
               k, samples: n, availableKw, headroomKw, curtailed };
    });
  }
}

module.exports = { SolarEstimator, isUnconstrained, binOf, PRIOR_K, MIN_IRRADIANCE };
