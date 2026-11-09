# Changelog

## 0.15.0
- New Live page. A timeline at the top shows the last 24 h, recorded by the brain
  itself (one sample a minute, kept across restarts), and the next 24 h, projected
  from the solar forecast, the last day's load and the dispatch list. Click or drag
  it to see any moment; **Replay** plays the last day at 60× until it reaches now.
- Under it, three panels for the moment being viewed: a battery ring with the floors
  and the charge/discharge rate, a load gauge against solar available and the
  inverter's continuous/surge/peak ratings, and the loads running and shed. They
  replace the tiles, the battery bar and the solar arrays card.
- Battery settings gain optional **Surge** and **Peak** kW ratings for the load gauge.
- New `GET /api/timeline`. Series colours follow the validated palette (solar
  blue, battery green, load orange).

## 0.14.0
- Solar forecast: the brain reads the hourly forecasts attached to solar in
  Home Assistant's Energy dashboard (Forecast.Solar, Solcast, ...), summed across
  every plane. No setting needed; add a forecast integration and attach it to
  each solar source.
- `autonomy` now plans for the worse of today's and tomorrow's forecast totals,
  like the simulator's worst-day lookahead; the `forecast` variable uses the next
  24 h. The "Solar forecast today" entity is now an optional override.

## 0.13.0
- Removed Cloudflare Access support: the `cloudflare_access` option and the
  service-token headers on SP PRO bridge requests. The add-on Configuration screen
  now holds only the log level and MQTT.

## 0.12.0
- The add-on Configuration screen now holds only the log level, MQTT and the
  Cloudflare Access token. Everything else is in the web panel's Settings tab.
- The old option fields (kept since 0.9.0 so existing installs could copy them into
  settings.json) are removed. If you're upgrading from before 0.9.0, install 0.11.x
  first so your settings are copied, or re-enter them in Settings.

## 0.11.1
- Settings: **Save settings** sits directly under the settings it saves, above the
  battery, inverter and load cards (each of which has its own Save).
- "Devices" is called **Loads** in the panel. It's still `devices` in policy.json.

## 0.11.0
- **The battery and solar inverters are tiles**, each with a name and an
  **integration** that decides how it's read. Picking one reveals its fields:
  - Battery: SP PRO bridge / Home Assistant (SoC, power, load and energy entity
    pickers) / none. Capacity, reserve, inverter rating and max charge sit on the tile.
  - Inverters: SP PRO bridge (pick which of its inverters) / Fronius direct (IP, poll
    interval) / Home Assistant (power and energy pickers) / none. Each has its own
    AC rating and array kWp. Add inverter / Save inverters / Remove.
- Fronius inverters polled directly replace the old global "Fronius direct polling"
  section. Its hosts become inverter tiles.
- The loose battery SoC, house load and solar power readings move into the battery
  and inverter tiles. Existing settings are converted on first start (the file is
  rewritten once, previous kept as .bak).
- Home Assistant power and energy entities are converted from their own units
  (W/kW, Wh/kWh). A Home Assistant battery-power entity follows HA's sign
  convention (positive = discharging).
- Delivered solar is the sum of the configured inverters when all are reading.

## 0.10.1
- Settings → Solar inverters has its own **Add inverter** and **Save inverters**
  buttons, like Devices; **Save settings** no longer saves the inverter list.
  Inverters the bridge reports keep a fixed key; rows added by hand, or no longer
  reported, can be edited and removed.

## 0.10.0
- **Solar inverters are configured individually.** Each has its own AC rating and
  array kWp (blank = the inverter's own configured PV peak), in a new Settings →
  Solar inverters table that lists the inverters the bridge reports. This replaces
  the single AC rating and kWp override that applied to every inverter. An existing
  single rating becomes one entry per inverter, once.
- An inverter with no AC rating is capped at its kWp rather than a guessed value,
  and the Live view flags it.

## 0.9.0
- **Settings move into the panel.** A new Settings tab edits everything except
  the log level and secrets, and applies it live without a restart: dry run (going
  live asks for confirmation), tick, battery, readings, the SP PRO bridge, the
  Ecowitt gateway, available solar, autonomy and Fronius polling. Readings use
  **entity pickers** that query Home Assistant, filtered to suitable entities.
- **Devices are edited in the panel** (switch and power-sensor pickers, kW, dwell)
  and stored with the dispatch list in policy.json.
- The add-on Configuration screen keeps only the log level, MQTT and the new
  `cloudflare_access` token. Existing options are copied into
  `/config/settings.json` (and device switches into policy.json) on first start.
  The old option fields remain for now so that copy can happen, and will be
  removed in a later release.

## 0.8.2
- Panel: every reading's age ("source · N s old") also ticks every second, not
  just the "updated" time.

## 0.8.1
- Panel: "updated N s ago" ticks every second, so it's obvious the view is live.
- Autonomy is shown in hours: panel tile, log line and the MQTT sensor (now a
  duration in h). Policy conditions still use days, as the simulator does.

## 0.8.0
- **Available solar.** Off grid the battery inverter throttles AC-coupled solar to the
  load once the battery is full, so delivered PV understates the sun. The brain now
  estimates what each array could give from irradiance × array kWp × a factor it
  learns per inverter and half-hour while the arrays are unthrottled. Dispatch spends
  the larger of delivered and available solar.
- New `ecowitt` source: irradiance from an Ecowitt gateway's local API.
- New MQTT entities: irradiance, solar available (total and per array), solar
  headroom, solar curtailed.
- Panel: Solar shows delivered / available; a Solar arrays card shows each array's
  headroom, learned factor and whether it's throttled.
- **Fix:** the Energy dashboard's battery power was inverted. The bridge reports
  positive while charging; Home Assistant wants positive while discharging.

## 0.7.0
- Solar power and energy per inverter on the Energy dashboard, not combined.

## 0.6.0
- Battery power and energy counters (solar, battery in/out, load, generator) for the
  Energy dashboard.

## 0.5.0
- Reads the bridge's `/fast` window (SoC and load every few seconds) for shedding.
  The default tick is 5 s, and the log is quieter.

## 0.4.0
- MQTT connects with configured credentials, or the Mosquitto add-on's own.

## 0.3.0
- Sidebar panel: live dispatch view and policy editor.

## 0.2.0
- SP PRO bridge (splink) as a source for SoC, load and PV.
