/* Off-Grid Brain — entry point.

   Each tick: read sources -> build context -> walk the dispatch list -> actuate.

   SAFE MODE is the important part. Battery SoC is the input every charge rung and
   the whole autonomy signal depend on. If it is missing or stale we must NOT guess
   optimistically: on an off-grid system an over-optimistic SoC flattens the bank.
   So an unreadable SoC is treated as "at reserve", which collapses the reachable
   depth of the list to the non-sheddable top entries and sheds everything else.
   Fail-safe here means fail-austere.

   Configuration comes from two places. The add-on options hold only the log level
   and secrets (MQTT credentials, the Cloudflare Access token). Everything else is
   in /config/settings.json and /config/policy.json, edited from the web panel and
   applied live through applySettings() / applyPolicy(). */
"use strict";
const fs = require("fs");
const log = require("./log.js");
const { loadOptions, loadPolicy, check, validate, mergeDeviceOptions, POLICY_PATH } = require("./config.js");
const Settings = require("./settings.js");
const { HAClient } = require("./sources/ha.js");
const { InverterSet } = require("./sources/inverters.js");
const { readBattery, batteryEntities } = require("./sources/battery.js");
const { SplinkPoller } = require("./sources/splink.js");
const { EcowittPoller } = require("./sources/ecowitt.js");
const { SolarEstimator, isUnconstrained } = require("./policy/solar.js");
const { pick, STALE_SEC } = require("./sources/pick.js");
const { Actuator } = require("./sinks/actuator.js");
const { MqttSink, resolveBroker } = require("./sinks/mqtt.js");
const { decide } = require("./policy/dispatch.js");
const { buildContext, LoadHistory } = require("./policy/context.js");
const { startServer, savePolicy } = require("./web/server.js");
const VERSION = require("./package.json").version;

const STATE_PATH = "/data/brain-state.json";

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(s)); } catch (e) { log.warn("could not persist state", e.message); }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const opt = loadOptions();
  log.setLevel(opt.log_level || "info");

  let settings = Settings.loadSettings(opt);
  for (const p of Settings.check(settings)) log.warn(`settings: ${p}`);

  log.info("=".repeat(64));
  log.info(`Off-Grid Brain ${VERSION} — ${settings.dry_run ? "DRY RUN (actuating nothing)" : "LIVE CONTROL"}`);

  let policy = loadPolicy();
  // Devices used to take their switch/sensor/dwell from the add-on options.
  if (mergeDeviceOptions(policy, opt.devices)) {
    try { savePolicy(POLICY_PATH, policy); log.info("moved device switches from the add-on options into policy.json"); }
    catch (e) { log.warn(`could not save policy.json: ${e.message}`); }
  }
  for (const p of validate(policy)) log.warn(`policy: ${p}`);

  // Secrets stay in the add-on options; older installs had the Access token under splink.
  const access = opt.cloudflare_access || {};
  const accessId = access.client_id || (opt.splink && opt.splink.access_client_id) || "";
  const accessSecret = access.client_secret || (opt.splink && opt.splink.access_client_secret) || "";

  // ---- long-lived parts ----------------------------------------------------
  const ha = new HAClient({ token: process.env.SUPERVISOR_TOKEN });
  ha.connect();

  const mqttCfg = opt.mqtt || {};
  const mqttSink = new MqttSink({
    enabled: mqttCfg.enabled,
    discoveryPrefix: mqttCfg.discovery_prefix,
    broker: mqttCfg.enabled ? await resolveBroker(mqttCfg, process.env.SUPERVISOR_TOKEN) : null,
  });
  mqttSink.connect();

  const actuator = new Actuator({ ha, devices: policy.devices, dryRun: settings.dry_run });
  const saved = loadState();
  let history = LoadHistory.fromJSON(saved.history, settings.autonomy.window_days, settings.autonomy.seed_load_kwh);
  // Per-array factors learned so far (irradiance -> available kW) survive restarts.
  const estimator = new SolarEstimator({ state: saved.solar });

  // ---- parts rebuilt when their settings change ------------------------------
  let splink = null, ecowitt = null, timer = null;
  const inverters = new InverterSet({ ha });   // each solar inverter, read through its own integration
  let limits = null;

  function trackEntities() {
    ha.track(Object.values(settings.sources).filter(Boolean));
    ha.track(policy.devices.flatMap((d) => [d.switch, d.power_sensor]).filter(Boolean));
    ha.track(inverters.entities());
    ha.track(batteryEntities(settings.battery));
  }

  /** Make `next` the settings in force, rebuilding only what changed. */
  function applySettings(next, prev = null) {
    settings = next;
    const changed = (k) => !prev || !same(prev[k], next[k]);

    if (changed("dry_run")) {
      actuator.dryRun = next.dry_run;
      if (prev) log.warn(`control mode changed from the web panel: ${next.dry_run ? "DRY RUN" : "LIVE CONTROL"}`);
    }
    limits = { ...next.battery, tick_hours: next.tick_seconds / 3600 };
    if (prev && changed("autonomy")) {
      history = LoadHistory.fromJSON(history.toJSON(), next.autonomy.window_days, next.autonomy.seed_load_kwh);
    }
    if (changed("splink")) {
      if (splink) splink.stop();
      splink = new SplinkPoller({
        urls: next.splink.urls, pollSeconds: next.splink.poll_seconds, fastSeconds: next.splink.fast_seconds,
        accessClientId: accessId, accessClientSecret: accessSecret,
      });
      if (next.splink.enabled) splink.start();
    }
    if (changed("ecowitt")) {
      if (ecowitt) ecowitt.stop();
      ecowitt = new EcowittPoller({ urls: next.ecowitt.urls, pollSeconds: next.ecowitt.poll_seconds });
      if (next.ecowitt.enabled) ecowitt.start();
    }
    if (changed("solar")) inverters.configure(next.solar.inverters);
    if (changed("tick_seconds")) {
      if (timer) clearInterval(timer);
      timer = setInterval(runTick, next.tick_seconds * 1000);
    }
    trackEntities();
  }

  function applyPolicy(p) {
    policy = p;
    actuator.setDevices(p.devices);
    trackEntities();
    for (const w of validate(policy)) log.warn(`policy: ${w}`);
  }

  // ---- web UI (ingress) ----------------------------------------------------
  // What the UI shows is exactly what the last tick decided, plus the context it
  // decided in, so a candidate policy can be previewed against the same moment.
  let snapshot = { starting: true, version: VERSION, dryRun: settings.dry_run };
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
    apply: (p) => { applyPolicy(p); runTick(); },   // show the new policy's decisions straight away
    settingsPath: Settings.SETTINGS_PATH,
    getSettings: () => settings,
    checkSettings: (s) => Settings.check(Settings.normalise(s)),
    applySettings: (s) => {
      const next = Settings.normalise(s);
      Settings.save(next);
      applySettings(next, settings);
      log.info("settings updated from the web UI (previous kept as settings.json.bak)");
      runTick();
    },
    listEntities: () => ha.listEntities(),
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
    const { sources, battery } = settings;
    const tickSec = settings.tick_seconds;
    const dryRun = settings.dry_run;

    // Each input takes the first FRESH reading, most direct path first.
    const sp = settings.splink.enabled ? splink.readings : {};

    // One-time: pre-0.10 settings had a single AC rating for every inverter.
    const migrated = Settings.migrateSolar(settings, sp.inverters);
    if (migrated) {
      Settings.save(migrated);
      applySettings(migrated, settings);
      log.info(`solar: gave each inverter its own entry (${migrated.solar.inverters.map((i) => i.id).join(", ")}); edit them in Settings`);
    }
    // Solar: the configured inverters, each through its own integration. Their
    // sum is delivered PV when every live one has a fresh reading.
    const inv = inverters.read(sp);
    const liveInv = inv.filter((i) => i.live);
    const invSum = liveInv.length && liveInv.every((i) => Number.isFinite(i.powerKw.value) && i.powerKw.ageSec < STALE_SEC)
      ? { value: liveInv.reduce((t, i) => t + i.powerKw.value, 0), ageSec: Math.max(...liveInv.map((i) => i.powerKw.ageSec)) }
      : null;

    // The battery: SoC, house load, battery power and energy, through its integration.
    const batt = readBattery(battery, sp, ha);
    const socEnt = pick([[batt.source, batt.soc]]);
    const loadEnt = pick([[batt.source, batt.loadKw]]);
    // With no inverters configured, fall back to the bridge's own PV total.
    const pvEnt = pick([["inverters", invSum], ["splink", inv.length ? null : sp.pvKw]]);
    const pvAge = pvEnt.ageSec;
    const toutEnt = ha.number(sources.outdoor_temp);
    const fcEnt = ha.number(sources.pv_forecast_today);

    // --- fail-austere on a missing/stale SoC ---
    const socUsable = Number.isFinite(socEnt.value) && socEnt.ageSec < STALE_SEC;
    const safeMode = !socUsable;
    const soc = socUsable ? socEnt.value : battery.reserve_pct;
    if (safeMode) {
      const configured = battery.source !== "none";
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
    // Each inverter's own array size and AC rating (kWp falls back to what its
    // source reports). An inverter with no live reading still adds capacity.
    const arrays = inv.map((i) => ({
      key: i.id, name: i.name, kwp: i.kwp, acKw: i.acKw, source: i.source,
      kw: i.live && i.powerKw.ageSec < STALE_SEC ? i.powerKw.value : NaN,
    }));
    const unconstrained = isUnconstrained({
      socPct: socUsable ? socEnt.value : NaN,
      batteryKw: batt.batteryKw.ageSec < STALE_SEC ? batt.batteryKw.value : NaN,
      pvKw: pvDelivered,
      loadKw, chargeLimitKw: batt.chargeLimitKw,
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
      charger: batt.charger,
      arrays: perArray.map((a, n) => ({ ...a, name: arrays[n].name, source: arrays[n].source })),
      // Live reading per configured inverter, and what the bridge reports, for the Settings tiles.
      inverters: inv.map((i) => ({ id: i.id, power: i.powerKw, energy: i.energyKwh, reportedKwp: i.reportedKwp })),
      discovered: (sp.inverters || []).map((i) => ({ key: i.key, name: i.name, kwp: i.kwp })),
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
      `autonomy=${(ctx.autonomy * 24).toFixed(0)}h floor=${result.floorPct}% ` +
      `run=[${result.decisions.filter((d) => d.run).map((d) => d.id).join(",")}] ` +
      `shed=[${result.shed.map((d) => d.id).join(",")}]`;
    const signature = `${safeMode}|${dryRun}|${result.decisions.map((d) => `${d.id}:${d.run}`).join(",")}`;
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
      inputs: { soc: socEnt, loadKw: loadEnt, pvKw: pvEnt, batteryKw: batt.source === "none" ? null : batt.batteryKw, energy: batt.energy, inverters: inv },
      splinkSource: settings.splink.enabled ? splink.source : null,
      solar,
      ctx,
      result: summarise(result),
      devices: policy.devices.map((d) => ({ id: d.id, name: d.name, switch: d.switch || null })),
    };

    await actuator.apply(result.decisions);
    mqttSink.publishTick({ ctx, result, safeMode, dryRun, inputs: snapshot.inputs, solar });
    saveState({ history: history.toJSON(), solar: estimator.toJSON(), updated: now.toISOString() });
  }

  applySettings(settings);
  setTimeout(runTick, 3000);

  process.on("SIGTERM", () => {
    log.info("shutting down");
    saveState({ history: history.toJSON(), solar: estimator.toJSON() });
    process.exit(0);
  });
}

main().catch((e) => { log.error("fatal", e.stack || e.message); process.exit(1); });
