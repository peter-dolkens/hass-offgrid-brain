/* When does a battery "reach" a charge rung it sits just below?

   A battery near full tapers to a trickle and may never read exactly 100%; one
   charging towards 40% can hover at 39.9%. So a rung counts as reached once the
   battery has stayed close enough for long enough, and the further below, the
   longer it must stay, on a smooth curve:

     required seconds = base_seconds * e^(growth * depth^2),  depth in % below the rung

   With the defaults (60 s, 0.7): 0.1% -> 60 s, 0.5% -> 71 s, 1% -> 2 min,
   1.5% -> 4.8 min, 2% -> 16 min, 2.5% -> 1.3 h, 3% -> 9 h (in practice never).
   Nearly flat close to the rung, so jitter at 99.8-99.9% barely matters; steep
   further down, fading into "never" without a hard cut-off.

   history is [[epoch ms, soc], ...] oldest first, ending with now. The check walks
   back from now keeping the deepest dip seen so far: the rung is reached if, for
   some window ending now, the window is at least as long as the deepest dip in it
   requires. A dip half way through restarts the clock at its own depth. */
"use strict";

const DEFAULT_CURVE = Object.freeze({ base_seconds: 60, growth: 0.7 });
const MAX_WINDOW_SEC = 2 * 3600;   // history kept; a dip needing longer never counts

/** Seconds the battery must stay within `below` % of a rung. */
function requiredSeconds(below, curve = DEFAULT_CURVE) {
  if (below <= 0) return 0;
  const c = curve && Number.isFinite(curve.base_seconds) ? curve : DEFAULT_CURVE;
  return c.base_seconds * Math.exp(c.growth * below * below);
}

/** Has the battery reached rung `to`, given recent history? At or above it always counts. */
function reached(to, history, curve = DEFAULT_CURVE) {
  if (!history || !history.length) return false;
  const [now, socNow] = history[history.length - 1];
  if (socNow >= to) return true;
  let deepest = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const [t, soc] = history[i];
    deepest = Math.max(deepest, to - soc);
    const need = requiredSeconds(deepest, curve);
    if (need > MAX_WINDOW_SEC) return false;
    if ((now - t) / 1000 >= need) return true;
  }
  return false;
}

/** How much history to keep, in ms. */
const horizonMs = () => (MAX_WINDOW_SEC + 60) * 1000;

module.exports = { reached, requiredSeconds, horizonMs, DEFAULT_CURVE, MAX_WINDOW_SEC };
