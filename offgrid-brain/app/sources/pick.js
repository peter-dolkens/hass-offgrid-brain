/* Choosing between sources that measure the same quantity. */
"use strict";

const STALE_SEC = 300;   // a reading older than this is not trusted

/** First fresh reading among [label, {value, ageSec}] candidates. When none is
    fresh, return the newest stale one (for logging) so callers still see NaN/age. */
function pick(candidates) {
  let newest = { value: NaN, ageSec: Infinity, from: "none" };
  for (const [from, r] of candidates) {
    if (!r || !Number.isFinite(r.value)) continue;
    if (r.ageSec < STALE_SEC) return { ...r, from };
    if (r.ageSec < newest.ageSec) newest = { ...r, from: `${from},stale` };
  }
  return newest;
}

module.exports = { pick, STALE_SEC };
