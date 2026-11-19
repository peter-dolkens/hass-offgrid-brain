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

- **Live:** a **timeline** of the last 24 h, as the brain recorded it, and the next
  24 h, projected (battery %, solar used and available, load, and when loads shed).
  The projection walks the dispatch list in half-hour steps, using the solar
  forecast and the last day's load at the same time of day, plus the battery
  inverter's own draw. That draw is learned from the recording as battery discharge
  minus AC load with no sun, about 40 W on an SP PRO. Hours where the battery would
  sit at the reserve are tinted. With a comparison forecast set (Solcast), the
  projection also shows the forecast's low and high cases as shaded bands around
  solar available and battery %, and the shedding plan (and the reserve tint) is
  made on the **low** case, so loads are planned against a dull day. Over the past
  day a dashed line shows what the forecast said for each hour just before it
  began, with its low-high range, so it can be read against the solar actually
  available. Click or drag
  the timeline to look at any
  moment, or press **Replay** to play the last day at 60×, 600× or 900× until it
  catches up to now. Scroll down and the timeline follows as a compact scrubber
  pinned under the header, with the same controls; it shrinks with the scroll as
  the full chart slides away.
  Under it are three panels for the moment being viewed:
  - **Battery:** a ring with each charge rung's floor and the reserve, the
    charge/discharge rate as an inner arc, and when it reaches full or the next floor.
  - **Inverters:** a split dial around the total load, with zero at 12 o'clock.
    The house is AC-coupled: the solar inverters and the battery inverter all feed
    its AC bus, so the battery inverter only carries load minus solar, and its
    ratings apply to that share, not the whole load.
    - The solar inverters fill anticlockwise, one shade each, up to their combined
      AC rating, over the sun available.
    - The battery inverter fills clockwise, either supplying the house or charging
      from surplus sun, up to its top short-term rating. Its short-term bands darken
      as the time allowed gets shorter, and above continuous it says how long it may
      run.

    Both arms share a square-root scale, so a 70 W night load is still visible
    and 7.5–13 kW still spreads out.
  - **Loads:** which are running and which are shed.

  Below them is the dispatch list exactly as the last tick walked it: each entry's
  outcome (running, shed, not needed, deficit), how its power split between solar
  and battery, and why. The condition variables the tick saw are underneath. Banners
  appear for safe mode, deficits, expression errors and a stalled loop. The brain
  keeps its own history (one sample a minute, in `/data/timeline.json`), so the
  timeline needs no recorder or database.
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

The add-on's own **Configuration** screen holds only the log level and the MQTT
connection. Installs from before 0.9.0 had everything there; 0.9.0–0.11 copied it
into `settings.json` (and device switches into `policy.json`) on first start, and
0.12.0 removed the old fields.

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

### The hourly log: forecast against actual

Once an hour the brain writes a row to `history/hourly-<year>.jsonl` in its config
folder (`/addon_configs/<slug>_offgrid_brain/`, included in Home Assistant backups),
for tuning the model. Each row has:

- **forecast:** the solar forecast's kWh for that hour as it stood at least 24 h
  before (`d1`), at least 6 h before (`h6`) and just before the hour began (`last`);
- **proj_soc:** the battery % the brain projected for the end of the hour, 23+ h
  and 6+ h ahead;
- **actuals,** from the minute-by-minute recording: mean irradiance, outdoor
  temperature, solar delivered and available, load, battery charged and
  discharged, battery % at the end of the hour, and the minutes the arrays were
  throttled;
- **DC string voltage:** its hourly mean and peak, and the first minute of the hour
  it showed light. It rises at first light before the inverters deliver, and sits
  high when they're throttled.

A second forecast can be logged beside the first for comparison: set **Comparison
forecast** (`sources.compare_forecast`) to Solcast's entity prefix, e.g.
`sensor.solcast_pv_forecast`. Each row then has a `solcast` block with the same
vintages plus its low/high range (`p10_last`, `p90_last`). The brain doesn't plan with
it; keep it out of the Energy dashboard, or the brain would add it to the first.

`GET /api/history?days=N` returns the last N days.

**Blocked irradiance sensor.** If irradiance drops below 10% of its recent level
(from at least 300 W/m²) in a single reading, and nothing else agrees the sun has
gone, the brain holds the last good level. "Nothing else" means the solar forecast
for now wasn't expecting darkness, or the inverters are delivering more than that
darkness could give. Sun doesn't do that, but a bird on the sensor does. The hold
ends when the reading recovers to half the held level, or after 10 minutes, when
the new level is accepted as real weather. Each event goes to
`history/events-<year>.jsonl`, and the hourly row counts the minutes held
(`irradiance_held_min`).

### Other readings

Settings → Readings maps the readings that don't belong to the battery or an
inverter: **irradiance** (when no Ecowitt gateway is polled) and **outdoor
temperature** (otherwise read from the Ecowitt gateway). Both are optional.

### Solar forecast

The brain reads the hourly forecasts that Home Assistant's Energy dashboard has
attached to solar, through the same call the dashboard uses, and adds them up
across every plane. To set it up, add a forecast integration (Forecast.Solar,
Solcast, ...) with one plane per array. Then, in Settings → Dashboards → Energy, pick
it as the forecast on each solar source. The forecast drives:

- `autonomy`, which plans for the worse of today's and tomorrow's totals (the
  simulator's worst-day lookahead);
- the `forecast` variable, which is the next 24 h of forecast PV over the expected
  daily load;
- the Live timeline's projection. Its low/high range borrows Solcast's: each hour
  of the planning forecast is scaled by Solcast's p10/p50 and p90/p50 for that hour
  (hours where Solcast expects under 50 W keep a single figure), and the high case
  is capped at the inverters' AC total.

**Solar forecast override** in Settings takes a single kWh entity instead, if you'd
rather use one.

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

**Important or convenience.** Every load is *important* unless you untick
**Important** in the Loads table (`"important": false` in policy.json). A dispatch
entry can override its load either way with its own `"important"`. When a load
ends up not running:

- if any of its entries that went unserved was important, it is **shed**. It shows
  red in the Loads panel, marks the timeline's strip, and counts in the MQTT
  `shed_count`;
- otherwise it is **held back**. An EV waiting for surplus, or a comfort setpoint
  the battery can't afford, shows grey and counts in `held_back_count`.

For example, an office whose frost/heat protection entry (`gap > 10`) is
important but whose comfort and soak entries are not is only flagged when the
protection can't run.

### `battery`

`capacity_kwh`, `inverter_kw` (the battery inverter's continuous rating),
`max_charge_kw`, `reserve_pct` (the floor nothing may discharge below),
`hysteresis_pct` (default 3; a load already running may keep drawing the battery
this far below its entry's floor, but never below the reserve, so loads don't flip
on and off at a charge rung, e.g. sitting at 99.9% under "charge to 100%"),
`full_dwell` (when a charge rung counts as reached: once the battery has stayed
close to it for `base_seconds × e^(growth × depth²)`, depth in % below the rung.
The defaults, 59.6 s and 0.656, give 0.1% → 60 s, 1% → 1.9 min, 2% → 13.7 min,
2.5% → 60 min, 3% → effectively never. A dip during the wait counts at its own depth. A reached rung stops holding back solar for the battery and lets the entries below
it start on the battery, so a battery tapering at 99.x% still "reaches" 100%),
`charge_calibration_pct` (default 100; if wear means the battery now only charges to
N% of its original capacity, set N: the reported SoC is rescaled so N% reads and
counts as 100% everywhere, and the usable capacity becomes N% of `capacity_kwh`),
and
optionally `ratings`, the short-term ratings above continuous as
`[{ "kw": 8, "seconds": 3600 }, ...]`, which are marked on the Live load gauge. A
longer duration must have a lower kW. An SP PRO 7.5 is 7.5 kW continuous, 8 kW for
60 min, 11.25 kW for 30 min, 13 kW for 60 s and 18 kW for 30 s.

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
(available minus delivered), a **Solar curtailed** binary sensor, and **Solar
available energy** (`sensor.offgrid_brain_solar_available_energy`, kWh, total
increasing): what the arrays could have generated, lifetime. Home Assistant's
statistics of it give the site's daily solar resource even on days the battery was
full and the inverters were throttled. It isn't generation, so don't put it in the
Energy dashboard's solar slot; use a statistics graph (period: day, type: change).


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

## Climate brain

The climate brain plans heating and cooling per **zone** and offers each zone to the
dispatch list as a set of **comfort levels**, so the battery decides how much comfort
it can afford, and shedding climate widens a room's band by degrees before anything
is switched off. It learns from history: the setpoints people choose, when rooms are
occupied, how fast each room heats and cools, and what each unit really draws. It
is off until enabled in Settings → **Climate brain**, and like everything else it
only advises in dry run. Design notes: `docs/climate-design.md`.

### Zones

Settings → **Climate zones**, one tile per zone (stored in `settings.json` under
`climate.zones`):

| Field | |
|---|---|
| Name, area, floor area | The zone's MQTT device takes its name and area; the floor area seeds its thermal model. |
| Temperature sensors | One or more, averaged. A sensor counts while available and reported to Home Assistant within 3 h (its `last_reported`, re-read from Home Assistant every 3 minutes, since a sensor repeating the same value sends no change). |
| Humidity | Optional. Above 70% the cooling setpoint drops 1 °C, until it falls below 65%. |
| Presence | Any number of occupancy, motion or presence entities, OR'ed: the wasp-in-a-box template binary_sensors, PIRs, `person`/`device_tracker`, or a count. `unavailable`/`unknown` is **unknown**, not empty: with no known reading the zone uses its learned pattern. A zone stays occupied for **Vacancy delay** after its sensors clear. |
| Windows and doors | Any one open for **Window delay** (60 s) turns the zone off. |
| Heat to / Cool to / Setback | Per-zone overrides of the defaults; blank heat/cool means learned. |
| Energy class, priority | Where its levels go in the list when it has no entries of its own (below). |
| Takes over load | A load in the policy whose `sp` rules now drive this zone (below). |
| Advice only | Plan and advise, never command this zone, whatever dry run says. |
| Outputs | **A/C**: a climate entity, heat and/or cool. **Hydronic**: a zone thermostat (climate entity) or a valve/pump switch, with an optional shared **heat source** (boiler or heat pump, climate or switch) that runs while any of its zones calls. Each has kW, minimum run and off times (A/C 300/300 s, hydronic 180/180 s), and optional meters. |

A zone with **no outputs** is **advisory**: planned and shown, but it has nothing real
to power, so it takes no budget from real loads and isn't in the projection. What
the ladder would give it comes from a separate shadow walk.

**Meters.** Give each output its circuit's **power meter** (a Shelly Pro 3EM channel,
W or kW) and the brain treats it as the truth: the thermal model is fit on the
measured draw, a **consumption curve** is learned per unit and side (running kW
against the lift between setpoint and outdoor temperature) and replaces the
nameplate kW once it has enough data, so planned power and the projection's kWh use
what the unit really draws. A unit that says it's heating or cooling (by its
`hvac_action`, or with none, its mode and the room against its setpoint), or that the
brain commanded, but reads ~0 W for 10 minutes is flagged (and one drawing power
while off), on Live and as the zone's **Unit problem** entity. An **energy meter**
(kWh) stands in when there's no power meter. Several outputs may name the **same
meter** (a shared circuit): its reading, less a baseline learned while none of them
runs (other loads on the circuit), is split over the outputs that are running, by
their kW, which is approximate. Tick **Only climate on this circuit** when nothing
else is on it: a draw then means some unit is running even if none says so. A
hydronic heat source's own meter (**Source meter**) is shared over the zones calling
for it in the same way. Without meters the configured kW is used while a unit is
running.

The defaults (Settings → Climate brain): heat to 20 °C, cool to 25 °C, setback 3 °C,
away 6 °C, protect between 10 and 32 °C, pre-conditioning up to 120 min ahead with a
90 min grace, occupancy threshold 0.5, hand changes respected for 120 min, 14 days of
history to learn from on first start. **Soak** (surplus solar into rooms, 3 °C) is
**off** until it has been watched on real hardware. **House presence** (optional,
e.g. a group of people: off/not_home = away) widens every band to the away setback,
stops pre-conditioning and pauses occupancy learning. **Weather forecast**: a
weather entity with an hourly (else daily) forecast; without one the recorded last
day's outdoor temperature is used. With no outdoor reading at all nothing is assumed:
power is planned from the room alone.

### What it learns

- **Preferences.** A setpoint change is learned for the zone, weekday or weekend,
  hour of day, and heat or cool, spread over neighbouring hours and fading with a
  21-day half-life. Who made it decides how much it counts, from Home Assistant's
  state context:
  - a **person** (a user other than the brain: the UI, an app) counts fully, and a
    setting a person leaves alone counts a little each hour;
  - **unknown** (a context with no user and no parent: a time- or sun-triggered
    automation, or someone at the unit's own buttons) counts at 0.3 and is never
    held as an override;
  - the **brain's own** changes (its service calls, its Home Assistant user, or a
    setting within half a step of its last command, remembered across restarts) and
    **automations** reacting to something (a context with a parent) aren't learned.

  The comfort setpoints move from the defaults toward what was learned as confidence
  grows. When the brain is actuating and a person changes what it set, that's an
  **override**: learned more strongly (1.5×), and left alone for **Respect changes by
  hand** minutes while comfort is affordable. If the battery can't afford it the
  override is dropped and the brain plans the zone again (from preferences that have
  already learned the setting); it doesn't resume a stale setting later. Turned off
  by hand stays off, except that protection still heats a freezing room.
- **Occupancy.** Each hour's occupied fraction, by hour of the week (28-day
  half-life), leaning on weekday/weekend patterns and then the house schedule where
  there is little data. It predicts when a room will next be occupied.
- **Thermal model.** Per zone, `dT/dt = a (Tout − T) + bh·Pheat − bc·Pcool + g + s·sun
  + bl·Plag`, fit online over 15-minute windows (the heat delivered is COP × the
  electrical kW; the fit absorbs the COP). `s` is solar gain from irradiance, and
  `Plag` heating smoothed over ~2 h for hydronic zones (a slab keeps giving heat). A
  window is skipped if a window was open, a reading was missing, the set of
  temperature sensors changed, or the model can't explain it at all. Planning uses
  the fit once it's 30% confident, and the floor-area prior until then. It predicts
  the power to reach a setpoint, how long warm-up takes, and how long a room coasts.
- On first start each zone replays **Learn from history** days of Home Assistant
  history (its sensors, thermostats, meters and the outdoor temperature) through the
  same learning, once, a day and an entity at a time. The recorder keeps no context,
  so setpoint changes from history count as unknown (0.3) and untouched settings
  aren't sampled: history gives a starting point that live, attributed changes soon
  outweigh. Occupancy and the thermal model learn from history in full.

Learning lives in `/data/climate.json` (versioned). A file that can't be read is kept
as `climate.json.corrupt` and learning starts again. **Before going live** it can be
deleted (stop the add-on, remove `/data/climate.json`, start it) to start learning
afresh, e.g. if dry-run weeks included setpoints nobody would want learned; the zones
re-seed from history on the next start.

### Comfort levels and the ladder

Each tick a zone picks its side (heat or cool: from the room against its band, else
which way it's drifting) and offers five levels. `sp` is the offset from the comfort
setpoint toward ambient, the same `sp` the simulator uses; the level table is shared
with the simulator (`climate-levels.js`):

| Level | Holds | Offered when |
|---|---|---|
| `protect` | 10 °C heating / 32 °C cooling | always; **never shed** (a deficit if it can't be served, like a gen-backed load, so it also runs in safe mode) |
| `setback` | comfort ± setback (away: ± away; +1 °C when the low-case projection is tight) | always |
| `comfort` | the comfort setpoint | occupied (or held at a person's setting) |
| `precondition` | the comfort setpoint, reached by the predicted arrival | empty, but likely occupied within the warm-up lead the model predicts, or due now; once started it holds until people come or the grace runs out; not when away, nor long leads when tight |
| `soak` | up to `soak` °C past the setpoint toward the band's far edge (pre-cool before a hot afternoon, pre-heat before a cold night) | soak on, sun now, a need later in the forecast, surplus forecast (the low case reaches full) or comfort projected to shed later, and never against what the room needs now |

Each level's kW is the power to reach its setpoint within the hour (pre-conditioning:
by the arrival time), at least the steady-state power to hold it, capped at the
outputs' rating: modelled, not a nameplate. The walk grants levels like any other
load, and the zone gets the **tightest level granted**. A level costing nothing more
than one already granted counts as granted. So as the battery drops, a zone loses
soak, then pre-conditioning, then comfort (its band widens to the setback), then the
setback, keeping protection; a room on the comfortable side of its granted setpoint
**coasts** with the unit off, and the panel shows how long it will hold. Only when
even protection can't be served is it **shed**. A person's setting stands only while
comfort is granted; below that the brain enforces the granted band and drops the
override.

If the room temperature is lost, the zone isn't switched off: the unit's own
thermostat is given the setback (or protection) setpoint and the zone is flagged. A
valve with no thermostat is left as it is.

Place levels in the list yourself with a `climate` entry:

```json
{ "type": "climate", "zone": "office", "level": "comfort", "floor": 40, "cond": "autonomy > 1" }
```

`cond` is optional and ANDed with the planner's own condition; `floor` is the battery %
the entry needs (on top of the rung above it); `important` overrides the default. A
level placed after the 100% rung only ever runs on surplus, and Live warns about it.
A zone with no entries is **placed automatically**: `protect` just above the first
charge rung, `setback`, `comfort` and `precondition` just after it, each on its own
floor by energy class, and `soak` at the end of the list on 100%:

| Class | setback | comfort | precondition | important |
|---|---|---|---|---|
| essential | 0% (the rung's) | 30% | 50% | setback, comfort |
| comfort | 30% | 40% | 60% | (protect only) |
| luxury | 50% | 60% | not offered | (protect only) |

Within the same place, lower **priority** goes first. In entries for a zone, `occ` is
the zone's own occupancy and `gap` is |outdoor − comfort setpoint|, as the simulator
gives its zones. Each level keeps its own hysteresis, so a zone running at its setback
doesn't hold its comfort level on through the hysteresis band.

**The old zone rules still work.** A policy written for the simulator has zone loads
like `{ "dev": "amber", "cond": "occ", "sp": 5 }`: "while occupied, hold within 5 °C
of the setpoint". Set the zone's **Takes over load** to `amber` (and give the zone its
outputs) and those entries drive the zone unchanged, now with the modelled kW for
that `sp` instead of the load's nameplate, the zone's own `occ` and a real `gap`. A
zone that takes over a load but has no outputs leaves the load as it was. The mapping
to levels:

| Old rule | New level |
|---|---|
| `cond: "gap > 10 ? 1 : 0", sp: 4` (way off target) | `protect` (or `setback`) |
| `cond: "occ", sp: 5` / `sp: 3` (minimal / better comfort) | `setback` (setback 3–5) |
| `cond: "hour>=5", sp: 3` (pre-condition) | `precondition` (from the learned occupancy, not a fixed hour) |
| `cond: "occ and autonomy>1.5 ? 1 : 0", sp: 0` | `comfort` with `cond: "autonomy > 1.5"` |
| `cond: "surplus>2 ? 1 : 0", sp: -2` (soak) | `soak` |

Without **Takes over load** such a device stays an ordinary switched load.

**Projection.** The Live timeline's projection plans each real zone at every step (the
band held, the learned occupancy, the forecast outdoor temperature, and the cost of
recovering a room from its setback when people are due), adds the climate kW the walk
grants to the projected load, and takes the recorded climate draw out of the last-day
load profile so it isn't counted twice. Minutes recorded before the climate brain was
on can't be separated, so for each hour of the day they're used until newer minutes
cover that hour.

### Control

In dry run, or for a zone set to advice only, the brain logs and shows what it would
set ("would set heat 20 °C") and calls nothing. Live, it reconciles every tick: each
climate entity's mode and setpoint (on the unit's own step, inside its min/max) and
each valve or pump (switched around the setpoint with a little hysteresis) is compared
with what the unit is actually doing, and anything different is sent, again after 1
min, 2, 5, 10, then every 30 min while the unit doesn't follow (every 5 min at most
for protection). A new want is sent at once, whatever the backoff; a failed call (Home
Assistant unreachable) is retried every minute. While a unit is held by its minimum
run, it keeps its own setpoint: nothing is sent. A
shared heat source runs while any zone calls (read from its real state). Every output
keeps its minimum run and off times, timed from when the unit was seen to change and
remembered across restarts (a unit seen for the first time is assumed to owe one); a
heat ↔ cool change goes through off. A zone held at a person's setting isn't
commanded, but its running valves keep the heat source on. A zone's devices are the
climate brain's: the switch actuator leaves them alone, unless a climate tick fails,
when they go back to the policy as written.

### Climate on MQTT

Each zone is its own device, named for the zone and placed in its area (if it has
one), a child (`via_device`) of the Off-Grid Brain device: Temperature, Target, Mode,
Comfort level, Band low, Band high, Occupied, Occupancy likelihood, Planned power, and
diagnostics Reason (published when it changes), Model confidence, Preference
confidence and Unit problem. Entity ids are `sensor.offgrid_brain_climate_<zone>_<key>`.
A renamed zone is announced again; a removed zone's entities are removed, even if it
was removed while the brain was stopped.

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
- `{"type":"climate","zone":...,"level":...,"cond":...,"floor":...}`: a climate
  zone's comfort level (see Climate brain).
- A load entry may also carry `floor` (the battery % it needs, on top of its rung),
  and, as the climate brain's entries do, `kw` (instead of the device's nameplate)
  and `vars` (context variables for that entry). The simulator honours them the same
  way.
- `{"type":"load","dev":...,"cond":...,"gen":...}`: run `dev` when `cond`
  evaluates 0–1. A device may appear **several times** for progressive service
  levels; deeper entries are only reached if power remains at that depth.
- `"gen": true` marks a load that **cannot be shed**. That's either physical (the
  inverters' own standby draw) or because shedding it is self-defeating (the
  router and switch are the control path). When solar and battery can't cover a
  gen-backed load, the brain raises a **deficit** and keeps it running.

Expression variables: `occ dark sun hour dow weekend month soc pv surplus tout
forecast used gap season autonomy storm storm_ahead lightning`. In entries for a
climate zone, `occ` and `gap` are the zone's own (see Climate brain). `autonomy` is in
**days** in conditions, as in the simulator; the panel, log and MQTT sensor show it
in hours.

**Storm signal** (Settings → Storm signal):
- `storm` is 1 when a storm is on the house now: an active BoM thunderstorm,
  severe-weather or cyclone warning for the area (the Bureau of Meteorology
  integration's warnings sensor; marine warnings ignored), or lightning within
  **Near** km (30) in the last **Window** minutes (30), from the Blitzortung
  integration's strike counter and distance.
- `storm_ahead` is 1 when BoM forecasts storms today or tomorrow (a lightning icon or
  "storm" in the short summary; give the forecast entity prefix, e.g.
  `sensor.tugrabakh`), or when `storm` is 1.
- `lightning` is the km to the nearest strike in the window, 999 when none.

The simulator has no weather, so there all three are always 0, 0 and 999. Changes are
logged and written to the events log, the Live page shows a banner, and MQTT
publishes **Storm**, **Storm ahead** and **Nearest lightning** for automations of your
own.

Off grid there is no grid to lose, so a storm isn't a reason to bank charge: the dull
days it brings are already in the solar forecast (and the projection plans on its low
case). The signal is for protecting equipment from lightning: e.g. hold a bore or
water pump, outdoor loads or EV charging off while lightning is near, with a
condition like `storm ? 0 : 1` on their entries.

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

- `used` (per-device daily budgets) is always 0, so policies relying on it behave as
  if it were zero. `gap` is 0 except in entries for a climate zone.
- The climate brain has no hardware to drive yet: it has only been run in dry run,
  against simulated zones. The hydronic support assumes a thermostat or valve per
  zone and an on/off heat source; flow-temperature control isn't modelled.
- `forecast` approximates the simulator's "next 24 h PV ÷ seasonal median" using the
  next 24 h of forecast over trailing mean load, and is 1.0 when there is no forecast.
  The simulator has perfect foresight and the brain has a forecast with error. This is the largest
  known sim/reality divergence. `autonomy` self-corrects against real SoC every
  tick, which is why a single merit ladder was chosen over per-regime ladders.
- The timeline's projection repeats the last day's measured load, so it doesn't
  remove the load that shed devices would have drawn.

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
