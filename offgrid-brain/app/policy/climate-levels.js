/* VENDORED from offgrid-sim/web/climate-levels.js — DO NOT EDIT HERE.
   Edit the simulator copy, then run ha-addon/offgrid-brain/tools/sync-policy-engine.sh
   Source sha256: b4c1f0036b09ba6e39114e9ff449af2ef8c8f40651b7415c3412a12a5298e7bc */
/* Climate comfort levels: the one table the simulator and the Off-Grid Brain share.
   OWNED HERE and vendored into the add-on by ha-addon/offgrid-brain/tools/sync-policy-engine.sh;
   the add-on's engine-sync test checks the copy is identical.

   A zone offers its levels to the dispatch list, loosest first. Each is an offset `sp`
   from the comfort setpoint toward ambient (sp < 0 = past it, thermal storage):
     protect       hold PROTECT_MIN_C heating / PROTECT_MAX_C cooling; never shed (gen-like)
     setback       sp = SETBACK_C (AWAY_C when the house is away)
     comfort       sp = 0, while occupied
     precondition  sp = 0, ahead of predicted occupancy
     soak          sp = -SOAK_C toward the band's far edge, on surplus

   FLOORS: when a zone has no entries of its own, where its levels go, by energy class.
   A number is the battery % the entry needs (its own floor, on top of the charge rung
   above it); "gen" = above the first charge rung and never shed; null = not offered.
   Entries other than protect and soak go just after the first charge rung, so their
   floor, not their position, sets how deep they may draw the battery. */
(function (root) {
  "use strict";
  const ClimateLevels = {
    LEVELS: ["protect", "setback", "comfort", "precondition", "soak"],
    DEFAULTS: { setback_c: 3, away_c: 6, soak_c: 3, protect_min_c: 10, protect_max_c: 32 },
    FLOORS: {
      essential: { protect: "gen", setback: 0, comfort: 30, precondition: 50, soak: 100 },
      comfort:   { protect: "gen", setback: 30, comfort: 40, precondition: 60, soak: 100 },
      luxury:    { protect: "gen", setback: 50, comfort: 60, precondition: null, soak: 100 },
    },
    // Levels whose going unserved flags the zone as shed (protect can't go unserved).
    IMPORTANT: {
      essential: { setback: true, comfort: true },
      comfort: { setback: false },
      luxury: {},
    },
    /** sp for a level, heating or cooling, around a comfort setpoint T. */
    sp(level, heat, T, d) {
      d = d || ClimateLevels.DEFAULTS;
      switch (level) {
        case "protect": return Math.max(d.setback_c, heat ? T - d.protect_min_c : d.protect_max_c - T);
        case "setback": return d.setback_c;
        case "soak": return -d.soak_c;
        default: return 0;
      }
    },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = ClimateLevels;
  else root.ClimateLevels = ClimateLevels;
})(typeof window !== "undefined" ? window : globalThis);
