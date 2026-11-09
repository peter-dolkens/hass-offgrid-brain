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
const { loadOptions, loadPolicy, check, validate, POLICY_PATH } = require("./config.js");
const { HAClient } = require("./sources/ha.js");
const { FroniusPoller } = require("./sources/fronius.js");
const { SplinkPoller } = require("./sources/splink.js");
const { EcowittPoller } = require("./sources/ecowitt.js");
const { SolarEstimator, isUnconstrained } = require("./policy/solar.js");
const { pick, STALE_SEC } = require("./sources/pick.js");
const { Actuator } = require("./sinks/actuator.js");
const { MqttSink, resolveBroker } = require("./sinks/mqtt.js");
const { decide } = require("./policy/dispatch.js");
const { buildContext, LoadHistory } = require("./policy/context.js");
const { startServer } = require("./web/server.js");
const VERSION = require("./package.json").version;

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
  // Short by default: shedding has to act within the inverter's surge window, and
  // the walk itself costs microseconds. Per-device dwell stops relays chattering.
  const tickSec = opt.tick_seconds || 5;
  const battery = Object.assign(
    { capacity_kwh: 51.8, inverter_kw: 7.5, max_charge_kw: 7.5, reserve_pct: 10 },
    opt.battery
  );
  const sources = opt.sources || {};
  const devices = opt.devices || [];

  log.info("=".repeat(64));
  log.info(`Off-Grid Brain ${VERSION} — ${dryRun ? "DRY RUN (actuating nothing)" : "LIVE CONTROL"}`);
  log.info(`battery ${battery.capacity_kwh} kWh / ${battery.inverter_kw} kW, reserve ${battery.reserve_pct}%`);

  let policy = loadPolicy();
  for (const p of validate(policy, devices)) log.warn(`policy: ${p}`);
  const limits = { ...battery, tick_hours: tickSec / 3600 };

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
    fastSeconds: splinkCfg.fast_seconds,
    accessClientId: splinkCfg.access_client_id,
    accessClientSecret: splinkCfg.access_client_secret,
  });
  if (splinkCfg.enabled) splink.start();

  const ecowittCfg = opt.ecowitt || {};
  const ecowitt = new EcowittPoller({ urls: ecowittCfg.urls, pollSeconds: ecowittCfg.poll_seconds });
  if (ecowittCfg.enabled) ecowitt.start();

  const mqttCfg = opt.mqtt || {};
  const mqttSink = new MqttSink({
    enabled: mqttCfg.enabled,
    discoveryPrefix: mqttCfg.discovery_prefix,
    broker: mqttCfg.enabled ? await resolveBroker(mqttCfg, process.env.SUPERVISOR_TOKEN) : null,
  });
  mqttSink.connect();

  const actuator = new Actuator({ ha, devices, dryRun });

  // ---- persistent load history (autonomy denominator) ----------------------
  const au = Object.assign({ seed_load_kwh: 30, window_days: 7 }, opt.autonomy);
  const saved = loadState();
  const history = LoadHistory.fromJSON(saved.history, au.window_days, au.seed_load_kwh);

  // Per-array factors learned so far (irradiance -> available kW) survive restarts.
  const solarCfg = opt.solar || {};
  const estimator = new SolarEstimator({ acKw: solarCfg.inverter_ac_kw || 10, state: saved.solar });

  // ---- web UI (ingress) ----------------------------------------------------
  // What the UI shows is exactly what the last tick decided, plus the context it
  // decided in, so a candidate policy can be previewed against the same moment.
  let snapshot = { starting: true, version: VERSION, dryRun };
  let lastCtx = null;
  const summarise = (r) => ({
    trace: r.trace, decisions: r.decisions, floorPct: r.floorPct, chargeKw: r.charge,
    deficitKw: r.deficitKw, budgetKw: r.budget, errors: r.errors,
  });
  startServer({
    port: Number(process.env.INGRESS_PORT) || 8099,
    allowAny: process.env.BRAIN_UI_ALLOW_ANY === "1",
    policyPath: POLICY_PATH,
    getState: () => snapshot,
    getPolicy: () => policy,
    check,
    preview: (p) => (lastCtx ? summarise(decide(p, lastCtx, limits)) : null),
    apply: (p) => {
      policy = p;
      for (const w of validate(policy, devices)) log.warn(`policy: ${w}`);
      runTick();   // show the new policy's decisions straight away
    },
  });

  // ---- tick ----------------------------------------------------------------
  let ticking = false;
  let lastSignature = null, lastInfoAt = 0;
  const HEARTBEAT_MS = 5 * 60 * 1000;
  function runTick() {
    if (ticking) return;
    ticking = true;
    tick().catch((e) => log.error("tick failed", e.stack || e.message)).finally(() => { ticking = false; });
  }

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
    const pvAge = pvEnt.ageSec;
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

    // --- available solar ---
    // Off grid the inverters are throttled to the load once the battery is full,
    // so delivered PV understates the sun. Estimate what each array COULD give
    // from irradiance, learning each array's factor while it's unthrottled.
    const irrEnt = pick([["ecowitt", ecowitt.irradiance], ["ha", ha.number(sources.irradiance)]]);
    const irradiance = irrEnt.ageSec < STALE_SEC ? irrEnt.value : NaN;
    const pvDelivered = Number.isFinite(pvEnt.value) && pvAge < STALE_SEC ? pvEnt.value : NaN;
    const arrays = (sp.inverters || []).map((i) => ({
      key: i.key, name: i.name, kwp: solarCfg.kwp || i.kwp,
      kw: i.powerKw.ageSec < STALE_SEC ? i.powerKw.value : NaN,
    }));
    const unconstrained = isUnconstrained({
      socPct: socUsable ? socEnt.value : NaN,
      batteryKw: sp.batteryKw && sp.batteryKw.ageSec < STALE_SEC ? sp.batteryKw.value : NaN,
      pvKw: pvDelivered,
      loadKw, chargeLimitKw: sp.chargeLimitKw,
    });
    estimator.learn({ now, irradiance, inverters: arrays, unconstrained });
    const perArray = Number.isFinite(irradiance) ? estimator.estimate({ now, irradiance, inverters: arrays }) : [];
    const pvAvailable = perArray.length && perArray.every((a) => Number.isFinite(a.availableKw))
      ? perArray.reduce((t, a) => t + a.availableKw, 0) : NaN;
    // Dispatch spends what the sun can give, not just what was delivered.
    const pvKw = Number.isFinite(pvAvailable) ? Math.max(pvDelivered || 0, pvAvailable) : pvDelivered;
    const solar = {
      irradiance: irrEnt, deliveredKw: pvDelivered, availableKw: pvAvailable,
      headroomKw: Number.isFinite(pvAvailable) && Number.isFinite(pvDelivered) ? Math.max(0, pvAvailable - pvDelivered) : NaN,
      curtailed: perArray.some((a) => a.curtailed), unconstrained,
      charger: sp.charger || null, arrays: perArray.map((a, n) => ({ ...a, name: arrays[n].name })),
    };

    const ctx = buildContext({
      now,
      soc,
      pvKw: Number.isFinite(pvKw) ? pvKw : 0,   // unknown PV = assume none
      loadKw,
      toutC: Number.isFinite(toutEnt.value) ? toutEnt.value : 20,
      forecastKwh: Number.isFinite(fcEnt.value) ? fcEnt.value : NaN,
      history,
      battery,
    });

    const result = decide(policy, ctx, limits);
    for (const e of result.errors) log.error(`policy expression: ${e}`);

    // Log at info only when what runs changes (and as a heartbeat); every tick at debug.
    const line =
      `tick soc=${Number.isFinite(socEnt.value) ? socEnt.value.toFixed(1) : "??"}%(${socEnt.from}) ` +
      `load=${Number.isFinite(loadKw) ? (loadKw * 1000).toFixed(0) : "??"}W(${loadEnt.from}) ` +
      `pv=${(ctx.pv * 1000).toFixed(0)}W(${pvEnt.from}) ` +
      `autonomy=${ctx.autonomy.toFixed(2)}d floor=${result.floorPct}% ` +
      `run=[${result.decisions.filter((d) => d.run).map((d) => d.id).join(",")}] ` +
      `shed=[${result.shed.map((d) => d.id).join(",")}]`;
    const signature = `${safeMode}|${result.decisions.map((d) => `${d.id}:${d.run}`).join(",")}`;
    if (signature !== lastSignature || now - lastInfoAt >= HEARTBEAT_MS) {
      log.info(line);
      lastSignature = signature;
      lastInfoAt = now;
    } else {
      log.debug(line);
    }
    for (const s of result.shed) log.debug(`  shed ${s.id}: ${s.reason}`);
    if (result.deficitKw > 0) {
      // Everything sheddable is already off and the bank still cannot carry the
      // unsheddable loads. This is the generator/V2L condition in the simulator.
      log.warn(`DEFICIT ${result.deficitKw.toFixed(3)} kW — unsheddable loads [${result.unbacked.map((d) => d.id).join(",")}] exceed what solar and battery can supply`);
    }

    lastCtx = ctx;
    snapshot = {
      time: now.toISOString(), version: VERSION, dryRun, safeMode, tickSec, battery,
      inputs: { soc: socEnt, loadKw: loadEnt, pvKw: pvEnt, batteryKw: sp.batteryKw || null, energy: sp.energy || null, inverters: sp.inverters || [] },
      splinkSource: splinkCfg.enabled ? splink.source : null,
      solar,
      ctx,
      result: summarise(result),
      devices: devices.map((d) => ({ id: d.id, name: d.name, switch: d.switch || null })),
    };

    await actuator.apply(result.decisions);
    mqttSink.publishTick({ ctx, result, safeMode, dryRun, inputs: snapshot.inputs, solar });
    saveState({ history: history.toJSON(), solar: estimator.toJSON(), updated: now.toISOString() });
  }

  setInterval(runTick, tickSec * 1000);
  setTimeout(runTick, 3000);

  process.on("SIGTERM", () => {
    log.info("shutting down");
    saveState({ history: history.toJSON(), solar: estimator.toJSON() });
    process.exit(0);
  });
}

main().catch((e) => { log.error("fatal", e.stack || e.message); process.exit(1); });
