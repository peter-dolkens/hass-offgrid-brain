/* SP PRO bridge poller (splink-cli's JSON API).

   The Selectronic SP PRO is the only device that knows the battery's state of
   charge; select.live2 has no LAN API. A splink bridge reads the SP PRO over its
   own serial protocol and serves one JSON document with the battery, the AC load
   and (it polls them too) the AC-coupled Fronius inverters — every input the
   brain needs, in one read.

   Freshness is judged by when the BRIDGE last read the hardware (live_read_at /
   each inverter's taken_at), not when we fetched the document: if the bridge's
   USB link wedges it keeps serving its last reading, and that must age out into
   safe mode rather than look current.

   urls are tried in order and the first that answers wins, so a site can list its
   LAN address first and a public tunnel second, and keep working through an
   internet outage (LAN) or from off site (tunnel). */
"use strict";
const log = require("../log.js");

const NONE = Object.freeze({ value: NaN, ageSec: Infinity });

function reading(value, atIso, now) {
  const at = Date.parse(atIso);
  if (!Number.isFinite(value) || !Number.isFinite(at)) return NONE;
  // A clock skewed slightly ahead must not make a reading look "from the future".
  return { value, ageSec: Math.max(0, (now - at) / 1000) };
}

/** Extract the brain's inputs from one bridge document. Pure, for testing. */
function parseBridge(doc, now = Date.now()) {
  const sp = doc && doc.sp_pro;
  const spOk = !!(sp && sp.healthy);
  const soc = spOk ? reading(sp.battery && sp.battery.soc_percent, sp.live_read_at, now) : NONE;
  const loadKw = spOk ? reading(sp.ac && sp.ac.load_kilowatts, sp.live_read_at, now) : NONE;
  const batteryKw = spOk ? reading(sp.battery && sp.battery.kilowatts, sp.live_read_at, now) : NONE;

  // PV is only trustworthy when every inverter reported; a partial sum would
  // under-read solar. Age is the OLDEST inverter reading.
  let pvKw = NONE;
  const inv = Array.isArray(doc && doc.fronius) ? doc.fronius : [];
  if (inv.length && inv.every((i) => i.healthy && i.ac && Number.isFinite(i.ac.power_watts))) {
    const oldest = inv.map((i) => i.taken_at).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    pvKw = reading(inv.reduce((s, i) => s + i.ac.power_watts, 0) / 1000, oldest, now);
  }
  return { soc, loadKw, batteryKw, pvKw, healthy: spOk };
}

class SplinkPoller {
  constructor({ urls, pollSeconds, accessClientId, accessClientSecret, timeoutMs }) {
    this.urls = (urls || []).filter(Boolean);
    this.pollSeconds = pollSeconds || 15;
    this.timeoutMs = timeoutMs || 8000;
    // Cloudflare Access service-token headers, for a tunnel behind Access.
    this.headers = accessClientId
      ? { "CF-Access-Client-Id": accessClientId, "CF-Access-Client-Secret": accessClientSecret || "" }
      : {};
    this.doc = null;
    this.source = null;   // which url answered last
    this.timer = null;
  }

  async fetchFrom(url) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const r = await fetch(url, { signal: ac.signal, headers: this.headers, redirect: "error" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const doc = await r.json();
      if (!doc || !doc.sp_pro) throw new Error("not a splink bridge document (no sp_pro)");
      return doc;
    } finally { clearTimeout(t); }
  }

  async pollOnce() {
    const errors = [];
    for (const url of this.urls) {
      try {
        this.doc = await this.fetchFrom(url);
        if (this.source !== url) log.info(`splink: reading from ${url}`);
        this.source = url;
        return true;
      } catch (e) {
        errors.push(`${url}: ${e.name === "AbortError" ? "timeout" : e.message}`);
      }
    }
    // Keep the last document: its readings age out into safe mode on their own.
    log.warn(`splink: no bridge answered (${errors.join("; ")})`);
    this.source = null;
    return false;
  }

  /** { soc, loadKw, batteryKw, pvKw } each as { value, ageSec }. */
  get readings() { return parseBridge(this.doc); }

  start() {
    if (!this.urls.length) return;
    log.info(`splink bridge polling enabled: ${this.urls.join(" -> ")} every ${this.pollSeconds}s`);
    const tick = () => this.pollOnce().catch((e) => log.warn("splink poll error", e.message));
    tick();
    this.timer = setInterval(tick, this.pollSeconds * 1000);
  }

  stop() { if (this.timer) clearInterval(this.timer); }
}

module.exports = { SplinkPoller, parseBridge };
