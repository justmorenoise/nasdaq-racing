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
  `SupabaseFeed` is the **real-data** adapter (snapshot `select` + Realtime `postgres_changes` on the
  `prices` table) and is the **default** when `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` are set;
  `?feed=demo` forces the offline `SimulatedFeed` (mean-reverting random walk). **No other layer knows
  where prices come from.**
- **`track/`** — A track is a closed centerline polyline → arc-length + per-sample tangent/normal/curvature
  (finite differences in `Track.buildSamples`). `speedProfile.ts` derives local speed from **curvature**
  (`v ∝ 1/√κ`, capped) with a forward/backward pass to bound accel/braking, normalized so a neutral lap ==
  the track's `baseLapTime`. This makes cars slow in corners and fast on straights **without real telemetry**.
  Centerlines come from two sources (`centerline.ts`): **real circuit SVGs** in `/circuits/*.svg` (the first
  `<path>` is the centerline, sampled via `getPointAtLength`, scaled ×3) with base lap times from
  `/circuits/circuits.json`, loaded in `tracks.ts` via `import.meta.glob`; plus a hand-made Catmull-Rom oval.
  Use `buildTrack(id)` to construct. SVG circuits use real names (Monza, Suzuka, …) from the JSON.
- **`sim/`** — The model. **On-track order reflects the standings (by % change).** `RaceModel.update`
  sorts cars by clamped `changePct`, then assigns each a `targetProgress` slot behind the standings leader:
  `gap += L*(baseGapFrac + gapPerPctFrac*ΔPct)` (a readable base spacing + a bonus for the % gap, so tight
  clusters look like nose-to-tail battles). A proportional controller nudges each car's pace toward its slot
  (`adjust = clamp(1 + gain*posError/L)`) **while still using the corner speed profile** (`relSpeed`), so
  cars brake in corners and overtakes animate smoothly when % change. The standings leader runs ~`baseLapTime`.
  Cars snap into their slot on the first frame that has real data (`seeded`). Race order = `progress`, which
  tracks the standings. `overtake.ts` adds cosmetic lateral lane changes; `battles.ts` detects duels (two
  strategies in `config.ts`); `RaceClock.ts` maps the US session (09:30–16:00 ET) to pre/running/finished
  with a dev time override. Tunables in `config.ts` → `pace`.
- **`render/`** — Pixi. Cars are textured sprites from `/car/car.svg` (`carSprite.ts`): the `base` body
  path is recolored to the stock's primary color and the `casco` (helmet) to `color2` if set, else a
  stable per-symbol random color; textures are cached per color combo. `CarView` also has a boost aura, a
  gold P1 ring, and an upright ticker label (global on/off toggle in `Controls`). The whole game world
  lives in one container that `Camera.ts` translates/scales.
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

## Real-data backend (Supabase + Finnhub)

Implemented with **Supabase** (project ref `nikpcgoswyjylqrusunr`, `nasdaq-grand-prix`):
- Table `public.prices (symbol pk, price, change_pct, ts)`, RLS public-read, in the `supabase_realtime`
  publication (replica identity full).
- Edge Function `update-prices` (Deno): reads the **`FINNHUB_API_KEY` secret**, calls Finnhub
  `/quote?symbol=X` per symbol (uses `dp` for daily %, `c` for price), upserts `prices`. **Without the key
  it writes a smooth simulated fallback** so the pipeline works for testing.
- `pg_cron` job `update-prices-every-minute` invokes the function each minute via `pg_net` (Bearer = anon key).
- The Finnhub key lives **only** as an Edge Function secret — never in the frontend. The browser uses the
  public anon key. To go live: set the `FINNHUB_API_KEY` secret on the function (Dashboard → Edge Functions
  → secrets), no code change needed.

Cadence is ~1 min (cron); the sim eases between updates so motion stays smooth. For true sub-second data a
separate always-on worker holding a Finnhub WebSocket could push to Realtime instead — not needed here.
(The earlier eToro plan in `feed/` notes still applies as an alternative provider behind `PriceFeed`.)
