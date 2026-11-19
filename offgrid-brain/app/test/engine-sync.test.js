/* Guards the one thing the whole Node decision rests on: that the add-on's vendored
   expression engine is still byte-identical to the simulator's. If this fails, a
   policy proven in offgrid-sim is no longer necessarily the policy the house runs.
   Skips silently inside the container, where the simulator source is not present. */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SIM = path.join(__dirname, "..", "..", "..", "..", "offgrid-sim", "web", "expr.js");
const HASH_FILE = path.join(__dirname, "..", "policy", ".expr.sha256");

if (!fs.existsSync(SIM)) {
  console.log("engine-sync:\n  skip  simulator source not present (running outside the project tree)");
  process.exit(0);
}

const actual = crypto.createHash("sha256").update(fs.readFileSync(SIM)).digest("hex");
const recorded = fs.readFileSync(HASH_FILE, "utf8").trim();

console.log("engine-sync:");
if (actual === recorded) {
  console.log(`  ok  vendored expr.js matches offgrid-sim (${actual.slice(0, 12)}…)`);
} else {
  console.error(`  FAIL vendored expr.js is STALE\n       simulator: ${actual}\n       vendored:  ${recorded}\n       run tools/sync-policy-engine.sh`);
  process.exitCode = 1;
}

// The variable lists must also agree, or expressions silently mean different things.
const simSrc = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "offgrid-sim", "web", "sim.js"), "utf8");
const m = simSrc.match(/const VARS = \[([^\]]+)\]/);
const simVars = m[1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
const brainVars = require("../policy/dispatch.js").VARS;
const same = simVars.length === brainVars.length && simVars.every((v, i) => v === brainVars[i]);
if (same) console.log(`  ok  VARS identical in both engines (${brainVars.length})`);
else { console.error(`  FAIL VARS differ\n       sim:   ${simVars.join(",")}\n       brain: ${brainVars.join(",")}`); process.exitCode = 1; }

// The climate level table is vendored too, byte for byte.
const SIM_LEVELS = path.join(__dirname, "..", "..", "..", "..", "offgrid-sim", "web", "climate-levels.js");
const levelsHash = fs.existsSync(SIM_LEVELS) ? crypto.createHash("sha256").update(fs.readFileSync(SIM_LEVELS)).digest("hex") : "missing";
const levelsRecorded = fs.readFileSync(path.join(__dirname, "..", "policy", ".climate-levels.sha256"), "utf8").trim();
if (levelsHash === levelsRecorded) console.log(`  ok  vendored climate-levels.js matches offgrid-sim (${levelsHash.slice(0, 12)}…)`);
else { console.error(`  FAIL vendored climate-levels.js is STALE (simulator ${levelsHash}, vendored ${levelsRecorded}); run tools/sync-policy-engine.sh`); process.exitCode = 1; }
const brainLevels = require("../climate/levels.js");
const simLevelsMod = require(SIM_LEVELS);
if (JSON.stringify(simLevelsMod) === JSON.stringify(brainLevels.Shared)) console.log("  ok  climate level table identical in both engines");
else { console.error("  FAIL climate level tables differ"); process.exitCode = 1; }

// And the simulator must honour the load-entry fields the brain's decide() does
// (kw, vars, floor), or a climate policy means different things in the two.
const Sim = require(path.join(__dirname, "..", "..", "..", "..", "offgrid-sim", "web", "sim.js"));
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "offgrid-sim", "web", "data.json"), "utf8"));
const run = (entry) => { const c = Sim.defaults(); c.list = [{ type: "charge", to: 20 }, entry]; return Sim.simulate(data, c); };
const kwRun = run({ type: "load", dev: "fridge", cond: "1", kw: 0.05 });
const hours = kwRun.hours;
const okKw = Math.abs(kwRun.servedKwh.fridge - 0.05 * hours) < 0.05 * hours * 0.02;
const okVars = !(run({ type: "load", dev: "fridge", cond: "occ", kw: 0.05, vars: { occ: 0 } }).servedKwh.fridge > 0);
const okFloor = run({ type: "load", dev: "compute", cond: "1", floor: 95 }).servedKwh.compute < run({ type: "load", dev: "compute", cond: "1" }).servedKwh.compute;
if (okKw && okVars && okFloor) console.log("  ok  simulator honours entry kw, vars and floor");
else { console.error(`  FAIL simulator ignores entry fields: kw ${okKw} vars ${okVars} floor ${okFloor}`); process.exitCode = 1; }
if (Sim.CLIMATE_LEVELS.join() === brainLevels.LEVELS.join()) console.log(`  ok  climate levels identical in both engines (${brainLevels.LEVELS.join(", ")})`);
else { console.error("  FAIL climate levels differ"); process.exitCode = 1; }
