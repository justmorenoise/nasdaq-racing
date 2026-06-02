# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Nasdaq Grand Prix** — a playful browser viewer (desktop + mobile) that renders Nasdaq 100 stocks
(default top 20) as top-down F1 cars racing on a circuit. A car's lap time is a track **base lap time**
adjusted by the stock's **daily % change** (e.g. base 80s, stock +2% → 78.4s lap). The race runs over the
US market session (open → close). This is a **v1 prototype driven by simulated price data**; the data layer
is abstracted so a real eToro feed can drop in later (see "Phase 2" below).

## Commands

- `npm run dev` — Vite dev server at http://localhost:5173 (host exposed for mobile testing on LAN).
- `npm run build` — typecheck (`tsc --noEmit`) then production build.
- `npm run typecheck` — types only. There is no test suite or linter configured yet.

## Architecture

Pure front-end. Everything runs in the browser, structured as a one-way pipeline:

**feed (data) → sim (model) → render (Pixi) + ui (DOM overlay)**

The `main.ts` game loop drives a single `app.ticker` that advances the sim by `dt` and asks the renderer
to draw. Keep these layers decoupled — the sim must never import from `render/` or `ui/`.

- **`feed/`** — `PriceFeed` is the abstraction boundary: it emits `PriceUpdate {symbol, changePct, price, ts}`.
  `SimulatedFeed` (mean-reverting random walk) is the v1 implementation. Phase 2 adds an `EtoroFeed` behind
  the same interface; **no other layer should know where prices come from.**
- **`track/`** — A track is a closed centerline polyline → arc-length + per-sample tangent/normal/curvature
  (finite differences in `Track.buildSamples`). `speedProfile.ts` derives local speed from **curvature**
  (`v ∝ 1/√κ`, capped) with a forward/backward pass to bound accel/braking, normalized so a neutral lap ==
  the track's `baseLapTime`. This makes cars slow in corners and fast on straights **without real telemetry**.
  Centerlines come from two sources (`centerline.ts`): **real circuit SVGs** in `/circuits/*.svg` (the first
  `<path>` is the centerline, sampled via `getPointAtLength`, scaled ×3) with base lap times from
  `/circuits/circuits.json`, loaded in `tracks.ts` via `import.meta.glob`; plus a hand-made Catmull-Rom oval.
  Use `buildTrack(id)` to construct. SVG circuits use real names (Monza, Suzuka, …) from the JSON.
- **`sim/`** — The model. Each `Car` holds `progress` (cumulative laps, float) integrated each frame.
  `RaceModel` sets each car's target speed from `targetLapTime = baseLapTime * (1 - clamp(changePct)/100)`
  and **eases current speed toward target** (time-constant smoothing) — this is the "elastic" feel; never
  snap speed to the data. Race order = `progress`. `overtake.ts` handles cosmetic lateral lane changes
  (queue → alongside → pass → return, reversible). `battles.ts` detects duels with **two selectable
  strategies** (A: % performance within ~1%; B: on-track proximity) — both kept for comparison via flags in
  `config.ts`. `RaceClock.ts` maps the US session (09:30–16:00 ET) to pre/running/finished, with a **dev
  override** to accelerate/scrub time for testing outside market hours.
- **`render/`** — Pixi. The whole game world lives in one container that `Camera.ts` translates/scales.
  Two camera modes with eased transitions: **Full** (fit whole track) and **Chase** (follow one car,
  zoom out on straights / in on corners based on current speed). `Minimap.ts`, `TrackView.ts`, `CarView.ts`.
- **`ui/`** — DOM overlays above the canvas (easier to style than canvas text), inside `.ui-overlay`
  (pointer-events pass through except on widgets). `Leaderboard` (live price/Δ/Δ%, ordered by **race
  position** = `model.order` so it matches on-track order; click row → Chase that car), `BattleBar`
  (clickable "Battle X vs Y" chips, bottom-center), `Controls` (Full-view button, auto-director toggle,
  track `<select>`, `StockSelector` toggle, default top 20). `RaceHud` (status pill top-right, chase gap
  readout bottom, podium). The P1 car gets a gold label + ring (`CarView`).

`config.ts` holds all tunables (% clamp, easing time constants, battle thresholds, zoom range).

## Conventions

- TypeScript strict, ES modules, `.ts` extensions in imports allowed (bundler resolution).
- `dt` is **seconds** (`app.ticker.deltaMS / 1000`). All motion/easing is dt-based, never per-frame constants.

## Phase 2 (not in this repo yet)

Real eToro data needs a small **backend** (keys `x-api-key`/`x-user-key` are secret and rate-limited
per-key): it holds one WebSocket subscription (`instrument:<id>`, pushes Bid/Ask/LastExecution) and fans
out to browser clients. Daily % = `(lastExecution − previousClose) / previousClose`; previous close from the
`history/closing-price` endpoint. Resolve ticker→instrumentId once via `market-data/search` and cache.
The only front-end change should be a new `EtoroFeed` implementing `PriceFeed`.
