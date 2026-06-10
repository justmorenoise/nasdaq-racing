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
  (finite differences in `Track.buildSamples`). `speedProfile.ts` builds the local speed profile from
  per-circuit **telemetry** when present (`telemetria` + `lunghezza_metri` in circuits.json →
  `track/telemetry.ts`). The telemetry stations **are** the profile: the real speed at a sequence of points
  around the lap (apices, plus — where the data provides them — the `Staccata`/`Ingresso`/`Frenata`
  braking/approach points that shape each corner). So the profile is a **direct interpolation** of those speeds
  (`telemetryBaseProfile` → `interpCircular`), and `computeSpeedProfile` **skips its accel/brake passes** for
  telemetry circuits (they would pull straights back below their data speed and erase the late braking the data
  encodes). This is why every named station shows its telemetry gear — a slow corner on a long deceleration
  (Monaco's Massenet) and a short straight between corners (the Monaco tunnel) are both reproduced, and gear
  changes are never skipped. The only hard part is *where* each station sits: a circuit SVG is a stylised
  drawing, so its arc-length is **not** a linear function of real track distance (at Monza the first chicane
  sits ~250 m *ahead* of where `distM/lapLength` predicts, the Parabolica ~400 m *behind*). So the corner
  apices (telemetry speed minima) are matched to the geometric corners (curvature peaks) *in lap order*
  (`alignTelemetry` → `monotonicMatch`, a monotonic least-displacement assignment that absorbs the distortion),
  and those matched pairs anchor a piecewise-linear distance→arc remap that places every other station. So the
  profile passes through each station's speed exactly, where the track actually bends. `telemetrySectors` reuses
  the same alignment so `Track.sectorAt` names the stretch a car is in. Denser telemetry = a more faithful
  profile (it's pure interpolation), so adding `Staccata`/approach points to a circuit sharpens its braking.
  Because the passes are skipped for telemetry, `CONFIG.profile.accel`/`brake` now affect **only** the
  non-telemetry curvature path (the hand-made oval). Note the speed→gear map can't resolve a telemetry *speed
  inversion* (Monza: Biassono 310 km/h in 8th vs the Parabolica exit 320 km/h in 7th) — those two read one gear
  off, harmlessly.
  Without telemetry it falls back to **curvature** (`severity = (κ/κ_ref)^corneringExp`,
  `v = vMax−(vMax−vMin)·severity`). Lap time is **not** affected by the profile shape — `RaceModel` scales pace by
  `rawLapTime/baseLapTime`, so the leader always laps in `baseLapTime`; retuning `vMin`/`corneringExp` only
  changes the corner-vs-straight *spread* (higher `vMin`/`corneringExp` = faster, flatter corners, slightly
  slower straights, same lap time). This makes cars slow in corners and fast on straights **without telemetry**.
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
  Each `Car` also accumulates **session stats**: `timeInP1` (laps led), `overtakes` (on-track positions
  gained, counted in `RaceModel.countOvertakes`) and a decaying `momentum` (recent net % move). The model
  exposes `momentumLeaderSymbol()` (the "fastest lap" / hottest climber, distinct from the cumulative
  leader) and `driverOfTheDay()` (most overtakes). These feed the badges below and a future betting layer.
- **`render/`** — Pixi. Cars are textured sprites from `/car/car.svg` (`carSprite.ts`): the `base` body
  path is recolored to the stock's primary color and the `casco` (helmet) to `color2` if set, else a
  stable per-symbol random color; textures are cached per color combo. `CarView` also has a boost aura, a
  gold P1 ring, and an upright ticker label (global on/off toggle in `Controls`). The whole game world
  lives in one container that `Camera.ts` translates/scales.
  Two camera modes with eased transitions: **Full** (fit whole track) and **Chase** (follow one car,
  zoom out on straights / in on corners based on current speed). `Minimap.ts`, `TrackView.ts`, `CarView.ts`.
  `CarView` also draws a purple "fastest lap" ring for the `momentumLeaderSymbol`. `SkidMarks.ts` is a
  persistent rubber-decal layer (between Scenery and the cars): a single world-space `RenderTexture` that
  cars stamp into (`clear:false`) at hard-braking corners, so marks accumulate with bounded memory.
- **`audio/`** — `AudioEngine.ts`: mostly **synthesized** race audio (one sample, `circuits/crowd.mp3`) for a *single* focused
  car (P1 in full view, the chased car otherwise) to avoid 20-engine cacophony — an **8-speed gearbox** where
  the engine pitch tracks *revs within the current gear* (the note saws up toward the redline, then drops on
  each upshift and jumps up on a downshift, so shifts are audible), with a fast multi-gear *scalata* burst
  into corners. The shift points are **per-circuit** (`track.gearBounds`): derived from the circuit's
  `telemetria` (real gear per corner) when present, else from `distribuzione_marce` (gear-usage %) via
  `track/gearbox.ts` — so Monza lives in 7th/8th and Monaco in 2nd–4th, and 1st is never used unless a circuit
  weights it (the hairpin). A debug `CONFIG.debug.showGear` badge (the **info_view**, sized to the minimap,
  stacked between minimap and the Live pill) shows the focused car's gear + km/h (`track.speedRangeKmh`) on the
  first line and the current telemetry sector name (`track.sectorAt`, "(Turn …)" suffix stripped) on a second
  line. Plus a tyre
  screech on corner braking, a
  crowd cheer (`crowd.mp3`) — a looping sample whose gain is **opened while the focused car is within
  `CROWD_WINDOW` of any grandstand** (`Scenery.grandstandDists`), so a row of consecutive stands reads as
  one continuous cheer that only **fades out** (over `CROWD_FADE_OUT`) once past the last stand. Plus a team-radio blip on an overtake.
  Off by default; the 🔊 toggle in `Controls` builds the `AudioContext` on the first click (autoplay policy).
- **`ui/`** — DOM overlays above the canvas (easier to style than canvas text), inside `.ui-overlay`
  (pointer-events pass through except on widgets). `Leaderboard` (live price/Δ/Δ%, ordered by **race
  position** = `model.order` so it matches on-track order; click row → Chase that car), `Controls`
  (Full-view button, auto-director toggle, track `<select>`, label toggle, 🔊 sound toggle, `StockSelector`
  toggle, default top 20). `RaceHud` (status/"Live" pill top-right, chase gap readout bottom, podium — with
  a **Driver of the Day** row). `Commentary.ts` is a "race radio" feed (top-right, under the Live pill):
  rate-limited one-liners from leader changes, battles, overtakes and big % moves, with **clickable yellow
  ticker names** (click → Chase). (`BattleBar.ts` still exists but is no longer mounted — the Live feed
  superseded it.) The P1 car gets a gold label + ring (`CarView`).

- **`data/`** — `nasdaq100.ts` defines the stock universe: `NASDAQ_TOP` (the default top 20, with
  per-symbol display colors/base prices) and `DEFAULT_SYMBOLS`. This is the seed list `main.ts` passes
  to the model, feed and `StockSelector`. `gridState.ts` persists the user's chosen grid to `localStorage`
  and the `?symbols=` URL param (shareable, reload-safe); `loadGridSelection`/`saveGridSelection`.

`config.ts` holds all tunables (% clamp, easing time constants, battle thresholds, zoom range).

## Affiliate / monetization (eToro CTAs)

`affiliate.ts` is the **single boundary** that knows where the "Investi" calls-to-action point — so the
broker program/URL can change via env without touching any UI. It exposes `affiliateUrl(symbol)` (per-stock
deep link), `signupUrl()` (global "open account") and `AFFILIATE_REL` (`"sponsored noopener noreferrer"`).
Links are env-driven: `VITE_AFFILIATE_TEMPLATE` (keep the `{symbol}` placeholder), `VITE_AFFILIATE_SIGNUP`,
`VITE_AFFILIATE_SUBID` (appended for attribution). Defaults point at public eToro pages (untracked).

A master switch `CONFIG.affiliateEnabled` (currently **`false`**) hides *all* of it at once: the leaderboard ↗
buttons, podium "Investi" pills, the global "Apri conto" button, the chase-cam link (`main.ts`) and the
persistent compliance disclaimer. See `.env.example` for the full set of optional env vars (Supabase +
affiliate). The Finnhub key is **never** in the frontend — only the public anon key is.

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
