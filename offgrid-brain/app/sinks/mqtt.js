/* Optional MQTT bridge — publishes the brain's own state back into HA via
   discovery, as one "Off-Grid Brain" device. An add-on cannot create native
   entities, so discovery is the supported route. Entirely optional. */
"use strict";
const log = require("../log.js");

/* `mqtt` is a SOFT dependency, loaded only when the bridge is switched on. The brain
   must still run if the package is unavailable (e.g. the image was built without a
   registry) — it just loses the optional bridge, loudly, rather than failing to start. */
function loadMqtt() {
  try { return require("mqtt"); }
  catch (e) {
    log.error("mqtt.enabled is true but the 'mqtt' package is not installed — bridge disabled. Rebuild the add-on with network access.");
    return null;
  }
}

const DEVICE = {
  identifiers: ["offgrid_brain"],
  name: "Off-Grid Brain",
  manufacturer: "Off-Grid Brain",
  model: "Dispatch controller",
};
const STATUS = "offgrid_brain/status";

/* Entities from earlier versions, removed from HA on connect by publishing an
   empty retained discovery config. 0.6.0 published one combined solar total. */
const RETIRED = ["sensor/solar_energy"];

/** Broker from explicit options, else the Supervisor's MQTT service (the
    Mosquitto add-on's own credentials). Returns null when neither is available. */
async function resolveBroker(opt, supervisorToken) {
  if (opt && opt.host) {
    return { host: opt.host, port: opt.port || 1883, username: opt.username || undefined,
             password: opt.password || undefined, source: "options" };
  }
  if (!supervisorToken) return null;
  try {
    const r = await fetch("http://supervisor/services/mqtt", { headers: { Authorization: `Bearer ${supervisorToken}` } });
    if (!r.ok) return null;
    const d = (await r.json()).data;
    return d && d.host ? { host: d.host, port: d.port, username: d.username, password: d.password, source: "supervisor" } : null;
  } catch { return null; }
}

/* Numbers HA can't parse would log an error per update; "None" reads as unknown. */
const num = (v, digits) => (Number.isFinite(v) ? v.toFixed(digits) : "None");

/* The bridge re-reads its energy block every few minutes. A counter older than
   this isn't published, so the last retained value stands instead of "unknown"
   (which would break the Energy dashboard's hourly statistics). */
const ENERGY_STALE_SEC = 900;

/* Energy dashboard inputs: key -> [name, field in inputs.energy, icon]. */
const ENERGY = {
  battery_in_energy: ["Battery charged", "batteryInKwh", "mdi:battery-arrow-down"],
  battery_out_energy: ["Battery discharged", "batteryOutKwh", "mdi:battery-arrow-up"],
  load_energy: ["Load energy", "loadKwh", "mdi:home-lightning-bolt"],
  generator_energy: ["Generator energy", "generatorKwh", "mdi:engine"],
};

class MqttSink {
  constructor({ enabled, discoveryPrefix, broker }) {
    this.enabled = enabled;
    this.prefix = discoveryPrefix || "homeassistant";
    this.broker = broker;
    this.client = null;
    this.announced = new Set();
  }

  connect() {
    if (!this.enabled) return;
    if (!this.broker || !this.broker.host) {
      log.warn("mqtt enabled but no broker: set mqtt.host or install the Mosquitto add-on");
      this.enabled = false;
      return;
    }
    const mqtt = loadMqtt();
    if (!mqtt) { this.enabled = false; return; }
    const url = `mqtt://${this.broker.host}:${this.broker.port || 1883}`;
    log.info(`connecting to MQTT at ${url} as ${this.broker.username || "(anonymous)"} (${this.broker.source})`);
    this.client = mqtt.connect(url, {
      username: this.broker.username,
      password: this.broker.password,
      will: { topic: STATUS, payload: "offline", retain: true },
    });
    this.client.on("connect", () => {
      log.info("MQTT connected");
      this.announced.clear();   // re-announce after a reconnect (the broker may have restarted)
      this.client.publish(STATUS, "online", { retain: true });
      for (const id of RETIRED) {
        const [component, key] = id.split("/");
        this.client.publish(`${this.prefix}/${component}/offgrid_brain/${key}/config`, "", { retain: true });
        this.client.publish(`offgrid_brain/${key}`, "", { retain: true });
      }
    });
    this.client.on("error", (e) => log.warn("MQTT error", e.message));
  }

  _announce(component, key, cfg) {
    const id = `${component}/${key}`;
    if (this.announced.has(id)) return;
    this.client.publish(`${this.prefix}/${component}/offgrid_brain/${key}/config`, JSON.stringify({
      ...cfg,
      unique_id: `offgrid_brain_${key}`,
      default_entity_id: `${component}.offgrid_brain_${key}`,
      has_entity_name: true,
      state_topic: `offgrid_brain/${key}`,
      availability_topic: STATUS,
      device: DEVICE,
    }), { retain: true });
    this.announced.add(id);
  }

  publish(component, key, value, cfg) {
    if (!this.enabled || !this.client || !this.client.connected) return;
    this._announce(component, key, cfg);
    this.client.publish(`offgrid_brain/${key}`, String(value), { retain: true });
  }

  /** One tick's summary: the numbers you would want on a dashboard. */
  publishTick({ ctx, result, safeMode, dryRun, inputs }) {
    if (!this.enabled) return;
    const power = { unit_of_measurement: "W", device_class: "power", state_class: "measurement" };
    // The REAL reading, not the reserve value safe mode substitutes for decisions.
    this.publish("sensor", "soc", num(inputs.soc.value, 1),
      { name: "Battery SoC", unit_of_measurement: "%", device_class: "battery", state_class: "measurement" });
    this.publish("sensor", "load_power", num(inputs.loadKw.value * 1000, 0), { name: "Load", ...power });
    this.publish("sensor", "pv_power", num(ctx.pv * 1000, 0), { name: "Solar", ...power });
    this.publish("sensor", "charge_power", num(result.charge * 1000, 0), { name: "Charging", ...power, icon: "mdi:battery-charging" });
    // Battery power for the Energy dashboard: positive while discharging, negative while charging.
    if (inputs.batteryKw) {
      const b = inputs.batteryKw;
      this.publish("sensor", "battery_power", num(b.ageSec < ENERGY_STALE_SEC ? b.value * 1000 : NaN, 0),
        { name: "Battery power", ...power, icon: "mdi:home-battery" });
    }
    // Each solar inverter separately: power, and its lifetime energy counter.
    for (const inv of inputs.inverters || []) {
      this.publish("sensor", `solar_${inv.key}_power`,
        num(inv.powerKw.ageSec < ENERGY_STALE_SEC ? inv.powerKw.value * 1000 : NaN, 0),
        { name: `${inv.name} power`, ...power, icon: "mdi:solar-power-variant" });
      if (Number.isFinite(inv.energyKwh.value) && inv.energyKwh.ageSec < ENERGY_STALE_SEC) {
        this.publish("sensor", `solar_${inv.key}_energy`, inv.energyKwh.value.toFixed(3), {
          name: `${inv.name} energy`, unit_of_measurement: "kWh", device_class: "energy",
          state_class: "total_increasing", suggested_display_precision: 2, icon: "mdi:solar-power-variant",
        });
      }
    }
    for (const [key, [name, field, icon]] of Object.entries(ENERGY)) {
      const r = inputs.energy && inputs.energy[field];
      if (!r || !Number.isFinite(r.value) || r.ageSec >= ENERGY_STALE_SEC) continue;
      this.publish("sensor", key, r.value.toFixed(3), {
        name, unit_of_measurement: "kWh", device_class: "energy", state_class: "total_increasing",
        suggested_display_precision: 2, icon,
      });
    }
    this.publish("sensor", "deficit_power", num(result.deficitKw * 1000, 0), { name: "Deficit", ...power, icon: "mdi:alert" });
    this.publish("sensor", "autonomy", num(ctx.autonomy, 2),
      { name: "Autonomy", unit_of_measurement: "d", state_class: "measurement", icon: "mdi:battery-clock" });
    this.publish("sensor", "floor", result.floorPct,
      { name: "Deepest floor", unit_of_measurement: "%", icon: "mdi:format-vertical-align-bottom" });
    this.publish("sensor", "shed_count", result.shed.length,
      { name: "Loads shed", state_class: "measurement", icon: "mdi:flash-off" });
    this.publish("sensor", "shed_detail", JSON.stringify(result.shed.map((s) => s.id)).slice(0, 255),
      { name: "Shed loads", icon: "mdi:format-list-bulleted" });
    this.publish("binary_sensor", "safe_mode", safeMode ? "ON" : "OFF", { name: "Safe mode", device_class: "problem" });
    this.publish("binary_sensor", "dry_run", dryRun ? "ON" : "OFF", { name: "Dry run", icon: "mdi:test-tube" });
  }
}

module.exports = { MqttSink, resolveBroker };
