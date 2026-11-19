# Climate brain: design note

Status: implemented in 0.34.0, advisory only until the house has climate hardware
(dry run never actuates).

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
| `levels.js` | The five comfort levels and their defaults (shared with the simulator). |
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

    dT/dt [°C/h] = a (Tout - T) + bh Ph - bc Pc + g

`Ph`/`Pc` are electrical kW heating/cooling, `a` the envelope loss rate, `bh`/`bc`
the effect of a kW, `g` internal and solar gains. Fit by RLS over 15-minute windows
with a forgetting factor; the prior comes from the zone's floor area (the
simulator's 1.2 W/°C·m² envelope, 0.03 kWh/°C·m² mass, COP 3.5), and variance is capped
at the prior so unexcited directions (cooling in winter) don't wind up. Closed-form
predictions: power to reach a setpoint in `h` hours, time to reach it at a given
power, and how long the room coasts before crossing a limit.

## Learning

- **Preferences.** Every setpoint change on a zone's thermostat that the brain didn't
  command is a manual adjustment: it updates the heat or cool preference for that
  day type (weekday/weekend) and hour, spread over neighbouring hours by a Gaussian
  kernel (sigma 1.5 h), weekends borrowing a little from weekdays. Weights decay
  with a 21-day half-life. A setpoint that is left alone is sampled hourly at a low
  weight. Confidence = 1 - e^(-w/1.5); the effective setpoint blends the configured
  default toward the learned mean by that confidence. While the brain is actuating,
  a change away from what it set is an **override**: learned at 1.5x weight and
  respected for `override_hold_min` (unless the ladder hard-sheds the zone).
- **Occupancy.** Presence comes from any number of occupancy/motion/presence
  entities (the wasp-in-a-box template binary_sensors are the intended source),
  OR'ed. `unavailable`/`unknown` is unknown, never "empty": with every presence
  input unknown the zone falls back to its learned probability. Each hour's
  occupied fraction updates a 168-bin hour-of-week table (28-day half-life), shrunk
  toward a weekday/weekend x hour table, shrunk toward the house schedule.
- **Seeding.** On first start (per zone) the last `learn_days` of HA history for
  the zone's entities and the outdoor temperature are replayed through the same code.

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
- **Shared circuits.** Outputs naming the same meter split its reading over those
  that say they're running, by configured kW (all of them by kW if none says).
  Approximate; documented as such. A heat source's meter is split over the hydronic
  outputs that use it, the same way.
- **Did it take effect?** A metered output that says it is heating/cooling, or that
  the brain commanded on with the room still on the wrong side of the setpoint, but
  reads < 50 W for 10 min is flagged unresponsive/idle; one drawing > 200 W while
  off is flagged too. Flags show on Live and as the zone's `Unit problem` entity.
- **No meter:** the configured kW while the unit says it is running.

## Planning (per zone, per tick)

1. Comfort band `[heat, cool]` from preferences (humidity above 70% lowers `cool` by 1 °C).
2. Side: heat or cool, from the room against the band, else the passive drift sign.
3. Levels, each an offset `sp` from the comfort setpoint (positive = toward ambient,
   exactly the simulator's `sp`):

| Level | Band | Active when |
|---|---|---|
| protect | `protect_min_c`..`protect_max_c` | always |
| setback | comfort widened by `setback_c` (`away_c` when away; +1 °C when the low-case projection is tight) | always |
| comfort | comfort band | occupied now |
| precondition | comfort band | unoccupied, predicted occupied within the model's lead time (not when away; not long leads when tight) |
| soak | toward the far band edge (`soak_c`) | sun now, a need later today (forecast min/max outside the band) and surplus forecast (low case reaches full) or comfort projected to shed later |

4. kW per level = power to reach the level's setpoint within an hour (precondition:
   by the occupancy time), at least the steady-state holding power near the setpoint,
   capped at the outputs' rating, made non-decreasing protect -> soak.
5. Window/door open (after `window_delay_s`) -> no levels -> off.

## Ladder integration

A new entry type places a zone's level in the list:

    { "type": "climate", "zone": "office", "level": "comfort", "cond": "autonomy > 1" }

`expand()` rewrites it to a load entry on the zone's device with `kw` (the modelled
power), `vars` (the zone's own `occ` and `gap`, as the simulator gives zone entries)
and `cond` (the planner's activation AND the optional user condition). `decide()`
gained two inert fields: an entry may carry `kw` (overrides the device's nameplate)
and `vars` (merged into its context). Zones with no entries are placed automatically
by energy class (see DOCS.md). `resolve()` takes the tightest level granted (or
already served) as the zone's band; if levels are active but none granted, the zone
is hard-shed (off).

**Legacy rules:** a zone with `device: "<id>"` claims that policy device. Its existing
`sp` entries keep working, now with the modelled kW for that `sp`, the zone's occupancy
as `occ` and `gap` = |Tout - comfort setpoint|. The main actuator no longer switches a
claimed device; the climate actuator does.

**Projection:** `project()` accepts `expand(t, ctx)`; climate devices' granted kW is
added to the projected load, and the recorded climate power is subtracted from the
load profile first so it isn't counted twice.

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
