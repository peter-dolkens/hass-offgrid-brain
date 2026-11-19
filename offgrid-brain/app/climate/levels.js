/* The comfort levels a climate zone offers the dispatch ladder, loosest first.

   The table itself is shared with the simulator: policy/climate-levels.js is
   vendored from offgrid-sim/web/climate-levels.js (tools/sync-policy-engine.sh),
   so a level means the same thing in a backtest and in the house. */
"use strict";
const Shared = require("../policy/climate-levels.js");

const { LEVELS, FLOORS, IMPORTANT, DEFAULTS } = Shared;
const ENERGY_CLASSES = Object.keys(FLOORS);

/** Where a level goes when auto-placed: "gen" (above the first rung, never shed),
    a floor %, or null (not offered). */
const autoFloor = (cls, level) => (FLOORS[cls] || FLOORS.comfort)[level];

/** Default importance of a level for a zone class (explicit entries may override). */
const importantByDefault = (cls, level) => level === "protect" || !!(IMPORTANT[cls] || {})[level];

module.exports = { LEVELS, FLOORS, DEFAULTS, ENERGY_CLASSES, autoFloor, importantByDefault, Shared };
