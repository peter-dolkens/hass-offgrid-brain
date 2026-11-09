/* Offline dry-run: feed the brain a scenario and print what it would do.
   Lets you sanity-check a policy.json without a HAOS instance.
     node tools-dryrun.js [path/to/policy.json] */
"use strict";
const fs = require("fs");
const path = require("path");
const { decide } = require("./policy/dispatch.js");
const { buildContext, LoadHistory } = require("./policy/context.js");

const policyPath = process.argv[2] || path.join(__dirname, "policy", "policy.default.json");
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const battery = { capacity_kwh: 51.8, inverter_kw: 7.5, max_charge_kw: 7.5, reserve_pct: 10, tick_hours: 30 / 3600 };

const scenarios = [
  { label: "midday, sunny, bank full",        when: "2026-06-15T12:00:00", soc: 100, pv: 12.0, tout: 14 },
  { label: "midday, overcast winter",         when: "2026-06-15T12:00:00", soc: 55,  pv: 1.2,  tout: 8 },
  { label: "3am winter, bank half",           when: "2026-06-15T03:00:00", soc: 50,  pv: 0,    tout: 2 },
  { label: "3am day-3 of an overcast run",    when: "2026-05-30T03:00:00", soc: 24,  pv: 0,    tout: 4 },
  { label: "critical — at reserve, no sun",   when: "2026-05-30T05:00:00", soc: 10,  pv: 0,    tout: 3 },
  { label: "SoC sensor lost (safe mode)",     when: "2026-06-15T12:00:00", soc: 10,  pv: 6.0,  tout: 14, note: "brain substitutes reserve%" },
];

console.log(`policy: ${policyPath}`);
console.log(`devices: ${policy.devices.map((d) => d.id).join(", ")}\n`);

for (const s of scenarios) {
  const history = new LoadHistory(7, 30);
  const ctx = buildContext({
    now: new Date(s.when), soc: s.soc, pvKw: s.pv, loadKw: 1.0, toutC: s.tout,
    forecastKwh: NaN, history, battery,
  });
  const r = decide(policy, ctx, battery);
  const run = r.decisions.filter((d) => d.run).map((d) => d.id);
  const shed = r.shed.map((d) => d.id);
  console.log(`${s.label}${s.note ? ` (${s.note})` : ""}`);
  console.log(`  soc ${String(s.soc).padStart(3)}%  pv ${String(s.pv).padStart(5)} kW  autonomy ${ctx.autonomy.toFixed(2)}d  floor ${r.floorPct}%  charging ${r.charge.toFixed(2)} kW`);
  console.log(`  RUN  [${run.join(", ") || "-"}]`);
  console.log(`  SHED [${shed.join(", ") || "-"}]`);
  for (const d of r.shed) console.log(`         ${d.id}: ${d.reason}`);
  console.log("");
}
