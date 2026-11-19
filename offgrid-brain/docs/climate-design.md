# Climate brain: design note

Status: implemented in 0.34.0 (revised after review), advisory only until the house
has climate hardware (dry run never actuates; soak ships disabled).

## Goal

Replace fixed zone rules such as `{ "dev": "office", "cond": "occ", "sp": 5 }` ("hold
the room within 5 °C of its setpoint") with a planner that knows each zone's comfort
preferences, occupancy pattern and thermal behaviour, and offers the dispatch ladder
a set of **comfort levels** with a modelled power for each. The ladder decides how much
comfort the battery can afford; shedding climate widens the band by degrees before it
switches anything off.

## Modules (`app/climate/`)

| File | Job |
|---|---|
| `levels.js` | The five comfort levels: wraps `policy/climate-levels.js`, vendored from the simulator (offsets, auto-placement floors, importance). |
| `zones.js` | Zone config (normalise/check), and reading a zone's inputs and outputs from HA states. |
| `learn.js` | `Preferences` (setpoints by zone x day type x hour x heat/cool, decayed, with confidence) and `Occupancy` (probability by hour of week). |
| `thermal.js` | `ThermalModel`: a first-order (RC) room model fit online by recursive least squares. |
| `plan.js` | `planZone()`: pure function from one zone's readings and learned state to its levels, setpoints and kW. |
| `ladder.js` | `expand()` turns climate entries (and legacy `sp` rules on linked devices) into ordinary load entries for `decide()`; `resolve()` reads the walk back into one decision per zone. |
| `actuate.js` | `ClimateActuator`: hvac mode and setpoint, or valve/pump switching, with minimum run/off times. Dry run only advises. |
| `consumption.js` | `ConsumptionCurves`: each unit's metered running draw against lift; `attribute()` splits a shared meter. |
| `seed.js` | Replays Home Assistant history into the learners on first start. |
| `index.js` | `ClimateBrain`: the one object `main.js` talks to. |

`main.js` uses only `ClimateBrain`: `configure`, `entities`, `tick`, `expand`,
`resolve`, `apply`, `expandAt` (projection), `setOutlook`, `snapshot`, `toJSON`.

## The model

    dT/dt [°C/h] = a (Tout - T) + bh Ph - bc Pc + g + s I + bl Plag

`Ph`/`Pc` are electrical kW heating/cooling, `a` the envelope loss rate, `bh`/`bc`
the effect of a kW, `g` internal gains, `s` solar gain per kW/m² of irradiance `I`,
and `bl` the lagged effect of heating smoothed over ~2 h (`Plag`, hydronic zones
only; slab/radiator heat keeps coming after the pump stops). Planning uses
`bh + bl` to hold a temperature and `bh + bl/2` to reach one within a few hours
(an approximation). Fit by RLS over 15-minute windows with a forgetting factor; a
window is dirty (skipped) on an open window, a missing reading, or a change in which
temperature sensors are reporting, and a residual gate skips windows more than
4 sigma + 0.5 °C/h from the model once it has 24 windows; the prior comes from the zone's floor area (the
simulator's 1.2 W/°C·m² envelope, 0.03 kWh/°C·m² mass, COP 3.5), and variance is capped
at the prior so unexcited directions (cooling in winter) don't wind up. Closed-form
predictions: power to reach a setpoint in `h` hours, time to reach it at a given
power, and how long the room coasts before crossing a limit.

## Learning

- **Preferences.** Every setpoint change on a zone's thermostat made by a person (see
  "Learning provenance") is a manual adjustment: it updates the heat or cool preference for that
  day type (weekday/weekend) and hour, spread over neighbouring hours by a Gaussian
  kernel (sigma 1.5 h), weekends borrowing a little from weekdays. Weights decay
  with a 21-day half-life. A setpoint that is left alone is sampled hourly at a low
  weight. Confidence = 1 - e^(-w/1.5); the effective setpoint blends the configured
  default toward the learned mean by that confidence. While the brain is actuating,
  a change away from what it set is an **override**: learned at 1.5x weight and
  respected for `override_hold_min` while comfort is granted.
- **Occupancy.** Presence comes from any number of occupancy/motion/presence
  entities (the wasp-in-a-box template binary_sensors are the intended source),
  OR'ed. `unavailable`/`unknown` is unknown, never "empty": with every presence
  input unknown the zone falls back to its learned probability. Each hour's
  occupied fraction updates a 168-bin hour-of-week table (28-day half-life), shrunk
  toward a weekday/weekend x hour table, shrunk toward the house schedule.
  Occupancy isn't learned while the house is away.
- **Seeding.** On first start (per zone) the last `learn_days` of HA history for
  the zone's entities and the outdoor temperature are replayed through the same code:
  one request per entity per day (attributes only for climate entities), yielding
  between days, guarded against running twice; purged days come back empty.

## Metered power (Shelly Pro 3EM per circuit)

Each output may name a power entity (W/kW) and/or an energy entity (kWh; used for
power only when there is no power entity: the rate between counter changes, 0 after
30 min unchanged), and a hydronic output a `source_power_entity` for its heat source.

- **Truth.** Where a meter exists, the output's running power is the meter's, not
  the nameplate while `hvac_action` says heating. That is what the thermal model is
  fit on (`b` absorbs the COP: heat delivered ≈ COP x electrical kW), what the
  recorder logs as climate draw, and what the projection subtracts from the
  last-day load profile.
- **Consumption curve.** Per output and side, a decayed linear fit of running kW
  (metered, above 80 W, sampled once a minute) against lift (setpoint - outdoor when
  heating, outdoor - setpoint when cooling). The zone's rating per side is the
  curve's prediction for the current lift, blended from the configured kW by
  confidence (1 - e^(-n/20)). Level kW caps, and so the planned kWh in the
  projection, follow it.
- **Shared circuits.** Outputs naming the same meter split its reading, less a
  baseline learned (EWMA) while none of them runs, over those that say they're
  running, by configured kW. With none running they get 0 and the baseline learns,
  unless an output marks the meter `meter_climate_only` (nothing else on the
  circuit): then any draw is a unit running unannounced, split over all by kW.
  Approximate; documented as such. A heat source's meter is split over the hydronic
  outputs that use it (climate-only by definition). "Running" without `hvac_action`
  is inferred from mode and room vs setpoint, so idling at setpoint isn't running.
- **Did it take effect?** A metered output that says it is heating/cooling, or that
  the brain commanded on with the room still on the wrong side of the setpoint, but
  reads < 50 W for 10 min is flagged unresponsive/idle; one drawing > 200 W while
  off is flagged too. Flags show on Live and as the zone's `Unit problem` entity.
- **No meter:** the configured kW while the unit says it is running.

## Planning (per zone, per tick)

1. Comfort band `[heat, cool]` from preferences (humidity above 70% lowers `cool` by 1 °C).
2. Side: heat or cool, from the room against the band, else the passive drift sign
   (no outdoor reading: the band midpoint; nothing is ever assumed for Tout).
3. Levels, each an offset `sp` from the comfort setpoint (positive = toward ambient,
   exactly the simulator's `sp`):

| Level | Band | Active when |
|---|---|---|
| protect | `protect_min_c`..`protect_max_c` | always |
| setback | comfort widened by `setback_c` (`away_c` when away; +1 °C when the low-case projection is tight) | always |
| comfort | comfort band | occupied now |
| precondition | comfort band | unoccupied, predicted occupied within the model's lead time or due now (nextOccMin 0); latched until arrival + grace (90 min), then suppressed until the pattern moves on; not when away; not long leads when tight |
| soak | toward the far band edge (`soak_c`) | `soak_enabled` (default off), sun now, a need later (forecast min/max outside the band), surplus forecast (low case reaches full) or comfort projected to shed later, and the soak side is the side needed now or the room is in band |

4. kW per level = power to reach the level's setpoint within an hour (precondition:
   by the occupancy time), at least the steady-state holding power near the setpoint,
   capped at the outputs' rating, made non-decreasing protect -> soak.
5. Window/door open (after `window_delay_s`) -> no levels -> off.
6. No room temperature (stale = not reported within 3 h by HA's `last_reported`,
   re-read via get_states every 3 min because `state_reported` can't be subscribed
   without a filter; or unavailable) -> fallback: only protect and setback, handed to the unit's thermostat.
7. The thermal model plans only above 30% confidence; below, the floor-area prior.

## Ladder integration

A new entry type places a zone's level in the list:

    { "type": "climate", "zone": "office", "level": "comfort", "floor": 40, "cond": "autonomy > 1" }

`expand()` rewrites it to a load entry on the zone's device with `kw` (the modelled
power), `vars` (the zone's own `occ` and `gap`, as the simulator gives zone entries),
`cond` (the planner's activation AND the optional user condition), `hkey` (its own
hysteresis key) and `floor`. `decide()` gained four optional, otherwise inert fields:
`kw` (overrides the device's nameplate), `vars` (merged into the entry's context),
`floor` (effective floor = max(rung floor, floor)) and `hkey` (hysteresis remembered
per entry, not per device). The simulator honours `kw`, `vars` and `floor` the same way.

**Placement.** Depth comes from the per-entry floor, not list position, so placement
doesn't depend on which rungs a policy happens to have (with position-only placement,
comfort landed after the 100% rung on the starter policy and became surplus-only):

- `protect` just above the first charge rung, `gen: true`: never shed, a deficit if
  unservable, kept in safe mode;
- `setback`, `comfort`, `precondition` just after the first rung, with floors by
  energy class (comfort class 30/40/60%; essential 0/30/50%; luxury 50/60/none);
- `soak` at the end of the list, floor 100%.

Explicit entries placed after the 100% rung (other than soak/protect) raise a Live
warning.

**Resolve.** The tightest level granted (or already served, or a gen deficit) sets
the band, except that soak can't win on the other side from what the room needs
unless the room is already inside its comfort band. Active levels with none granted
is a hard shed: off. A manual override stands only while the granted level is
comfort or tighter; otherwise the granted band is enforced. With no room temperature
the zone falls back to the unit's own thermostat at the granted (setback/protect)
setpoint, never off.

**Advisory zones** (no outputs) are left out of the real walk; a shadow walk with them
in gives their decision (`shadowKw`), so they never take budget from real loads and
aren't in the projection. A zone that takes over a load but has no outputs leaves that
load's entries as they were.

**Legacy rules:** a zone with `device: "<id>"` and outputs claims that policy device.
Its existing `sp` entries keep working, now with the modelled kW for that `sp`, the
zone's occupancy as `occ` and `gap` = |Tout - comfort setpoint|. The main actuator
doesn't switch a claimed device unless a climate tick fails (`markFailed`), when the
device goes back to it.

**Projection:** `project()` accepts `expand(t, ctx, start)`; climate devices' granted kW
is added to the projected load, and the recorded climate power is subtracted from the
load profile first (older minutes without the figure are left out). The first hour of
predicted occupancy after an unoccupied hour is planned from the setback setpoint, so
recovery energy is included.

## Learning provenance (who changed a setting)

From Home Assistant's state context, in this order:

1. the context id is one of the brain's own service calls, or its `user_id` is the
   brain's (`auth/current_user`) -> **ours**;
2. any other `user_id` -> **human** (a person can set exactly what the brain had);
3. within half a setpoint step of the last command (commands are sent on the unit's
   step, persist across restarts and never expire, so a late echo is still ours, but a
   person's one-step press isn't) -> **ours**;
4. a `parent_id` -> **automation** (reacting to something);
5. otherwise -> **unknown**: a bare context (time/sun-triggered automation, the unit's
   own buttons, IR remote) or no context at all.

Weights: human 1 (1.5 when it changes what the brain set, which also starts an
override hold), unknown 0.3 with no hold, ours/automation 0. Untouched-setting samples
are taken only for human-set settings, live. History replay has no context (the
recorder doesn't keep it), so its changes count as unknown and no untouched samples
are taken: history seeds a weak starting point; occupancy and the thermal model seed
fully. `climate.json` may be deleted before going live to reset learning.

An override that the ladder overrules (comfort not granted) is dropped rather than
resumed later; the person's setting is already in the preferences at 1.5x, so the
brain's own comfort plan leans toward it when comfort returns. Turned off by hand
blocks every level but protect: a freezing room is still heated (`protecting`), and the
person's off stands again once it isn't.

## Actuation

Reconcile every tick: wanted vs actual (each output's reading), resend on mismatch with
a 1/2/5/10/30-min backoff per entity, reset when the want changes, capped at 5 min for
protect; a failed call retries every minute without escalating. A unit held by its
minimum run keeps its own setpoint (no cross-side setpoint is sent). Setpoints rounded to
`target_temp_step` and clamped to `min_temp`/`max_temp`. Dwell is timed from observed
changes (persisted; first sight owes a dwell); heat <-> cool goes through off; dry run
and advise-only zones change nothing. The shared source's state is read from HA; a
manual zone's running valve still keeps it on.

## Robustness

`/data/climate.json` carries `version`; every learner validates its own state (bad
parts are dropped, a newer version starts fresh), an unparseable file is renamed
`.corrupt`; `configure`/`seed` and every tick step are wrapped in main.js so climate
can't stop load shedding.

## Future split: the energy-budget contract

If climate becomes its own add-on, the only contract needed:

- **Brain -> climate:** per tick, a flex budget: for each depth band of the ladder
  (charge-rung floor), the kW available now and, from the low-case projection, the
  hourly kWh available over the next 24 h; plus `surplus_soon` (low case reaches full)
  and the battery SoC/floors for display.
- **Climate -> brain:** per zone, an ordered list of levels `{level, kw, importance,
  active}` for now, and the planned kWh per hour for 24 h (for the projection), with
  how much of it is flexible (the difference between levels).
- **Brain -> climate (result):** the level granted per zone.

`expand()`/`resolve()` and `expandAt()` are exactly that exchange in-process today.
