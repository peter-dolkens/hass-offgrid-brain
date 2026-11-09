/* Ecowitt gateway poller (GW1100/GW2000/GW3000 local API) for solar irradiance.

   An off-grid battery inverter throttles AC-coupled solar to the load once the
   battery is full, so the inverters' output says what was DELIVERED, never what
   was AVAILABLE. Irradiance is the independent measure of how much sun there is,
   and it's what the available-solar estimate is built on.

   GET /get_livedata_info answers with the gateway's live sensors; solar radiation
   is common_list id "0x15", e.g. "845.32 W/m2". The gateway has no reading
   timestamp, so a reading is as fresh as the fetch that returned it (a WS90
   transmits about every 9 s). urls are tried in order, so a gateway's Ethernet
   and Wi-Fi addresses can both be listed. */
"use strict";
const log = require("../log.js");

const NONE = Object.freeze({ value: NaN, ageSec: Infinity });
const SOLAR_ID = "0x15";
const LUX_PER_WM2 = 126.7;   // daylight conversion, for gateways set to lux

/** Irradiance in W/m² from a /get_livedata_info document, or NaN. Pure, for testing. */
function parseIrradiance(doc) {
  const item = doc && Array.isArray(doc.common_list) ? doc.common_list.find((x) => x.id === SOLAR_ID) : null;
  if (!item || typeof item.val !== "string") return NaN;
  const m = item.val.trim().match(/^(-?[\d.]+)\s*(.*)$/);
  if (!m) return NaN;
  const v = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "" || unit === "w/m2") return v;
  if (unit === "klux") return (v * 1000) / LUX_PER_WM2;
  if (unit === "lux") return v / LUX_PER_WM2;
  return NaN;   // fc or anything unexpected: better unknown than wrong
}

class EcowittPoller {
  constructor({ urls, pollSeconds, timeoutMs }) {
    this.urls = (urls || []).filter(Boolean);
    this.pollSeconds = pollSeconds || 10;
    this.timeoutMs = timeoutMs || 5000;
    this.value = NaN;
    this.at = 0;
    this.failing = false;
    this.timer = null;
  }

  get irradiance() {
    return Number.isFinite(this.value) ? { value: this.value, ageSec: (Date.now() - this.at) / 1000 } : NONE;
  }

  async pollOnce() {
    const errors = [];
    for (const url of this.urls) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const r = await fetch(new URL("get_livedata_info", url).href, { signal: ac.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const v = parseIrradiance(await r.json());
        if (!Number.isFinite(v)) throw new Error("no solar radiation (0x15) in the gateway's live data");
        this.value = v;
        this.at = Date.now();
        if (this.failing) log.info(`ecowitt: irradiance reads recovered (${url})`);
        this.failing = false;
        return true;
      } catch (e) {
        errors.push(`${url}: ${e.name === "AbortError" ? "timeout" : e.message}`);
      } finally { clearTimeout(t); }
    }
    if (!this.failing) log.warn(`ecowitt: no gateway answered (${errors.join("; ")})`);
    this.failing = true;
    return false;
  }

  start() {
    if (!this.urls.length) return;
    log.info(`ecowitt irradiance polling enabled: ${this.urls.join(" -> ")} every ${this.pollSeconds}s`);
    const run = () => this.pollOnce().catch((e) => log.warn("ecowitt poll error", e.message));
    run();
    this.timer = setInterval(run, this.pollSeconds * 1000);
  }

  stop() { if (this.timer) clearInterval(this.timer); }
}

module.exports = { EcowittPoller, parseIrradiance };
