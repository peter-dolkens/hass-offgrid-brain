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
