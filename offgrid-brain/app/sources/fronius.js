/* Optional direct Fronius Solar API poller.

   Verified against two Primo GEN24 10.0 units (2026-10-02).
   Hard-won facts baked in here:
     - GetArchiveData.cgi 404s on GEN24 — realtime only, so history must be polled.
     - DAY_ENERGY / YEAR_ENERGY read null; only TOTAL_ENERGY populates, so daily
       totals have to be derived by differencing the lifetime counter.
     - The inverters see PV ONLY. P_Akku / P_Grid / P_Load are null and there is no
       Storage device: battery SoC CANNOT come from here, it must come from the
       Selectronic. Do not be tempted.
     - Output is load-following when the Selectronic curtails it, so PAC is
       DELIVERED power, not available solar resource. */
"use strict";
const log = require("../log.js");

async function getJSON(url, timeoutMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

class FroniusPoller {
  constructor({ hosts, pollSeconds }) {
    this.hosts = hosts || [];
    this.pollSeconds = pollSeconds || 10;
    this.inverters = new Map();   // host -> { pac, totalWh, serial, name, state, errorCode, updated }
    this.timer = null;
  }

  get pvKw() {
    let sum = 0, any = false;
    for (const v of this.inverters.values()) {
      if (Number.isFinite(v.pac)) { sum += v.pac; any = true; }
    }
    return any ? sum / 1000 : NaN;
  }

  get lifetimeKwh() {
    let sum = 0, any = false;
    for (const v of this.inverters.values()) {
      if (Number.isFinite(v.totalWh)) { sum += v.totalWh; any = true; }
    }
    return any ? sum / 1000 : NaN;
  }

  get ageSec() {
    let newest = 0;
    for (const v of this.inverters.values()) newest = Math.max(newest, v.updated || 0);
    return newest ? (Date.now() - newest) / 1000 : Infinity;
  }

  async pollOnce() {
    await Promise.all(this.hosts.map(async (host) => {
      try {
        const [info, rt] = await Promise.all([
          getJSON(`http://${host}/solar_api/v1/GetInverterInfo.cgi`),
          getJSON(`http://${host}/solar_api/v1/GetInverterRealtimeData.cgi?Scope=Device&DeviceId=1&DataCollection=CommonInverterData`),
        ]);
        const d = rt.Body.Data;
        const meta = Object.values(info.Body.Data)[0] || {};
        this.inverters.set(host, {
          pac: d.PAC && d.PAC.Value,
          totalWh: d.TOTAL_ENERGY && d.TOTAL_ENERGY.Value,
          fac: d.FAC && d.FAC.Value,
          uac: d.UAC && d.UAC.Value,
          serial: meta.UniqueID,
          name: meta.CustomName,
          state: d.DeviceStatus && d.DeviceStatus.InverterState,
          errorCode: d.DeviceStatus && d.DeviceStatus.ErrorCode,
          updated: Date.now(),
        });
      } catch (e) {
        log.warn(`fronius ${host} poll failed`, e.message);
      }
    }));
  }

  start() {
    if (!this.hosts.length) return;
    log.info(`fronius direct polling enabled: ${this.hosts.join(", ")} every ${this.pollSeconds}s`);
    const tick = () => this.pollOnce().catch((e) => log.warn("fronius poll error", e.message));
    tick();
    this.timer = setInterval(tick, this.pollSeconds * 1000);
  }

  stop() { if (this.timer) clearInterval(this.timer); }
}

module.exports = { FroniusPoller };
