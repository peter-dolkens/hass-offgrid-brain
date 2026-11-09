/* Optional MQTT bridge — publishes the brain's own state back into HA via
   discovery, and (when fronius.publish_to_ha is on) the directly-polled PV
   figures too. An add-on cannot create native entities, so discovery is the
   supported route. Entirely optional: if you run the Fronius HA integration
   instead, leave this off and point `sources` at its entities. */
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
      log.warn("mqtt enabled but no broker available — is the Mosquitto add-on installed?");
      this.enabled = false;
      return;
    }
    const mqtt = loadMqtt();
    if (!mqtt) { this.enabled = false; return; }
    const url = `mqtt://${this.broker.host}:${this.broker.port || 1883}`;
    log.info(`connecting to MQTT at ${url}`);
    this.client = mqtt.connect(url, {
      username: this.broker.username,
      password: this.broker.password,
      will: { topic: "offgrid_brain/status", payload: "offline", retain: true },
    });
    this.client.on("connect", () => {
      log.info("MQTT connected");
      this.client.publish("offgrid_brain/status", "online", { retain: true });
    });
    this.client.on("error", (e) => log.warn("MQTT error", e.message));
  }

  _announce(key, cfg) {
    if (this.announced.has(key)) return;
    const topic = `${this.prefix}/sensor/offgrid_brain/${key}/config`;
    this.client.publish(topic, JSON.stringify({
      ...cfg,
      unique_id: `offgrid_brain_${key}`,
      state_topic: `offgrid_brain/${key}`,
      availability_topic: "offgrid_brain/status",
      device: DEVICE,
    }), { retain: true });
    this.announced.add(key);
  }

  publishSensor(key, value, cfg = {}) {
    if (!this.enabled || !this.client || !this.client.connected) return;
    this._announce(key, { name: cfg.name || key, ...cfg });
    this.client.publish(`offgrid_brain/${key}`, String(value), { retain: true });
  }

  /** Publish one tick's summary: the numbers you would want on a dashboard. */
  publishTick({ ctx, result, safeMode }) {
    if (!this.enabled) return;
    this.publishSensor("autonomy", ctx.autonomy.toFixed(2), { name: "Autonomy", unit_of_measurement: "d", icon: "mdi:battery-clock" });
    this.publishSensor("soc", Number.isFinite(ctx.soc) ? ctx.soc.toFixed(1) : "unknown", { name: "Battery SoC (brain view)", unit_of_measurement: "%", device_class: "battery" });
    this.publishSensor("pv_power", Number.isFinite(ctx.pv) ? (ctx.pv * 1000).toFixed(0) : "unknown", { name: "PV power", unit_of_measurement: "W", device_class: "power" });
    this.publishSensor("shed_count", result.shed.length, { name: "Loads shed", icon: "mdi:flash-off" });
    this.publishSensor("safe_mode", safeMode ? "ON" : "OFF", { name: "Safe mode", icon: "mdi:shield-alert" });
    this.publishSensor("shed_detail", JSON.stringify(result.shed.map((s) => s.id)).slice(0, 255), { name: "Shed loads" });
    this.publishSensor("deficit_power", (result.deficitKw * 1000).toFixed(0), { name: "Deficit", unit_of_measurement: "W", device_class: "power", icon: "mdi:alert" });
  }
}

module.exports = { MqttSink };
