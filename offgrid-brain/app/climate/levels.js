/* The comfort levels a climate zone offers the dispatch ladder, loosest first.

   Each is a band around the zone's comfort setpoints, expressed as an offset `sp`
   (°C toward ambient, the simulator's meaning of `sp`): protect is the widest,
   soak goes past the comfort setpoint into the band's far edge (sp < 0).

   The simulator (offgrid-sim/web/sim.js) carries the same level names in
   CLIMATE_LEVELS; test/engine-sync.test.js checks they agree. */
"use strict";

const LEVELS = ["protect", "setback", "comfort", "precondition", "soak"];

/* Where each level is placed when a zone has no entries of its own in the list,
   by the zone's energy class: the charge rung it goes after (the first rung at or
   above this %), and whether going unserved flags it as shed (important).
   null = not placed. "end" = the end of the list (surplus only). */
const AUTO = {
  essential: { protect: [0, true], setback: [0, true], comfort: [40, true], precondition: [60, false], soak: ["end", false] },
  comfort:   { protect: [0, true], setback: [40, false], comfort: [60, false], precondition: [80, false], soak: ["end", false] },
  luxury:    { protect: [40, false], setback: [60, false], comfort: [80, false], precondition: null, soak: ["end", false] },
};
const ENERGY_CLASSES = Object.keys(AUTO);

/** Default importance of a level for a zone class (explicit entries may override). */
const importantByDefault = (cls, level) => { const a = (AUTO[cls] || AUTO.comfort)[level]; return !!(a && a[1]); };

module.exports = { LEVELS, AUTO, ENERGY_CLASSES, importantByDefault };
