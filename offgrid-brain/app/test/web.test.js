/* Tests for the ingress web server's safety rules. Run: node test/web.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { remoteAllowed, savePolicy } = require("../web/server.js");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };

const req = (ip) => ({ socket: { remoteAddress: ip } });

t("only the Supervisor's ingress gateway may connect", () => {
  assert.strictEqual(remoteAllowed(req("172.30.32.2"), false), true);
  assert.strictEqual(remoteAllowed(req("::ffff:172.30.32.2"), false), true);
  for (const ip of ["172.30.32.1", "172.30.33.5", "10.24.200.54", "127.0.0.1", "", undefined]) {
    assert.strictEqual(remoteAllowed(req(ip), false), false, `${ip} should be refused`);
  }
});

t("development mode accepts any client", () => {
  assert.strictEqual(remoteAllowed(req("127.0.0.1"), true), true);
});

t("saving keeps the previous policy as .bak and leaves no temp file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-web-"));
  const file = path.join(dir, "policy.json");
  savePolicy(file, { devices: [], list: [], v: 1 });
  assert.ok(!fs.existsSync(`${file}.bak`), "no backup for the first save");
  savePolicy(file, { devices: [], list: [], v: 2 });
  assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).v, 2);
  assert.strictEqual(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")).v, 1);
  assert.ok(!fs.existsSync(`${file}.tmp`));
  fs.rmSync(dir, { recursive: true });
});

console.log(`\n${pass} passed`);
