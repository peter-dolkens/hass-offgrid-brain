/* The battery (and its inverter), read through one integration.

   settings.battery.source:
     bridge  the SP PRO bridge: SoC, battery power, AC load, energy counters,
             charger state and charge-power limit
     ha      Home Assistant entities: SoC (required); battery power, house load,
             energy in/out (optional)
     none    no readings; the brain stays in safe mode

   Internally battery power is POSITIVE WHILE CHARGING, as the bridge reports it.
   Home Assistant's convention (and the Energy dashboard's) is the opposite, so an
   HA power entity is negated on the way in. */
"use strict";

const NONE = Object.freeze({ value: NaN, ageSec: Infinity });
const neg = (r) => (Number.isFinite(r.value) ? { value: -r.value, ageSec: r.ageSec } : r);

function readBattery(cfg, bridge, ha) {
  if (cfg.source === "bridge") {
    const b = bridge || {};
    return {
      source: "bridge",
      soc: b.soc || NONE, loadKw: b.loadKw || NONE, batteryKw: b.batteryKw || NONE, generatorKw: b.generatorKw || NONE,
      energy: b.energy || null, charger: b.charger || null, chargeLimitKw: b.chargeLimitKw,
    };
  }
  if (cfg.source === "ha") {
    const opt = (id, fn) => (id ? fn(id) : NONE);
    return {
      source: "ha",
      soc: ha.number(cfg.soc_entity),
      loadKw: opt(cfg.load_entity, (id) => ha.powerKw(id)),
      batteryKw: opt(cfg.power_entity, (id) => neg(ha.powerKw(id))),
      energy: {
        batteryInKwh: opt(cfg.energy_in_entity, (id) => ha.energyKwh(id)),
        batteryOutKwh: opt(cfg.energy_out_entity, (id) => ha.energyKwh(id)),
      },
      charger: null, chargeLimitKw: NaN,
    };
  }
  return { source: "none", soc: NONE, loadKw: NONE, batteryKw: NONE, energy: null, charger: null, chargeLimitKw: NaN };
}

/** HA entities an "ha" battery needs mirrored. */
function batteryEntities(cfg) {
  if (cfg.source !== "ha") return [];
  return [cfg.soc_entity, cfg.power_entity, cfg.load_entity, cfg.energy_in_entity, cfg.energy_out_entity].filter(Boolean);
}

module.exports = { readBattery, batteryEntities };
