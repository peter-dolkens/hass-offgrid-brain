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
2. Install and start **Off-Grid Brain**, then open its panel in the sidebar.
3. In **Settings**, set up a battery SoC source (the SP PRO bridge, or a Home
   Assistant entity) and your devices. **It starts in dry run**: it decides and
   logs, and touches nothing. Watch it until you trust it, then turn dry run off
   in Settings (it asks you to confirm).

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

Almost everything is configured from the panel's **Settings** tab and applies
immediately, without a restart. Readings are chosen with **entity pickers**
filtered to suitable Home Assistant entities, showing each one's name, area and
current value. Settings are stored in `/config/settings.json` (previous version
kept as `.bak`). Devices are edited in the same tab and stored with the dispatch
list in `/config/policy.json`. The YAML below shows the same keys as they appear
in `settings.json`.

The add-on's own **Configuration** screen holds only the log level and secrets:
the MQTT connection, and a Cloudflare Access token for reading the SP PRO bridge
through an Access-protected tunnel. Installs from before 0.9.0 had everything there;
0.9.0–0.11 copied it into `settings.json` (and device switches into `policy.json`)
on first start, and 0.12.0 removes the old fields.

### Battery and solar inverters

The battery and each solar inverter are configured as **tiles** in Settings. Each
has a name and an **integration** that decides how it's read. Picking an
integration reveals its fields.

**Battery** (one tile): SoC, battery power, house load and energy.

| Integration | Fields |
|---|---|
| SP PRO bridge | none: everything comes from the bridge, including charger state and charge limit |
| Home Assistant | SoC entity (required); battery power (positive = discharging), house load, energy in/out (optional) |
| None | none: with no SoC the brain stays in safe mode |

All integrations also take capacity (kWh), reserve (%), inverter rating (kW) and
max charge (kW).

**Solar inverters** (a tile each, **Add inverter** / **Save inverters**):

| Integration | Fields |
|---|---|
| SP PRO bridge | which of the bridge's inverters it is |
| Fronius (direct) | IP or hostname, poll interval: read from the inverter's own Solar API |
| Home Assistant | power entity; energy entity (optional, for the Energy dashboard) |
| None | none: no live reading, counts toward available capacity only |

Every inverter also takes its **AC rating** (kW) and **array** (kWp). A blank kWp
uses what the inverter reports (Fronius `PVPower`), and with no integration kWp is
required. **Delivered solar** is the sum of the inverters' readings when every
inverter with an integration has a fresh one; otherwise the bridge's own total is used.
Home Assistant power and energy entities are converted from their own units
(W/kW, Wh/kWh).

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

The bridge is a **connection**: the battery and any inverter whose integration is
the bridge read through it. Each URL is the bridge's base address: the brain reads the full document from it
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

### Available solar (curtailment)

Off grid, the battery inverter **throttles AC-coupled solar to the load once the
battery is full**. The inverters' output is then what was *delivered*, not what the
sun could give, so on its own it would never show surplus to spend. The brain
estimates what each array **could** produce:

    available = irradiance / 1000 × array kWp × k,  capped at that inverter's AC rating

- **Each inverter's own AC rating and array kWp** come from its tile (see above).
  An inverter without an AC rating is capped at its kWp and flagged in the panel.
- **k** captures everything a horizontal irradiance sensor doesn't know about the
  array: tilt and azimuth, temperature, soiling and losses. It is **learned per
  inverter and per half-hour of the day**, only from moments the array is
  demonstrably unthrottled: the battery taking at least 0.5 kW below 99.5% SoC, and
  solar well under load plus the charge limit. The charger *state* isn't used,
  because an SP PRO stays in "Long Term Float" while topping up each morning. A
  half-hour with few samples leans on a typical 0.85 until it has more. Learned
  values persist across restarts.
- For **dispatch** the brain spends the larger of delivered and available solar,
  so surplus-only loads can run on a full battery. An array whose available power
  exceeds its delivered power by a margin is reported as **throttled**.

On a lightly loaded site the battery is usually full within the first hour of sun,
so only early-morning half-hours learn. The rest use the typical value until the
house draws the battery down further.

### `ecowitt`: irradiance from an Ecowitt gateway

```yaml
ecowitt:
  enabled: true
  urls: ["http://192.168.1.30/", "http://192.168.1.31/"]   # e.g. Ethernet, then Wi-Fi
  poll_seconds: 10
```

Reads solar radiation (`0x15`) from the gateway's local API (`/get_livedata_info`).
It needs a solar sensor on the gateway, such as a WS90.

### Other readings

Settings → Readings maps the readings that don't belong to the battery or an
inverter: **irradiance** (when no Ecowitt gateway is polled), **outdoor
temperature** and the **solar forecast** for today (kWh). All are optional.

### Loads: what the brain may switch

Edited in Settings → **Loads** and stored in `policy.json` (as `devices`, the name
the dispatch list and the simulator use):

```json
{ "id": "ev", "name": "EV charger", "kw": 7.0,
  "switch": "switch.ev_contactor", "power_sensor": "sensor.ev_power", "min_dwell_seconds": 600 }
```

`kw` is the nameplate draw used for the power budget. The switch can be a
`switch`, `input_boolean`, `light`, `fan`, `climate`, `water_heater` or
`humidifier` entity; leave it empty to make the load advisory-only.
`min_dwell_seconds` (default 300) is the minimum time between state changes.

A device with no `switch` is **advisory only**: the brain reasons about its power
but never actuates it. Use that for anything not yet wired.

### `battery`

`capacity_kwh`, `inverter_kw` (the battery inverter's continuous rating),
`max_charge_kw`, `reserve_pct` (the floor nothing may discharge below).

### Fronius inverters

Add a Fronius inverter as a tile with the **Fronius (direct)** integration (or read
it through the SP PRO bridge). Known GEN24 limitations:

- `GetArchiveData.cgi` returns 404. The API is realtime-only, so history must be polled.
- `DAY_ENERGY` and `YEAR_ENERGY` read null; only `TOTAL_ENERGY` populates.
- **The inverters cannot supply battery SoC.** `P_Akku`, `P_Grid` and `P_Load` are
  all null and there is no Storage device. SoC must come from the battery inverter.
- When an off-grid battery inverter curtails them they become load-following, so
  `PAC` is *delivered* power, not available solar.
- A sleeping inverter (at night) answers without `PAC`; that reads as 0 W.

### `mqtt`: optional bridge (add-on options)

Solar entities: irradiance, available solar (total and per array), solar headroom
(available minus delivered), and a **Solar curtailed** binary sensor.


Publishes the brain's state as an **Off-Grid Brain** device via MQTT discovery:
battery SoC (the real reading, even in safe mode), load, solar, battery, charging
and deficit power, autonomy, the deepest floor, the number and list of loads shed,
and `safe_mode` / `dry_run` binary sensors. The numeric sensors keep long-term
statistics.

With `splink` it also publishes the counters the **Energy dashboard** needs:

| Energy dashboard | Entity | Source |
|---|---|---|
| Solar production, one per inverter | `sensor.offgrid_brain_solar_<name>_energy` (+ `_power`) | each Fronius lifetime counter |
| Battery: energy going in | `sensor.offgrid_brain_battery_in_energy` | SP PRO, today |
| Battery: energy coming out | `sensor.offgrid_brain_battery_out_energy` | SP PRO, today |
| Battery power | `sensor.offgrid_brain_battery_power` | SP PRO; positive = discharging |
| Grid consumption (generator) | `sensor.offgrid_brain_generator_energy` | SP PRO AC input, today |
| Individual device | `sensor.offgrid_brain_load_energy` | SP PRO AC load, today |

Each inverter is published on its own, keyed by the bridge's inverter name (e.g.
`solar_right_energy`), so one array going quiet shows up against the other.

The SP PRO only exposes daily counters, reset at its own midnight. They are
`total_increasing`, so Home Assistant treats the reset as a new cycle. A counter
the bridge hasn't refreshed for 15 minutes isn't published, so the last value
stands rather than going unknown.

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
forecast used gap season autonomy`. `autonomy` is in **days** in conditions,
as in the simulator; the panel, log and MQTT sensor show it in hours.

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
