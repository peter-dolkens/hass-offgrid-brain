/* Tests for the SP PRO bridge source and source precedence. Run: node test/splink.test.js
   The fixture is a real document captured from a splink bridge (SPMC482 + 2x GEN24). */
"use strict";
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { parseBridge, parseFast, combine, SplinkPoller } = require("../sources/splink.js");
const { pick, STALE_SEC } = require("../sources/pick.js");

let pass = 0;
const results = [];
const t = (name, fn) => results.push(Promise.resolve().then(fn).then(
  () => { pass++; console.log(`  ok  ${name}`); },
  (e) => { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }));

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "splink-bridge.json"), "utf8"));
const fastFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "splink-fast.json"), "utf8"));
const clone = () => JSON.parse(JSON.stringify(fixture));
const readAt = Date.parse(fixture.sp_pro.live_read_at);

t("reads SoC, load and battery power from the SP PRO section", () => {
  const r = parseBridge(fixture, readAt + 20_000);
  assert.strictEqual(r.soc.value, fixture.sp_pro.battery.soc_percent);
  assert.strictEqual(r.loadKw.value, fixture.sp_pro.ac.load_kilowatts);
  assert.strictEqual(r.batteryKw.value, fixture.sp_pro.battery.kilowatts);
  assert.strictEqual(Math.round(r.soc.ageSec), 20);
});

t("age comes from when the bridge read the hardware, not when we fetched", () => {
  // taken_at is the document time; live_read_at is older and is what counts.
  const r = parseBridge(fixture, Date.parse(fixture.sp_pro.taken_at));
  assert.ok(r.soc.ageSec > 0, "should be older than the document");
});

t("an unhealthy SP PRO yields no readings", () => {
  const d = clone(); d.sp_pro.healthy = false;
  const r = parseBridge(d, readAt);
  assert.ok(Number.isNaN(r.soc.value) && r.soc.ageSec === Infinity);
  assert.ok(Number.isNaN(r.loadKw.value));
});

t("PV sums both inverters, in kW", () => {
  const d = clone();
  d.fronius[0].ac.power_watts = 1500; d.fronius[1].ac.power_watts = 2250;
  assert.strictEqual(parseBridge(d, readAt).pvKw.value, 3.75);
});

t("PV is unknown when any inverter is unhealthy (no partial sums)", () => {
  const d = clone(); d.fronius[1].healthy = false;
  assert.ok(Number.isNaN(parseBridge(d, readAt).pvKw.value));
});

t("PV age is the oldest inverter reading", () => {
  const d = clone();
  d.fronius[0].taken_at = "2026-01-01T00:00:00+00:00";
  d.fronius[1].taken_at = "2026-01-01T00:01:00+00:00";
  const r = parseBridge(d, Date.parse("2026-01-01T00:02:00+00:00"));
  assert.strictEqual(r.pvKw.ageSec, 120);
});

t("a missing or foreign document yields no readings", () => {
  for (const d of [null, {}, { sp_pro: null }]) assert.ok(Number.isNaN(parseBridge(d).soc.value));
});

t("pick prefers the first FRESH candidate", () => {
  const r = pick([["splink", { value: 50, ageSec: STALE_SEC + 1 }], ["ha", { value: 60, ageSec: 5 }]]);
  assert.deepStrictEqual([r.value, r.from], [60, "ha"]);
  const s = pick([["splink", { value: 50, ageSec: 3 }], ["ha", { value: 60, ageSec: 1 }]]);
  assert.strictEqual(s.from, "splink");
});

t("pick with nothing fresh returns the newest stale reading, still marked stale", () => {
  const r = pick([["splink", { value: 50, ageSec: 900 }], ["ha", { value: 60, ageSec: 400 }], ["x", null]]);
  assert.deepStrictEqual([r.value, r.from], [60, "ha,stale"]);
  assert.ok(r.ageSec >= STALE_SEC, "caller's freshness check must still reject it");
});

t("pick with no candidates at all is NaN/Infinity", () => {
  const r = pick([["splink", { value: NaN, ageSec: Infinity }]]);
  assert.ok(Number.isNaN(r.value) && r.ageSec === Infinity && r.from === "none");
});

t("poller falls back through urls in order and keeps the last good document", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/bad") { res.writeHead(500); return res.end("nope"); }
    if (req.url === "/html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>"); }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(fixture));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const p = new SplinkPoller({ urls: [`${base}/bad`, `${base}/html`, `${base}/good`] });
    assert.strictEqual(await p.pollOnce(), true);
    assert.strictEqual(p.source, `${base}/good`);
    assert.strictEqual(p.readings.soc.value, fixture.sp_pro.battery.soc_percent);

    // Every url failing keeps the previous document (it ages out on its own).
    p.urls = [`${base}/bad`];
    assert.strictEqual(await p.pollOnce(), false);
    assert.strictEqual(p.source, null);
    assert.strictEqual(p.readings.soc.value, fixture.sp_pro.battery.soc_percent);
  } finally { server.close(); }
});

t("poller sends Cloudflare Access headers when configured", async () => {
  let seen = null;
  const server = http.createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(fixture));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const p = new SplinkPoller({
      urls: [`http://127.0.0.1:${server.address().port}/`],
      accessClientId: "id.access", accessClientSecret: "s3cret",
    });
    await p.pollOnce();
    assert.strictEqual(seen["cf-access-client-id"], "id.access");
    assert.strictEqual(seen["cf-access-client-secret"], "s3cret");
  } finally { server.close(); }
});

t("the fast window gives SoC and load, aged from its taken_at", () => {
  const at = Date.parse(fastFixture.taken_at);
  const r = parseFast(fastFixture, at + 3000);
  assert.strictEqual(r.soc.value, fastFixture.battery_soc_percent);
  assert.strictEqual(r.loadKw.value, fastFixture.ac_load_kilowatts);
  assert.strictEqual(r.soc.ageSec, 3);
  assert.ok(Number.isNaN(parseFast(null).soc.value));
});

t("combine takes each reading from whichever source is newer, PV from the full document", () => {
  const full = clone();
  full.sp_pro.live_read_at = "2026-01-01T00:00:00+00:00";
  full.sp_pro.battery.soc_percent = 50;
  full.fronius.forEach((i) => { i.taken_at = "2026-01-01T00:00:00+00:00"; i.ac.power_watts = 1000; });
  const fast = { ...fastFixture, taken_at: "2026-01-01T00:01:50+00:00", battery_soc_percent: 51 };
  const now = Date.parse("2026-01-01T00:02:00+00:00");
  const r = combine(full, fast, now);
  assert.deepStrictEqual([r.soc.value, r.soc.ageSec], [51, 10]);
  assert.strictEqual(r.pvKw.value, 2);
  // A stale fast window loses to a newer full read.
  const r2 = combine(full, { ...fast, taken_at: "2025-12-31T23:00:00+00:00" }, now);
  assert.strictEqual(r2.soc.value, 50);
});

t("poller reads /fast and stops asking a bridge that has none", async () => {
  let fastHits = 0, haveFast = true;
  const server = http.createServer((req, res) => {
    if (req.url === "/fast") {
      fastHits++;
      if (!haveFast) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(fastFixture));
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(fixture));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const p = new SplinkPoller({ urls: [`http://127.0.0.1:${server.address().port}/`] });
    assert.strictEqual(await p.pollFast(), true);
    assert.strictEqual(p.fastDoc.battery_soc_percent, fastFixture.battery_soc_percent);
    haveFast = false;
    assert.strictEqual(await p.pollFast(), false);
    assert.strictEqual(p.fastSupported, false);
    const hits = fastHits;
    await p.pollFast();
    assert.strictEqual(fastHits, hits, "no further /fast requests once it 404s");
  } finally { server.close(); }
});

t("energy counters: SP PRO daily counters as-is", () => {
  const r = parseBridge(fixture, Date.parse(fixture.sp_pro.today_read_at) + 60_000);
  assert.strictEqual(r.energy.batteryInKwh.value, fixture.sp_pro.today.battery_in_kwh);
  assert.strictEqual(r.energy.batteryOutKwh.value, fixture.sp_pro.today.battery_out_kwh);
  assert.strictEqual(r.energy.loadKwh.value, fixture.sp_pro.today.ac_load_kwh);
  assert.strictEqual(r.energy.generatorKwh.value, fixture.sp_pro.today.ac_input_kwh);
  assert.strictEqual(r.energy.loadKwh.ageSec, 60);
});

t("each inverter separately: key and name from the bridge, power and lifetime energy", () => {
  const r = parseBridge(fixture, readAt);
  assert.deepStrictEqual(r.inverters.map((i) => i.key), fixture.fronius.map((i) => i.name));
  assert.strictEqual(r.inverters[0].name, fixture.fronius[0].custom_name);
  assert.strictEqual(r.inverters[0].energyKwh.value, fixture.fronius[0].energy.total_wh / 1000);
  assert.strictEqual(r.inverters[1].powerKw.value, fixture.fronius[1].ac.power_watts / 1000);
});

t("one unhealthy inverter doesn't hide the other", () => {
  const d = clone(); d.fronius[0].healthy = false;
  const r = parseBridge(d, readAt);
  assert.ok(Number.isNaN(r.inverters[0].energyKwh.value));
  assert.strictEqual(r.inverters[1].energyKwh.value, d.fronius[1].energy.total_wh / 1000);
  assert.ok(Number.isNaN(r.pvKw.value), "the combined PV the brain decides on still needs both");
});

Promise.all(results).then(() => console.log(`\n${pass} passed`));
