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
  splink: { enabled: true, urls: ["https://solar.example.com/"], poll_seconds: 15, fast_seconds: 3,
            access_client_id: "id.access", access_client_secret: "s3cret" },
  ecowitt: { enabled: true, urls: ["http://192.168.1.30/", "http://192.168.1.31/"], poll_seconds: 10 },
  solar: { inverter_ac_kw: 10 },
  mqtt: { enabled: true, username: "brain", password: "pw" },
  devices: [{ id: "ev", kw: 7, switch: "switch.ev_contactor", min_dwell_seconds: 600 }],
};

t("seeding carries the old options over, without secrets", () => {
  const s = Settings.normalise(oldOptions);
  assert.deepStrictEqual(s.splink.urls, ["https://solar.example.com/"]);
  assert.deepStrictEqual(s.ecowitt.urls, ["http://192.168.1.30/", "http://192.168.1.31/"]);
  assert.strictEqual(s.splink.enabled, true);
  assert.ok(!("access_client_id" in s.splink) && !("access_client_secret" in s.splink), "no secrets in settings");
  assert.ok(!("mqtt" in s), "MQTT stays in the add-on options");
  assert.ok(!("devices" in s), "devices live in policy.json");
  assert.deepStrictEqual(Settings.check(s), []);
});

t("defaults fill anything the options didn't have", () => {
  const s = Settings.normalise({});
  assert.strictEqual(s.dry_run, true);
  assert.strictEqual(s.fronius.poll_seconds, 10);
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

Promise.all(results).then(() => console.log(`\n${pass} passed`));
