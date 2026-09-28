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

**feed (data) → sim (model) → render3d (Three.js) + ui (DOM overlay)**

The `main.ts` game loop drives a single `renderer.setAnimationLoop` that advances the sim by `dt` and asks the renderer
to draw. Keep these layers decoupled — the sim must never import from `render3d/` or `ui/`.

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
  with a dev time override (`?at=<ISO>` shifts "now", e.g. to after the close). Tunables in `config.ts` → `pace`.
  Each `Car` also accumulates **session stats**: `timeInP1` (laps led), `overtakes` (on-track positions
  gained, counted in `RaceModel.countOvertakes`) and a decaying `momentum` (recent net % move). The model
  exposes `momentumLeaderSymbol()` (the "fastest lap" / hottest climber, distinct from the cumulative
  leader) and `driverOfTheDay()` (most overtakes). These feed the badges below and a future betting layer.
- **Real layouts (OSM):** circuits with `larghezza_metri` in circuits.json are built from
  `public/osm/<id>.track.json` (`_risorse/osm/track.py`: OSM `type=circuit` lap, oriented and started at the
  timing line by a rigid fit of the Fast-F1 lap, plus the real pit lane and official corners) at a uniform
  `UNITS_PER_METRE` (`track/units.ts`, cars ≈1.35× real) with the real asphalt width; the SVG is only a
  fallback. Telemetry is anchored on the official corners (`TrackDef.corners`), `computeLayout` uses physical
  thresholds (turn radius, metres), `OsmWorld` is an identity at that scale, `TrackMesh` puts run-off depth,
  walls and tyre walls at the real mapped barriers (OSM walls/rails/fences, `bar`), `pitInfo` follows the real
  pit lane. Slot spacing is in car lengths (`pace.baseGapCars`).
- **Rendering performance:** terrain in 64-cell chunks, each at the coarsest step within a height tolerance
  (culling + far fewer triangles; skirts hide cracks; `buildMesh()` once after `prepareGround`);
  `InstanceCuller` packs only in-frustum instances of every big InstancedMesh each frame; `ScenePass` renders
  the scene once (MSAA, own depth) and GTAO reuses that depth at half resolution; composer targets are
  single-sampled; `Stage.adapt` lowers/raises the pixel ratio from the real frame time. `MotionBlurPass`:
  chase-cam camera-motion blur from depth reprojection, masked to zero around the followed car
  (`CONFIG.camera.motionBlur`). Dev: `__game.loadTimes` lists per-stage load times.
- **`render3d/`** — Three.js, low-poly diorama look (refs in `_risorse/ref`). The 2D track plane maps to the
  ground: world (x, y) → Three (x, h, y), Y up (`coords.ts`). **Elevation is real**: `circuits.json`
  `altimetria` (Fast-F1 Z, see the pipeline memory) is placed on the drawn geometry via
  `telemetryDistanceRemap` and stored per sample as `TrackSample.h` / `TrackPose.h` (`Track.heightAt`), ×1.5.
  `Terrain.ts` is a flat-shaded heightfield (heights computed by the pure `terrainField.ts` in a Web Worker,
  `terrainWorker.ts`, so the loading card stays animated; `Terrain.create` falls back to the main thread): pinned just under the track corridor (under the lower pass at
  crossovers), harmonic fill outward, then themed hills/ridges/mountains, rim eased to the horizon skirt; for
  `porto` a sea side is chosen. `heightAt`/`trackDistance`/`paintFaces` serve the other layers.
  `TrackMesh.ts` builds the surfaces via `FlatBatch` (heights per vertex): asphalt with rubbered racing line,
  edge lines, raised kerbs, green verge, gravel/tarmac run-off, start/finish + grid, walls with banners and a
  line-geometry catch fence (lines stay out of the AO pass), bridge parapets/piers, tyre stacks.
  `Kit.ts` loads `public/models/kit.glb` (35 low-poly assets from `_risorse/blender/build_kit.py`, run through
  the Blender MCP; `kit_<name>` roots, `tint*` materials take per-instance colour) and instances them via
  `KitInstancer`. `Scenery3D.ts` (stands with tiers/seat blocks/crowd/roof/flags, pit building + paddock + car
  park, telehandlers, marshal/TV towers, gantries, billboards) and `Environment3D.ts` (tree groves, city blocks
  with painted streets, harbour) share an `Occupancy` grid so nothing overlaps; `pitInfo.ts` has the pit window.
  **OpenStreetMap guide** (`osm.ts`, data in `public/osm/<id>.json` from `_risorse/osm/process.py`, ODbL,
  attribution shown bottom-right): `OsmWorld.load` fits OSM to the drawn circuit (ICP on the `type=circuit`
  relation lap, local residual correction field, outward push off our wider asphalt); `map`/`mapRaw`/`mapBox`
  convert features. With OSM: the sea comes from the real coastline (flood-filled sea mask in `Terrain`), lakes
  are carved, `OsmEnvironment` (2 phases: `prepareGround` terraces the terrain under real roads before the
  trackside is built; `populate` after the stands) places kit houses at real buildings, draped roads with
  pavements/centre lines/zebra crossings/lamps, car parks, woods + mapped trees + theme filler groves away from
  town, harbour boats; `Scenery3D` puts stands at real OSM stands; `TrackMesh` uses real gravel traps when ≥8 are
  mapped. Without OSM data the procedural `Environment3D` is used. `circuits.json` `cittadino: true` (Monaco) =
  street circuit: Armco at the kerb, sidewalks, few tarmac escapes, no elevation exaggeration. All trackside
  dressing (kerb lips, verges/pavements, run-off, barriers, tyre walls) is limited by `TrackMesh.reach`: the
  free room beyond each edge up to the midline toward any other stretch of track and the bend radius on the
  inside, so nothing folds or spills onto a neighbouring pass (Mirabeau). Overpasses get ≥6.5 m headroom
  (`Track.liftOverpasses`). `gallerie` in circuits.json ([from, to] telemetry sector labels) makes tunnels
  (`Track.tunnels`/`inTunnel`): walls, lights, a roof + hotel block that `main.ts` fades while chasing a car
  inside. Driving: `track/racingLine.ts` gives each circuit a minimum-curvature racing line (projected
  Gauss–Seidel, coarse-to-fine, within `Track.hw` less half a car) → `Track.racing`/`racingAt`/`lateralLimits`;
  cars drive it plus `Car.latOff` (critically damped spring, `sim/overtake.ts`: attackers commit to the inside of
  the next corner, defenders only cover from afar then leave a car's width), `RaceModel.poseForCar` heads along
  the actual path, and `RaceModel.separate` resolves oriented-box overlaps (sideways, or the car behind yields).
  `ui/Loader.ts` drives the loading card (markup inline in `index.html`) through the build stages. Dev: `camera.inspect({x,y,h,yaw,pitch,dist})` pins the camera.
  `Stage.ts`: low warm sun with soft shadows following the camera focus, hemisphere fill, GTAO (off on small
  views), AgX tone mapping and a desaturating grade pass. Cars: `CarModel.ts` loads `public/models/car.glb`
  (`_risorse/blender/build_car.py`), merged per material; `CarView3D` tilts the car to the track grade (slope
  group) plus roll/pitch, spins wheels, ground rings, CSS2D label. `SkidMarks3D`/`Sparks3D` follow heights.
  `Camera3D.ts`: full (bisection fit, yaw drift), chase (behind/above, speed-dependent) and tv (trackside cams,
  hard cuts, used by `director()`); heights from the track/terrain. Minimap is a DOM canvas (`ui/Minimap.ts`).
- **`audio/`** — `AudioEngine.ts`: race audio for a *single* focused car (P1 in full view, the chased car
  otherwise). The engine is **one synthesised voice** (coherent across gears/revs) voiced with material from
  real F1 recordings (`_risorse/audio_src/make_engine.py` → `public/audio/engine.json` + `engine_noise.wav`):
  a PeriodicWave oscillator built from a real V8's harmonic spectrum, a sub oscillator, and the recording's
  non-harmonic residue (combustion/exhaust noise) re-pitched with the revs and amplitude-pulsed at the firing
  frequency, through a soft saturator and a low-pass that opens with revs/throttle. Pitch = **revs within the
  current gear** of an 8-speed box with per-circuit shift points (`track.gearBounds`, from telemetry or
  `distribuzione_marce` via `track/gearbox.ts`). Upshift = ignition-cut dip; downshift = one rev blip of the same
  voice per gear dropped; lifting off darkens it with overrun crackles. A second quieter voice plays the nearest
  rival, doppler-shifted. Plus a sampled tyre squeal, the looping crowd (`circuits/crowd.mp3`) opened near the
  grandstands and a team-radio blip on an overtake. Off by default; the 🔊 toggle builds the `AudioContext` on the
  first click. Sample licences in `public/audio/CREDITS.md`.
  A debug `CONFIG.debug.showGear` badge (the **info_view**, stacked between minimap and the Live pill) shows the
  focused car's gear + km/h (`track.speedRangeKmh`) and the telemetry sector name (`track.sectorAt`).
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
- `dt` is **seconds** (animation-loop delta / 1000, capped at 0.05). All motion/easing is dt-based, never per-frame constants.

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
