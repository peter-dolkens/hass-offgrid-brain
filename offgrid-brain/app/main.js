/* Off-Grid Brain — entry point.

   Each tick: read sources -> build context -> walk the dispatch list -> actuate.

   SAFE MODE is the important part. Battery SoC is the input every charge rung and
   the whole autonomy signal depend on. If it is missing or stale we must NOT guess
   optimistically: on an off-grid system an over-optimistic SoC flattens the bank.
   So an unreadable SoC is treated as "at reserve", which collapses the reachable
   depth of the list to the non-sheddable top entries and sheds everything else.
   Fail-safe here means fail-austere. */
"use strict";
const fs = require("fs");
const log = require("./log.js");
const { loadOptions, loadPolicy, validate, POLICY_PATH } = require("./config.js");
const { HAClient } = require("./sources/ha.js");
const { FroniusPoller } = require("./sources/fronius.js");
const { SplinkPoller } = require("./sources/splink.js");
const { pick, STALE_SEC } = require("./sources/pick.js");
const { Actuator } = require("./sinks/actuator.js");
const { MqttSink } = require("./sinks/mqtt.js");
const { decide } = require("./policy/dispatch.js");
const { buildContext, LoadHistory } = require("./policy/context.js");

const STATE_PATH = "/data/brain-state.json";

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(s)); } catch (e) { log.warn("could not persist state", e.message); }
}

async function main() {
  const opt = loadOptions();
  log.setLevel(opt.log_level || "info");

  const dryRun = opt.dry_run !== false;    // default ON — must be explicitly disabled
  const tickSec = opt.tick_seconds || 30;
  const battery = Object.assign(
    { capacity_kwh: 51.8, inverter_kw: 7.5, max_charge_kw: 7.5, reserve_pct: 10 },
    opt.battery
  );
  const sources = opt.sources || {};
  const devices = opt.devices || [];

  log.info("=".repeat(64));
  log.info(`Off-Grid Brain ${require("./package.json").version} — ${dryRun ? "DRY RUN (actuating nothing)" : "LIVE CONTROL"}`);
  log.info(`battery ${battery.capacity_kwh} kWh / ${battery.inverter_kw} kW, reserve ${battery.reserve_pct}%`);

  const policy = loadPolicy();
  const problems = validate(policy, devices);
  for (const p of problems) log.warn(`policy: ${p}`);

  // ---- sources -------------------------------------------------------------
  const ha = new HAClient({ token: process.env.SUPERVISOR_TOKEN });
  ha.track(Object.values(sources).filter(Boolean));
  ha.track(devices.map((d) => d.switch).filter(Boolean));
  ha.track(devices.map((d) => d.power_sensor).filter(Boolean));
  ha.connect();

  const froniusCfg = opt.fronius || {};
  const fronius = new FroniusPoller({ hosts: froniusCfg.hosts || [], pollSeconds: froniusCfg.poll_seconds });
  if (froniusCfg.enabled) fronius.start();

  const splinkCfg = opt.splink || {};
  const splink = new SplinkPoller({
    urls: splinkCfg.urls,
    pollSeconds: splinkCfg.poll_seconds,
    accessClientId: splinkCfg.access_client_id,
    accessClientSecret: splinkCfg.access_client_secret,
  });
  if (splinkCfg.enabled) splink.start();

  const mqttSink = new MqttSink({
    enabled: (opt.mqtt || {}).enabled,
    discoveryPrefix: (opt.mqtt || {}).discovery_prefix,
    broker: {
      host: process.env.MQTT_HOST, port: process.env.MQTT_PORT,
      username: process.env.MQTT_USER, password: process.env.MQTT_PASSWORD,
    },
  });
  mqttSink.connect();

  const actuator = new Actuator({ ha, devices, dryRun });

  // ---- persistent load history (autonomy denominator) ----------------------
  const au = Object.assign({ seed_load_kwh: 30, window_days: 7 }, opt.autonomy);
  const saved = loadState();
  const history = LoadHistory.fromJSON(saved.history, au.window_days, au.seed_load_kwh);

  // ---- tick ----------------------------------------------------------------
  async function tick() {
    const now = new Date();

    // Each input takes the first FRESH reading, most direct path first: the
    // splink bridge, then a mapped HA entity, then (PV only) direct Fronius.
    const sp = splinkCfg.enabled ? splink.readings : {};
    const kw = (r) => ({ value: r.value / 1000, ageSec: r.ageSec });   // HA powers are W
    const fronPv = froniusCfg.enabled ? { value: fronius.pvKw, ageSec: fronius.ageSec } : null;
    const socEnt = pick([["splink", sp.soc], ["ha", ha.number(sources.battery_soc)]]);
    const loadEnt = pick([["splink", sp.loadKw], ["ha", kw(ha.number(sources.load_power))]]);
    const pvEnt = pick([["splink", sp.pvKw], ["ha", kw(ha.number(sources.pv_power))], ["fronius", fronPv]]);
    const pvKw = pvEnt.value, pvAge = pvEnt.ageSec;
    const toutEnt = ha.number(sources.outdoor_temp);
    const fcEnt = ha.number(sources.pv_forecast_today);

    // --- fail-austere on a missing/stale SoC ---
    const socUsable = Number.isFinite(socEnt.value) && socEnt.ageSec < STALE_SEC;
    const safeMode = !socUsable;
    const soc = socUsable ? socEnt.value : battery.reserve_pct;
    if (safeMode) {
      const configured = splinkCfg.enabled || sources.battery_soc;
      log.warn(`SAFE MODE — battery SoC ${configured ? "unavailable or stale" : "not configured"}${Number.isFinite(socEnt.ageSec) ? ` (newest reading ${socEnt.ageSec.toFixed(0)}s old)` : ""}; assuming reserve (${battery.reserve_pct}%) and shedding all discretionary load`);
    }

    const loadKw = Number.isFinite(loadEnt.value) && loadEnt.ageSec < STALE_SEC ? loadEnt.value : NaN;
    history.add(now.toISOString().slice(0, 10), loadKw, tickSec);

    const ctx = buildContext({
      now,
      soc,
      pvKw: Number.isFinite(pvKw) && pvAge < STALE_SEC ? pvKw : 0,   // unknown PV = assume none
      loadKw,
      toutC: Number.isFinite(toutEnt.value) ? toutEnt.value : 20,
      forecastKwh: Number.isFinite(fcEnt.value) ? fcEnt.value : NaN,
      history,
      battery,
    });

    const result = decide(policy, ctx, { ...battery, tick_hours: tickSec / 3600 });
    for (const e of result.errors) log.error(`policy expression: ${e}`);

    log.info(
      `tick soc=${Number.isFinite(socEnt.value) ? socEnt.value.toFixed(1) : "??"}%(${socEnt.from}) ` +
      `load=${Number.isFinite(loadKw) ? (loadKw * 1000).toFixed(0) : "??"}W(${loadEnt.from}) ` +
      `pv=${(ctx.pv * 1000).toFixed(0)}W(${pvEnt.from}) ` +
      `autonomy=${ctx.autonomy.toFixed(2)}d floor=${result.floorPct}% ` +
      `run=[${result.decisions.filter((d) => d.run).map((d) => d.id).join(",")}] ` +
      `shed=[${result.shed.map((d) => d.id).join(",")}]`
    );
    for (const s of result.shed) log.debug(`  shed ${s.id}: ${s.reason}`);
    if (result.deficitKw > 0) {
      // Everything sheddable is already off and the bank still cannot carry the
      // unsheddable loads. This is the generator/V2L condition in the simulator.
      log.warn(`DEFICIT ${result.deficitKw.toFixed(3)} kW — unsheddable loads [${result.unbacked.map((d) => d.id).join(",")}] exceed what solar and battery can supply`);
    }

    await actuator.apply(result.decisions);
    mqttSink.publishTick({ ctx, result, safeMode });
    saveState({ history: history.toJSON(), updated: now.toISOString() });
  }

  setInterval(() => tick().catch((e) => log.error("tick failed", e.stack || e.message)), tickSec * 1000);
  setTimeout(() => tick().catch((e) => log.error("first tick failed", e.stack || e.message)), 3000);

  process.on("SIGTERM", () => { log.info("shutting down"); saveState({ history: history.toJSON() }); process.exit(0); });
}

main().catch((e) => { log.error("fatal", e.stack || e.message); process.exit(1); });
