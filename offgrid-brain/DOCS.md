# Off-Grid Brain

A load-shedding and dispatch controller for an off-grid solar + battery house,
running as a Home Assistant add-on. It was built for a Selectronic SP PRO
grid-former with AC-coupled Fronius GEN24 inverters, but nothing in the policy
engine is specific to that hardware.

The brain walks **one unified dispatch list** every tick: solar fills it top to
bottom, charge rungs set how deep each load may discharge the battery, and loads
run only if there is energy at their depth. The same list format (and the same
expression engine, `app/policy/expr.js`) drives a companion simulator that
backtests a policy against a measured year of PV and weather, so a policy proven
in the simulator is the policy that executes.

## Install

1. Settings → Add-ons → Add-on Store → ⋮ → **Repositories** → add
   `https://github.com/peter-dolkens/hass-offgrid-brain`.
2. Install **Off-Grid Brain**, open **Configuration**, and set up a battery SoC
   source (`splink` or `sources.battery_soc`).
3. Start it. **It ships with `dry_run: true`**: it decides and logs, and touches
   nothing. Watch the log until you trust it, then turn `dry_run` off.

## The panel

The add-on adds **Off-Grid Brain** to the Home Assistant sidebar (Ingress, admin only):

- **Live:** battery, load and solar with where each reading came from and how old
  it is, then the dispatch list exactly as the last tick walked it. Each entry shows
  its outcome (running, shed, not needed, deficit), how its power split between
  solar and battery, and why. A gauge shows the battery against each charge rung's
  floor, with the condition variables the tick saw underneath. Banners appear for
  safe mode, deficits, expression errors and a stalled loop.
- **Policy:** edit `policy.json` in place. **Check** validates the structure and
  compiles every condition, then previews the candidate against the last tick's
  readings: which devices would start or shed. **Apply** saves it (the previous
  version is kept as `policy.json.bak`) and takes effect immediately, with no restart.

The panel loads nothing from the internet, so it works when the site's connection is down.

## Configuration

### Where readings come from

Each input takes the **first fresh reading** (newer than 300 s) from these, in order:

| Input | 1st | 2nd | 3rd |
|---|---|---|---|
| Battery SoC | `splink` | `sources.battery_soc` | none: safe mode |
| House load | `splink` | `sources.load_power` | none |
| PV | `splink` | `sources.pv_power` | `fronius` |

The log line for every tick says which source each reading came from, e.g.
`soc=87.2%(splink) load=640W(splink) pv=3120W(ha)`.

### `splink`: SP PRO bridge (recommended)

The Selectronic SP PRO is the only device that knows the battery's state of
charge, and select.live2 has no LAN API. A [splink-cli](https://github.com/peter-dolkens/splink-cli)
bridge reads the SP PRO over its own protocol and serves one JSON document with
the battery, the AC load and the AC-coupled Fronius inverters. That covers
everything the brain needs in one read, without depending on Home Assistant or MQTT.

```yaml
splink:
  enabled: true
  urls:
    - http://192.168.1.50:8080/        # the bridge on the LAN: works through an internet outage
    - https://solar.example.com/       # a tunnel to it: works from off site
  poll_seconds: 15                     # full document: PV and everything else
  fast_seconds: 3                      # /fast window: SoC and load, for shedding
  access_client_id: ""                 # Cloudflare Access service token, if the
  access_client_secret: ""             # tunnel is behind Access
```

Each URL is the bridge's base address: the brain reads the full document from it
and the bridge's **fast window** from `<url>fast`. The fast window carries SoC and
AC load re-read every few seconds, which is what shedding needs; the full document
supplies PV and refreshes its SP PRO section only about every two minutes. Each
reading comes from whichever is newer. A bridge without `/fast` is detected and
skipped.

URLs are tried in order and the first that answers wins. Freshness comes from
when the bridge last **read the hardware** (`live_read_at`), not from when the
document was fetched. A bridge whose serial link has wedged keeps serving its last
reading, and that reading ages into safe mode instead of looking current. PV is
used only when every inverter reported, so a partial sum never under-reads solar.

### `sources`: logical name → HA entity

| Key | What it needs | Required |
|---|---|---|
| `battery_soc` | Battery state of charge, % | Only without `splink` (see Safe mode) |
| `pv_power` | PV production, W | No |
| `load_power` | House load, W | No, but `autonomy` degrades without load |
| `outdoor_temp` | Outdoor temperature, °C | No |
| `pv_forecast_today` | Forecast generation today, kWh | No (see Known gaps) |

Every entity is optional and may be left blank. An entity that doesn't resolve reads
as unavailable.

### `devices`: what the brain may switch

```yaml
devices:
  - id: ev                      # must match a device id in policy.json
    name: EV charger
    kw: 7.0                     # nameplate draw used for the power budget
    switch: switch.ev_contactor # omit to make the device advisory-only
    power_sensor: sensor.ev_power
    min_dwell_seconds: 600      # minimum time between state changes
```

A device with no `switch` is **advisory only**: the brain reasons about its power
but never actuates it. Use that for anything not yet wired.

### `battery`

`capacity_kwh`, `inverter_kw` (the battery inverter's continuous rating),
`max_charge_kw`, `reserve_pct` (the floor nothing may discharge below).

### `fronius`: optional direct polling

```yaml
fronius:
  enabled: true
  hosts: ["192.168.1.21", "192.168.1.22"]
  poll_seconds: 10
  publish_to_ha: true     # requires mqtt.enabled
```

Not needed with `splink`, which already reads the inverters. Use this, the bridge
or the Fronius HA integration; one is enough.

Known GEN24 limitations:

- `GetArchiveData.cgi` returns 404. The API is realtime-only, so history must be polled.
- `DAY_ENERGY` and `YEAR_ENERGY` read null; only `TOTAL_ENERGY` populates.
- **The inverters cannot supply battery SoC.** `P_Akku`, `P_Grid` and `P_Load` are
  all null and there is no Storage device. SoC must come from the battery inverter.
- When an off-grid battery inverter curtails them they become load-following, so
  `PAC` is *delivered* power, not available solar.

### `mqtt`: optional bridge

Publishes the brain's state as an **Off-Grid Brain** device via MQTT discovery:
battery SoC (the real reading, even in safe mode), load, solar, charging and
deficit power, autonomy, the deepest floor, the number and list of loads shed,
and `safe_mode` / `dry_run` binary sensors. The numeric sensors keep long-term
statistics.

```yaml
mqtt:
  enabled: true
  host: core-mosquitto      # blank = use the Mosquitto add-on's own credentials
  port: 1883
  username: offgrid-brain
  password: "..."
```

## The policy file

The dispatch list lives at `/config/policy.json` (the add-on's config dir), not in
add-on options. It is structured, it contains expressions, and it should be easy to
diff against the simulator's defaults. A starter file is written on first run.

```json
{
  "devices": [{ "id": "compute", "name": "NAS / AI", "kw": 0.35 }],
  "list": [
    { "type": "load", "dev": "standby", "cond": "1", "gen": true },
    { "type": "charge", "to": 40 },
    { "type": "load", "dev": "compute", "cond": "autonomy>1.5 ? 1 : (surplus>0.5 ? 1 : 0)" }
  ]
}
```

**Entry semantics (identical to the simulator):**

- `{"type":"charge","to":Y}`: fill the battery to Y% here, **and** act as a
  discharge **floor**, so no entry below may pull the battery under Y%.
- `{"type":"load","dev":...,"cond":...,"gen":...}`: run `dev` when `cond`
  evaluates 0–1. A device may appear **several times** for progressive service
  levels; deeper entries are only reached if power remains at that depth.
- `"gen": true` marks a load that **cannot be shed**. That's either physical (the
  inverters' own standby draw) or because shedding it is self-defeating (the
  router and switch are the control path). When solar and battery can't cover a
  gen-backed load, the brain raises a **deficit** and keeps it running.

Expression variables: `occ dark sun hour dow weekend month soc pv surplus tout
forecast used gap season autonomy`.

## Safety

- **Tick rate:** the list is walked every `tick_seconds` (default 5 s), so a load
  spike is acted on within seconds. The log gets an info line only when what runs
  changes, plus a heartbeat every 5 minutes; every tick is logged at `debug`.
- **`dry_run`** (default **on**): decide and log, actuate nothing.
- **Safe mode:** if no fresh battery SoC is available (older than 300 s, or no
  source answers), the brain substitutes the reserve percentage rather than
  guessing. On an off-grid system an over-optimistic SoC flattens the bank, so it
  fails *austere*: the reachable depth of the list collapses and everything
  discretionary sheds.
- **Minimum dwell:** per device, default 300 s. Stops contactors and compressors
  short-cycling when a value hovers at a threshold.
- **Gen-backed loads are never switched off.** This is enforced in the actuator as
  well as in the policy walk.
- Every decision carries a human-readable reason, in the log and over MQTT.

## Known gaps

- `used` (per-device daily budgets) and `gap` (zone temperature delta) are always 0,
  so policies relying on them behave as if the value were zero. Zone thermal
  dispatch isn't implemented yet; this release handles switchable loads.
- `forecast` approximates the simulator's "next 24 h PV ÷ seasonal median" using the
  forecast entity over trailing mean load, and is 1.0 when no forecast is mapped.
  The simulator has perfect foresight and the brain doesn't. This is the largest
  known sim/reality divergence. `autonomy` self-corrects against real SoC every
  tick, which is why a single merit ladder was chosen over per-regime ladders.

## Dependencies

The control path has **no npm dependencies**. The add-on runs on Node 22 and uses
its built-in `fetch` and global `WebSocket`. That's deliberate: these are how the
brain sees and acts on the house, and an npm registry outage during a rebuild must
not be able to break them. Off-grid sites often have patchy internet.

`mqtt` is the single **optional** dependency, needed only for the bridge. If it is
missing, the add-on still starts and runs; it logs an error and disables the
bridge. The image build tolerates a failed `npm install` for the same reason.

## Developing

```bash
cd offgrid-brain/app
npm test                        # behavioural tests, no dev dependencies
node tools-dryrun.js            # replay scenarios against a policy, print decisions
node tools-dryrun.js /path/to/policy.json

# Run the brain itself against a live bridge, outside Home Assistant:
OPTIONS_PATH=./options.json POLICY_PATH=./policy.json node main.js
```

`app/policy/expr.js` is vendored from the simulator. `tools/sync-policy-engine.sh`
re-vendors it, and `test/engine-sync.test.js` checks the two still match. Both
skip when the simulator source isn't alongside.
