/* Turns decisions into switch changes — the only place that touches the house.

   Three guards stand between a decision and a relay:
     1. dry_run      — global, default ON. Logs intent, actuates nothing.
     2. min dwell    — per device. Stops contactors and compressors chattering
                       when a value hovers at a threshold. Short-cycling a
                       compressor damages it; this is not cosmetic.
     3. mapped switch — a device with no `switch` entity is advisory only. The
                       brain never pretends to control what it cannot. */
"use strict";
const log = require("../log.js");

class Actuator {
  constructor({ ha, devices, dryRun }) {
    this.ha = ha;
    this.dryRun = dryRun;
    this.devices = new Map(devices.map((d) => [d.id, d]));
    this.lastChange = new Map();   // id -> epoch_ms
    this.lastState = new Map();    // id -> bool
  }

  /** Apply decisions; returns what was changed / suppressed, for logging and MQTT. */
  async apply(decisions) {
    const applied = [];
    for (const dec of decisions) {
      const d = this.devices.get(dec.id);
      if (!d || !d.switch) continue;                    // advisory-only device
      if (dec.gen && !dec.run) {                        // belt-and-braces: never open a gen-backed load
        log.warn(`${dec.id}: gen-backed load reported not-running — refusing to switch it off`);
        continue;
      }

      const want = dec.run;
      const prev = this.lastState.get(dec.id);
      if (prev === want) continue;                      // already in the right state

      const dwell = (d.min_dwell_seconds ?? 300) * 1000;
      const since = Date.now() - (this.lastChange.get(dec.id) || 0);
      if (prev !== undefined && since < dwell) {
        log.debug(`${dec.id}: holding ${prev ? "ON" : "OFF"} — dwell ${Math.round((dwell - since) / 1000)}s remaining`);
        applied.push({ id: dec.id, action: "held", want, reason: "min dwell" });
        continue;
      }

      const service = want ? "turn_on" : "turn_off";
      const domain = d.switch.split(".")[0];
      if (this.dryRun) {
        log.info(`DRY RUN would ${service} ${d.switch} (${dec.id}) — ${dec.reason}`);
        applied.push({ id: dec.id, action: "dry_run", want, reason: dec.reason });
      } else {
        try {
          await this.ha.callService(domain, service, d.switch);
          log.info(`${service} ${d.switch} (${dec.id}) — ${dec.reason}`);
          applied.push({ id: dec.id, action: service, want, reason: dec.reason });
        } catch (e) {
          log.error(`failed to ${service} ${d.switch}`, e.message);
          applied.push({ id: dec.id, action: "error", want, reason: e.message });
          continue;
        }
      }
      this.lastState.set(dec.id, want);
      this.lastChange.set(dec.id, Date.now());
    }
    return applied;
  }
}

module.exports = { Actuator };
