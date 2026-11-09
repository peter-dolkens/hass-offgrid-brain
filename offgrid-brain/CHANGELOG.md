# Changelog

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
