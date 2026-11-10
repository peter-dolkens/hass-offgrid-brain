/* Tests for settings: seeding from add-on options, validation, and the web
   server's settings routes. Run: node test/settings.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Settings = require("../settings.js");
const { startServer } = require("../web/server.js");
const { check, mergeDeviceOptions } = require("../config.js");

let pass = 0;
const results = [];
const t = (name, fn) => results.push(Promise.resolve().then(fn).then(
  () => { pass++; console.log(`  ok  ${name}`); },
  (e) => { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }));

// The blade's add-on options as they were before 0.9.0.
const oldOptions = {
  log_level: "info", dry_run: true, tick_seconds: 5,
  sources: { battery_soc: "", irradiance: "" },
  battery: { capacity_kwh: 51.8, inverter_kw: 7.5, max_charge_kw: 7.5, reserve_pct: 10 },
  splink: { enabled: true, urls: ["https://solar.example.com/"], poll_seconds: 15, fast_seconds: 3 },
  ecowitt: { enabled: true, urls: ["http://192.168.1.30/", "http://192.168.1.31/"], poll_seconds: 10 },
  solar: { inverter_ac_kw: 10 },
  mqtt: { enabled: true, username: "brain", password: "pw" },
  devices: [{ id: "ev", kw: 7, switch: "switch.ev_contactor", min_dwell_seconds: 600 }],
};

t("seeding carries the old options over", () => {
  const s = Settings.normalise(oldOptions);
  assert.deepStrictEqual(s.splink.urls, ["https://solar.example.com/"]);
  assert.deepStrictEqual(s.ecowitt.urls, ["http://192.168.1.30/", "http://192.168.1.31/"]);
  assert.strictEqual(s.splink.enabled, true);
  assert.ok(!("mqtt" in s), "MQTT stays in the add-on options");
  assert.ok(!("devices" in s), "devices live in policy.json");
  assert.deepStrictEqual(Settings.check(s), []);
});

t("defaults fill anything the options didn't have", () => {
  const s = Settings.normalise({});
  assert.strictEqual(s.dry_run, true);
  assert.strictEqual(s.battery.source, "none");
  assert.deepStrictEqual(s.solar.inverters, []);
  assert.deepStrictEqual(Settings.check(s), []);
});

t("validation catches bad values", () => {
  const s = Settings.normalise(oldOptions);
  s.tick_seconds = 0;
  s.sources.battery_soc = "not an entity";
  s.splink.urls = ["ftp://x"];
  s.ecowitt = { ...s.ecowitt, enabled: true, urls: [] };
  s.battery.reserve_pct = 80;
  const p = Settings.check(s).join(" | ");
  for (const want of ["tick_seconds", "battery_soc", "ftp://x", "ecowitt is enabled but has no URLs", "reserve"]) {
    assert.ok(p.includes(want), `expected a problem about ${want}: ${p}`);
  }
});

t("loadSettings seeds settings.json once, then reads it back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-settings-"));
  const file = path.join(dir, "settings.json");
  Settings.save(Settings.normalise(oldOptions), file);
  const back = Settings.normalise(JSON.parse(fs.readFileSync(file, "utf8")));
  assert.deepStrictEqual(back.splink.urls, ["https://solar.example.com/"]);
  fs.rmSync(dir, { recursive: true });
});

t("solar inverters: the old single AC rating becomes one entry per inverter, once", () => {
  const s = Settings.normalise(oldOptions);
  const disc = [{ key: "right", name: "Solar Inverter (Right)" }, { key: "left", name: "Solar Inverter (Left)" }];
  assert.strictEqual(Settings.migrateSolar(s, []), null, "waits until the bridge reports inverters");
  const m = Settings.migrateSolar(s, disc);
  assert.deepStrictEqual(m.solar, { inverters: [
    { id: "right", name: "Solar Inverter (Right)", source: "bridge", bridge_key: "right", ac_kw: 10, kwp: null },
    { id: "left", name: "Solar Inverter (Left)", source: "bridge", bridge_key: "left", ac_kw: 10, kwp: null },
  ] });
  assert.strictEqual(Settings.migrateSolar(m, disc), null, "only once");
  assert.deepStrictEqual(Settings.check(m), []);
});

t("0.10 bridge-keyed inverters become bridge-integration inverters", () => {
  const s = Settings.normalise({ splink: { enabled: true, urls: ["https://x/"] },
    solar: { inverters: [{ key: "right", name: "Solar Inverter (Right)", ac_kw: 10, kwp: null }] } });
  assert.deepStrictEqual(s.solar.inverters, [
    { id: "right", name: "Solar Inverter (Right)", source: "bridge", bridge_key: "right", ac_kw: 10, kwp: null }]);
  assert.deepStrictEqual(Settings.check(s), []);
});

t("old global Fronius hosts become fronius-integration inverters", () => {
  const s = Settings.normalise({ fronius: { enabled: true, hosts: ["192.168.1.21"], poll_seconds: 10 } });
  assert.strictEqual(s.solar.inverters[0].source, "fronius");
  assert.strictEqual(s.solar.inverters[0].host, "192.168.1.21");
  assert.ok(!("fronius" in s), "the global section is gone");
});

t("inverter validation follows each integration's fields", () => {
  const s = Settings.normalise({});
  s.solar.inverters = [
    { id: "a", name: "A", source: "ha" },
    { id: "a", name: "B", source: "none" },
    { id: "Bad Id", name: "", source: "fronius", poll_seconds: 1 },
    { id: "c", name: "C", source: "bridge" },
    { id: "d", name: "D", source: "toaster" },
    { id: "e", name: "E", source: "fronius", host: "192.168.1.21", poll_seconds: 10, ac_kw: -1 },
  ];
  const p = Settings.check(s).join(" | ");
  for (const want of ["A: pick a power entity", "B: another inverter has the id", "B: with no integration, the array kWp",
    "needs a name", "id must be lowercase", "needs the inverter's IP", "poll must be 2-300", "C: pick which bridge inverter",
    "C: reads from the SP PRO bridge, which isn't enabled", "D: integration must be one of", "E: AC rating must be positive"]) {
    assert.ok(p.includes(want), `expected "${want}" in: ${p}`);
  }
});

t("battery: the bridge when it's enabled, else old SoC/load entities, else none", () => {
  const viaBridge = Settings.normalise(oldOptions);
  assert.strictEqual(viaBridge.battery.source, "bridge");
  assert.strictEqual(viaBridge.battery.capacity_kwh, 51.8);
  const viaHa = Settings.normalise({ sources: { battery_soc: "sensor.soc", load_power: "sensor.load", pv_power: "sensor.pv" } });
  assert.deepStrictEqual([viaHa.battery.source, viaHa.battery.soc_entity, viaHa.battery.load_entity], ["ha", "sensor.soc", "sensor.load"]);
  assert.strictEqual(viaHa.solar.inverters[0].power_entity, "sensor.pv", "loose pv_power becomes an ha inverter");
  assert.ok(!("battery_soc" in viaHa.sources) && !("pv_power" in viaHa.sources));
  assert.strictEqual(Settings.normalise({}).battery.source, "none");
});

t("battery validation", () => {
  const s = Settings.normalise({});
  Object.assign(s.battery, { name: "", source: "ha", soc_entity: "", power_entity: "nope" });
  const p = Settings.check(s).join(" | ");
  for (const want of ["needs a name", "pick a SoC entity", '"nope" isn\'t an entity id']) assert.ok(p.includes(want), `${want}: ${p}`);
  const b = Settings.normalise({}); b.battery.source = "bridge";
  assert.ok(Settings.check(b).some((x) => x.includes("bridge, which isn't enabled")));
});

t("old option devices fold into policy.json devices", () => {
  const policy = { devices: [{ id: "ev", name: "EV", kw: 7 }], list: [{ type: "load", dev: "ev", cond: "1" }] };
  assert.strictEqual(mergeDeviceOptions(policy, oldOptions.devices), true);
  assert.strictEqual(policy.devices[0].switch, "switch.ev_contactor");
  assert.strictEqual(policy.devices[0].min_dwell_seconds, 600);
  assert.strictEqual(mergeDeviceOptions(policy, oldOptions.devices), false, "idempotent");
  assert.deepStrictEqual(check(policy), []);
});

t("a device switch must be something the brain can turn on and off", () => {
  const policy = { devices: [{ id: "ev", kw: 7, switch: "sensor.ev_power" }], list: [] };
  assert.ok(check(policy).some((p) => p.includes("can only turn")));
});

t("settings routes: save applies; going live needs explicit confirmation", async () => {
  let current = Settings.normalise(oldOptions);
  const applied = [];
  const server = startServer({
    port: 0, allowAny: true, policyPath: "/dev/null", settingsPath: "/tmp/x",
    getState: () => ({}), getPolicy: () => ({}), check: () => [], preview: () => null, apply: () => {},
    getSettings: () => current,
    checkSettings: (s) => Settings.check(Settings.normalise(s)),
    applySettings: (s) => { current = Settings.normalise(s); applied.push(current); },
    listEntities: async () => [{ entity_id: "switch.ev", domain: "switch" }],
  });
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (body) => fetch(`${base}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const tick = { ...current, tick_seconds: 10 };
    assert.strictEqual((await put({ settings: tick })).status, 200);
    assert.strictEqual(current.tick_seconds, 10);

    const live = { ...current, dry_run: false };
    const refused = await put({ settings: live });
    assert.strictEqual(refused.status, 409, "no confirmation");
    assert.strictEqual(current.dry_run, true);
    assert.strictEqual((await put({ settings: live, confirm: "LIVE" })).status, 200);
    assert.strictEqual(current.dry_run, false);

    const bad = await put({ settings: { ...current, tick_seconds: 0 } });
    assert.strictEqual(bad.status, 422);
    assert.strictEqual(applied.length, 2, "rejected saves don't apply");

    const ents = await (await fetch(`${base}/api/entities`)).json();
    assert.strictEqual(ents.entities[0].entity_id, "switch.ev");
  } finally { server.close(); }
});

t("battery: 0.15 surge/peak become short-term ratings, once", () => {
  const s = Settings.normalise({ splink: { enabled: true, urls: ["https://x/"] }, battery: { source: "bridge", surge_kw: 11, peak_kw: 13 } });
  assert.deepStrictEqual(s.battery.ratings, [{ kw: 11, seconds: 1800 }, { kw: 13, seconds: 60 }]);
  assert.ok(!("surge_kw" in s.battery) && !("peak_kw" in s.battery));
  assert.deepStrictEqual(Settings.normalise(s).battery.ratings, s.battery.ratings);
  assert.deepStrictEqual(Settings.check(s), []);
});

t("battery: short-term ratings validate against continuous and each other", () => {
  const s = Settings.normalise({});
  s.battery.ratings = [{ kw: 18, seconds: 30 }, { kw: 13, seconds: 60 }, { kw: 11.25, seconds: 1800 }, { kw: 8, seconds: 3600 }];
  assert.deepStrictEqual(Settings.check(s), []);
  s.battery.ratings = [{ kw: 7, seconds: 60 }, { kw: 9, seconds: null }, { kw: 10, seconds: 600 }, { kw: 12, seconds: 1200 }];
  const p = Settings.check(s).join(" | ");
  for (const want of ["7 kW must be above the 7.5 kW continuous", "9 kW needs a duration", "a longer duration must have a lower kW"]) {
    assert.ok(p.includes(want), `${want}: ${p}`);
  }
});

t("battery: 0.27.0's dwell steps become the curve; the curve validates", () => {
  const s = Settings.normalise({ battery: { full_dwell: [{ below_pct: 0.1, seconds: 60 }] } });
  assert.deepStrictEqual(s.battery.full_dwell, { base_seconds: 60, growth: 0.7 });
  s.battery.full_dwell = { base_seconds: -1, growth: 20 };
  const p = Settings.check(s).join(" | ");
  assert.ok(p.includes("dwell base time") && p.includes("dwell growth"), p);
});

Promise.all(results).then(() => console.log(`\n${pass} passed`));
