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
  // Positive while CHARGING, negative while discharging (verified against SoC trend).
  const batteryKw = spOk ? reading(sp.battery && sp.battery.kilowatts, sp.live_read_at, now) : NONE;
  const generatorKw = spOk ? reading(sp.generator && sp.generator.kilowatts, sp.live_read_at, now) : NONE;

  // PV is only trustworthy when every inverter reported; a partial sum would
  // under-read solar. Age is the OLDEST inverter reading.
  let pvKw = NONE;
  const inv = Array.isArray(doc && doc.fronius) ? doc.fronius : [];
  if (inv.length && inv.every((i) => i.healthy && i.ac && Number.isFinite(i.ac.power_watts))) {
    const oldest = inv.map((i) => i.taken_at).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    pvKw = reading(inv.reduce((s, i) => s + i.ac.power_watts, 0) / 1000, oldest, now);
  }

  // Each inverter on its own, for the Energy dashboard: one array going quiet
  // shows up as a gap against the other rather than vanishing into a total.
  // The lifetime counter is monotonic, so the dashboard can use it directly.
  const inverters = inv.map((i, n) => ({
    key: slug(i.name || i.host || `inverter_${n + 1}`),
    name: i.custom_name || i.name || `Inverter ${n + 1}`,
    // The inverter's configured PV array peak power (Fronius "PVPower").
    kwp: Number.isFinite(i.rated_watts) ? i.rated_watts / 1000 : NaN,
    powerKw: i.healthy && i.ac ? reading(i.ac.power_watts / 1000, i.taken_at, now) : NONE,
    energyKwh: i.healthy && i.energy ? reading(i.energy.total_wh / 1000, i.taken_at, now) : NONE,
  }));

  // The SP PRO only exposes TODAY's energy, reset at its own midnight, by its own
  // clock (which can be an hour or more out). The brain doesn't publish these: it
  // meters battery, load and generator energy itself (policy/meter.js) and only uses
  // these to start its meters from today's figures.
  const today = (spOk && sp.today) || {};
  const day = (v) => (spOk ? reading(v, sp.today_read_at, now) : NONE);
  const energy = {
    batteryInKwh: day(today.battery_in_kwh),
    batteryOutKwh: day(today.battery_out_kwh),
    loadKwh: day(today.ac_load_kwh),
    generatorKwh: day(today.ac_input_kwh),
  };
  // What the battery inverter is doing with AC-coupled solar: in float it throttles
  // the inverters to the load; while charging it takes up to the charge limit.
  const charger = spOk && typeof sp.charger === "string" ? sp.charger : null;
  const chargeLimitKw = spOk && sp.regulation ? sp.regulation.charge_power_limit_kilowatts : NaN;
  return { soc, loadKw, batteryKw, generatorKw, pvKw, inverters, energy, charger, chargeLimitKw, healthy: spOk };
}

/** Entity-safe key from an inverter name ("Right" -> "right"). */
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "inverter";
}

/** The bridge's fast window (GET /fast): SoC and AC load, re-read every few
    seconds so the brain can shed in time. taken_at is when the bridge read it. */
function parseFast(doc, now = Date.now()) {
  if (!doc || !doc.taken_at) return { soc: NONE, loadKw: NONE };
  return {
    soc: reading(doc.battery_soc_percent, doc.taken_at, now),
    loadKw: reading(doc.ac_load_kilowatts, doc.taken_at, now),
  };
}

const fresher = (a, b) => (a.ageSec <= b.ageSec ? a : b);

/** Full document and fast window combined: each reading from whichever is newer. */
function combine(doc, fastDoc, now = Date.now()) {
  const full = parseBridge(doc, now);
  const fast = parseFast(fastDoc, now);
  return { ...full, soc: fresher(fast.soc, full.soc), loadKw: fresher(fast.loadKw, full.loadKw) };
}

class SplinkPoller {
  constructor({ urls, pollSeconds, fastSeconds, timeoutMs }) {
    this.urls = (urls || []).filter(Boolean);
    this.pollSeconds = pollSeconds || 15;           // full document: PV, energy totals
    this.fastSeconds = fastSeconds == null ? 3 : fastSeconds;   // /fast: SoC + load; 0 = off
    this.timeoutMs = timeoutMs || 8000;
    this.doc = null;
    this.fastDoc = null;
    this.fastSupported = true;
    this.source = null;   // which url answered last
    this.failing = { full: false, fast: false };
    this.timers = [];
  }

  async fetchJson(url, isValid, what) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const r = await fetch(url, { signal: ac.signal, redirect: "error" });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      const doc = await r.json();
      if (!isValid(doc)) throw new Error(`not a splink ${what}`);
      return doc;
    } finally { clearTimeout(t); }
  }

  /** Try each url in order; first answer wins. Logs only on failing/recovering
      transitions, since the fast window polls every few seconds. */
  async firstAnswer(kind, path, isValid) {
    const errors = [];
    let notFound = 0;
    for (const url of this.urls) {
      try {
        const doc = await this.fetchJson(new URL(path, url).href, isValid, kind);
        if (this.failing[kind]) log.info(`splink: ${kind} reads recovered (${url})`);
        this.failing[kind] = false;
        return { doc, url };
      } catch (e) {
        if (e.status === 404) notFound++;
        errors.push(`${url}: ${e.name === "AbortError" ? "timeout" : e.message}`);
      }
    }
    if (!this.failing[kind]) log.warn(`splink: no bridge answered the ${kind} read (${errors.join("; ")})`);
    this.failing[kind] = true;
    return { notFound: notFound === this.urls.length };
  }

  async pollOnce() {
    const r = await this.firstAnswer("full", "", (d) => d && d.sp_pro);
    // On failure keep the last document: its readings age out into safe mode on their own.
    if (!r.doc) { this.source = null; return false; }
    if (this.source !== r.url) log.info(`splink: reading from ${r.url}`);
    this.source = r.url;
    this.doc = r.doc;
    return true;
  }

  async pollFast() {
    if (!this.fastSupported) return false;
    const r = await this.firstAnswer("fast", "fast", (d) => d && d.taken_at && "battery_soc_percent" in d);
    if (r.doc) { this.fastDoc = r.doc; return true; }
    if (r.notFound) {
      this.fastSupported = false;
      log.info("splink: bridge has no /fast window; using the full document only");
    }
    return false;
  }

  /** { soc, loadKw, batteryKw, pvKw } each as { value, ageSec }. */
  get readings() { return combine(this.doc, this.fastDoc); }

  start() {
    if (!this.urls.length) return;
    log.info(`splink bridge polling enabled: ${this.urls.join(" -> ")}, full every ${this.pollSeconds}s` +
             (this.fastSeconds ? `, fast window every ${this.fastSeconds}s` : ""));
    const every = (fn, sec) => {
      const run = () => fn().catch((e) => log.warn("splink poll error", e.message));
      run();
      this.timers.push(setInterval(run, sec * 1000));
    };
    every(() => this.pollOnce(), this.pollSeconds);
    if (this.fastSeconds) every(() => this.pollFast(), this.fastSeconds);
  }

  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; }
}

module.exports = { SplinkPoller, parseBridge, parseFast, combine };
