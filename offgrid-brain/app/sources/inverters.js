/* Solar inverters, each read through its own integration.

   settings.solar.inverters lists them; each names a source:
     bridge  the SP PRO bridge's reading for one of its Fronius inverters
     fronius the inverter's own Solar API, polled directly (one poller each)
     ha      a Home Assistant power entity, optionally an energy entity
     none    no live reading; counts toward available capacity only
   and carries its AC rating and array kWp (null = whatever the source reports). */
"use strict";
const { FroniusPoller } = require("./fronius.js");

const NONE = Object.freeze({ value: NaN, ageSec: Infinity });

class InverterSet {
  constructor({ ha }) {
    this.ha = ha;
    this.list = [];
    this.pollers = new Map();   // inverter id -> { cfg, poller } for source "fronius"
  }

  /** Adopt a new inverter list, starting/stopping Fronius pollers as needed. */
  configure(list) {
    this.list = list || [];
    const want = new Map(this.list.filter((c) => c.source === "fronius").map((c) => [c.id, c]));
    for (const [id, p] of this.pollers) {
      const c = want.get(id);
      if (!c || c.host !== p.cfg.host || c.poll_seconds !== p.cfg.poll_seconds) { p.poller.stop(); this.pollers.delete(id); }
    }
    for (const [id, c] of want) {
      if (this.pollers.has(id)) continue;
      const poller = new FroniusPoller({ hosts: [c.host], pollSeconds: c.poll_seconds });
      poller.start();
      this.pollers.set(id, { cfg: c, poller });
    }
  }

  stop() { for (const p of this.pollers.values()) p.poller.stop(); this.pollers.clear(); }

  /** HA entities the "ha" inverters need mirrored. */
  entities() {
    return this.list.filter((c) => c.source === "ha").flatMap((c) => [c.power_entity, c.energy_entity]).filter(Boolean);
  }

  /** One reading per configured inverter. `bridge` = the splink readings. */
  read(bridge = {}) {
    const now = Date.now();
    return this.list.map((c) => {
      let powerKw = NONE, energyKwh = NONE, reportedKwp = NaN;
      if (c.source === "bridge") {
        const b = (bridge.inverters || []).find((i) => i.key === c.bridge_key);
        if (b) { powerKw = b.powerKw; energyKwh = b.energyKwh; reportedKwp = b.kwp; }
      } else if (c.source === "fronius") {
        const p = this.pollers.get(c.id);
        const v = p && p.poller.inverters.get(c.host);
        if (v) {
          const ageSec = (now - v.updated) / 1000;
          if (Number.isFinite(v.pac)) powerKw = { value: v.pac / 1000, ageSec };
          if (Number.isFinite(v.totalWh)) energyKwh = { value: v.totalWh / 1000, ageSec };
          if (Number.isFinite(v.pvPowerW)) reportedKwp = v.pvPowerW / 1000;
        }
      } else if (c.source === "ha") {
        powerKw = this.ha.powerKw(c.power_entity);
        energyKwh = this.ha.energyKwh(c.energy_entity);
      }
      return {
        id: c.id, key: c.id, name: c.name, source: c.source,
        live: c.source !== "none",
        powerKw, energyKwh,
        reportedKwp,
        kwp: c.kwp || reportedKwp,
        acKw: c.ac_kw || NaN,
      };
    });
  }
}

module.exports = { InverterSet };
