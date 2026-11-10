/* When does a battery "reach" a charge rung it sits just below?

   A battery near full tapers to a trickle and may never read exactly 100%; one
   charging towards 40% can hover at 39.9%. So a rung counts as reached once the
   battery has stayed close enough for long enough, and the further below, the
   longer it must stay:

     curve  [{ below_pct, seconds }], e.g. 0.1% for 60 s, 1% for 120 s, 2% for 15 min
            (interpolated between points, from 0% needing 0 s; deeper than the last
            point never counts)

   history is [[epoch ms, soc], ...] oldest first, ending with now. The check walks
   back from now keeping the deepest dip seen so far: the rung is reached if, for
   some window ending now, the window is at least as long as the deepest dip in it
   requires. A dip half way through restarts the clock at its own depth. */
"use strict";

const DEFAULT_CURVE = Object.freeze([
  { below_pct: 0.1, seconds: 60 },
  { below_pct: 1, seconds: 120 },
  { below_pct: 2, seconds: 900 },
]);

/** Seconds the battery must stay within `below` % of a rung; Infinity past the curve. */
function requiredSeconds(below, curve = DEFAULT_CURVE) {
  if (below <= 0) return 0;
  const pts = [{ below_pct: 0, seconds: 0 }, ...curve].sort((a, b) => a.below_pct - b.below_pct);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (below <= b.below_pct) return a.seconds + ((below - a.below_pct) / (b.below_pct - a.below_pct)) * (b.seconds - a.seconds);
  }
  return Infinity;
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
    if (!Number.isFinite(need)) return false;
    if ((now - t) / 1000 >= need) return true;
  }
  return false;
}

/** How much history the curve can ever need, in ms (plus a margin). */
const horizonMs = (curve = DEFAULT_CURVE) => (Math.max(0, ...curve.map((p) => p.seconds)) + 60) * 1000;

module.exports = { reached, requiredSeconds, horizonMs, DEFAULT_CURVE };
