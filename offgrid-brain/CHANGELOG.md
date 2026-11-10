# Changelog

## 0.27.0
- **Dwell at charge rungs** replaces 0.26.0's flat "full at" threshold. A rung
  counts as reached once the battery has stayed close enough to it for long enough,
  longer the further below. By default 0.1% below for 60 s, 1% for 120 s and 2% for
  15 min, interpolated between, never past the last step. A dip in the window counts
  at its depth.
  - A reached rung stops holding back solar, and the loads below it may start on the
    battery, so the "charge to 100%" band works even though the battery tapers at
    99.x%.
  - Editable in Settings → Battery; the projection uses the same rule.
- **Charge calibration** (Settings → Battery, "Charges to", default 100%). For when
  wear means the battery only charges to e.g. 95%. The reported SoC is rescaled so
  that reads as 100% throughout (gauges, timeline, rungs, autonomy, MQTT), and the
  usable capacity scales to match.

## 0.26.0
- **Full at** (Settings → Battery, `full_pct`, default 99%). A "charge to 100%"
  step counts as reached from here. Before, a battery tapering at 99.x% kept the
  step "charging" and holding back up to the full charge rate of solar, starving
  the loads below it of surplus the charger wasn't taking. The step's floor is
  unchanged: loads below it still start only on surplus, and with hysteresis, once
  running, may use the battery down to 97%.

## 0.25.0
- **Hysteresis at charge rungs.** A load needs the battery above its entry's floor
  to start drawing on it, but once running it may keep drawing down to the floor
  less `hysteresis_pct` (Settings → Battery, default 3%, never below the reserve).
  A load that came on with a full battery no longer drops out at 99.9% under
  "charge to 100%", or when a cloud passes, only to return a minute later. The
  dispatch list says when a load is being held this way, and the 24 h projection
  applies the same rule.

## 0.24.1
- The minute-by-minute recording no longer counts the minute a restart falls in
  twice (the saved copy and the restarted brain's own). The repeat replaces it, and
  repeats already in the saved file collapse on load. This could add a few extra
  samples to an hourly log row and slightly inflate its kWh.

## 0.24.0
- **Hourly log** for tuning the model: one row an hour in
  `history/hourly-<year>.jsonl` in the add-on's config folder.
  - The solar forecast for the hour as it stood a day, 6 hours and just before.
  - The battery % the brain projected for the hour's end, a day and 6 hours ahead.
  - The actuals: irradiance, outdoor temperature, solar delivered and available,
    load, battery in and out, battery %, minutes throttled.
  - The DC string voltage: mean, peak and first light.

  New `GET /api/history?days=N`.
- Outdoor temperature comes from the Ecowitt gateway when no entity is mapped.
- The bridge's Fronius readings now include the mean DC string voltage.

## 0.23.2
- Energy dashboard: the battery, load and generator counters are the SP PRO's own
  daily counters again, turned into lifetime totals: every rise in the daily
  figure is added, and when it resets at the SP PRO's midnight the new day's figure
  is added plus the part of a step the old day never reported (estimated from live
  power since its last step, at most one step). Live power no longer drives the
  totals, so short-term fluctuations can't drift them, and energy counted while
  the brain was down still arrives with the next reading. The totals carry on from
  0.23.x without a drop.

## 0.23.1
- Energy dashboard: generator energy is metered by the brain too, integrated from
  the SP PRO's generator power, so none of the published energy counters depend on
  the SP PRO's daily counters or its clock any more. Today's SP PRO figures are
  only used to start the meters.

## 0.23.0
- Energy dashboard: battery charged, battery discharged and load energy now come
  from the brain's own lifetime meters, integrated from the live power readings and
  kept in /data across restarts, instead of the SP PRO's daily counters. Those tick
  in ~0.1 kWh steps and reset at the SP PRO's own midnight (an hour off when its
  clock drifts). Home Assistant read the reset as a counter restart and lost the
  hour around it. The meters start from the day's SP PRO figures so the switch-over
  isn't a reset. An `ha` battery keeps using its own entities.

## 0.22.2
- Live: colours follow Home Assistant's Energy dashboard. Solar is orange (one
  shade per inverter, pale for sun available), the battery is teal, discharging
  and supplying the house teal, charging pink, and the house load blue. The
  battery inverter's short-term bands are a neutral blue-grey.

## 0.22.1
- Live: after folding, the timeline's control pill glides up into the header and
  settles just right of "Off-Grid Brain", pushing DRY RUN / LIVE and the version
  along. The compact card is then just the chart. While pinned, the card's title
  is hidden (it was under the header anyway).
- Live: the shed and deficit bars are drawn as one solid bar per run instead of
  one sliver per minute, so they no longer turn stripy mid-transition.

## 0.22.0
- Live: the header compacts along with the pinned timeline (less padding, a smaller
  title and tighter tabs: 61 → 43 px), tied to the scroll like the rest. The page
  below doesn't move.
- Live: the compact timeline is taller, 80 px instead of 64.

## 0.21.4
- Live: the timeline tooltip no longer sticks after scrolling. It hides as soon as
  the page scrolls, and whenever the pointer moves anywhere off the chart.

## 0.21.3
- Live: once folded, the timeline's control pill floats over the compact chart's
  top-left corner. The controls bar's height goes to zero with the scroll and the
  chart slides up underneath, so the compact card is just the chart.

## 0.21.2
- Live: the Loads panel shows the shed count only when something is shed, as it
  already did for held back.

## 0.21.1
- Live: the timeline's own controls now fold into the pill as it shrinks, instead
  of being swapped for a copy. "Replay" slides away to leave ▶, the unselected
  speeds collapse, the selected one rounds into a chip with ▾ (tap it for the
  speed menu once folded), "Back to now" shortens to "now ⟲", and the row's outline
  fades in around them. The time now sits next to the play button.
- Live: the timeline's top-right label reads "15 kW" on one line; the separate
  "kW" and "battery" axis titles are gone, leaving the raw percentages on the left.

## 0.21.0
- Live: as the pinned timeline shrinks, its controls fold into one pill:
  **▶ time · 60× ▾**. The play side plays and pauses, the speed chip opens a small
  menu of 60×, 600× and 900×, and **now ⟲** appears while you're looking at another
  moment. The full row fades out and the pill fades in, tied to the scroll, and the
  bar eases from full height to 26 px so nothing jumps.
- Live: the timeline's side margins are a few pixels wider, and the right one fits
  its widest kW label, so "15 kW" no longer clips.

## 0.20.1
- Live: the timeline card itself now pins and shrinks; the separate pinned copy is
  gone. When its controls reach the header they stay put. As you scroll on, the
  chart redraws shorter (hour labels and the middle grid line fade out, both axes
  keep their end labels), the legend folds away and the card widens to the
  window's edges, all tied to the scroll and reversing exactly as you scroll up.
- Live: the battery and inverter gauges glide to each new reading instead of
  snapping (quicker while you drag the timeline; drawn directly during replay and
  with reduced motion).

## 0.20.0
- **Important and convenience loads.** Loads are important unless marked
  `"important": false` (the new **Important** column in Settings → Loads), and a
  dispatch entry can override its load. Only important loads that can't run count
  as **shed**: red in the Loads panel, on the timeline strip and in MQTT
  `shed_count`. The rest are **held back**: grey, with a new `held_back_count`
  sensor.
- Settings → Loads keeps device fields the table doesn't show (zone settings,
  importance) when you save; before, saving dropped them.
- Live: the compact timeline is tied to the scroll instead of a timed animation.
  It appears as the full chart slides under the header, shrinks as you scroll and
  grows back as you scroll up. It now keeps the battery % and kW axis labels.

## 0.19.0
- Live: the timeline is one chart instead of two stacked bands. Battery % reads on
  the left axis and kW on the right, over the full height, with the solar areas
  behind the floors, the load and the battery line. The compact scrubber matches.

## 0.18.3
- Live: the timeline's kW scale fits the largest load, solar delivered or solar
  available in the recorded and projected day, so available solar is no longer
  clipped at the top (0.18.2 left it out).

## 0.18.2
- Live: the timeline's kW scale fits the day's flows rather than a fixed ceiling;
  small scales label their ticks to two decimals.

## 0.18.1
- Live: the compact timeline takes over earlier, as soon as the full chart's bottom
  edge passes under where the compact one sits. It now animates: the chart shrinks
  from full height to the compact strip, and grows back and fades as you scroll up
  (instant with reduced motion).

## 0.18.0
- Live: replay at **60×, 600× or 900×** (1, 10 or 15 minutes of history a
  second). The panel remembers the choice in your browser.
- Scroll past the timeline and a compact copy, about a quarter of its height, pins
  under the header as a scrubber. It has the same play, speed and Back to now
  controls, and you can click or drag it to pick a moment.

## 0.17.0
- Live: the Inverters gauge is now a **split dial**. Zero is at 12 o'clock. The
  solar inverters fill anticlockwise to their combined AC rating, one shade each,
  over the sun available. The battery inverter fills clockwise through its
  short-term bands to its top rating, supplying or charging. Both arms share one
  square-root scale, so small night loads stay visible and the shorter arm is the
  smaller inverter.

## 0.16.2
- Live: the battery inverter ring no longer marks its top rating; the ring's end is
  the maximum.

## 0.16.1
- Live: the load gauge is now **Inverters**, with one ring per inverter.
  - The outer ring is the battery inverter: what it supplies (load minus solar)
    or the surplus it charges from, against its continuous and short-term ratings.
    AC-coupled, those limits apply to the battery inverter's share, not the whole
    load, so in sunlight the house can draw the sun plus 7.5 kW.
  - Each solar inverter gets its own ring: delivered and available against its AC
    rating.

## 0.16.0
- Battery settings: the fixed **Surge** and **Peak** fields are replaced by a list
  of **short-term ratings** (kW for a duration), so an inverter with several, like
  the SP PRO's 8 kW/60 min, 11.25 kW/30 min, 13 kW/60 s and 18 kW/30 s, can be
  entered in full. Existing surge/peak values are converted automatically.
- The Live load gauge marks every rating, shades the band above continuous darker
  as the allowed time gets shorter, and says how long a load above continuous may
  run.

## 0.15.5
- The timeline's projection includes the battery inverter's own draw, on top of
  the AC load. The brain learns it from its recording: the median of battery
  discharge minus AC load while there's no sun (~40 W on an SP PRO, ~1 kWh a day).
  Overnight drain was under-projected without it. `/api/timeline` reports it as
  `overheadKw`.

## 0.15.4
- Live: "not needed" and "already served" dispatch entries have their own Show/Hide
  buttons.

## 0.15.3
- A charge rung below its target with no solar left to charge from is now shown
  as **below target**, not "charging". "Charging" means it's actually taking power.

## 0.15.2
- Live: "not needed" dispatch entries (condition is 0) are hidden by default too,
  alongside "already served". One button under the list shows both.

## 0.15.1
- Live: dispatch entries that an earlier entry already served are hidden by
  default. A button under the list shows them; entry numbers stay as in the policy.

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
