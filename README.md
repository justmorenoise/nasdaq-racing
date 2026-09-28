# Nasdaq Racing

**What if the Nasdaq were an F1 race?** The top 20 Nasdaq 100 stocks each become a single-seater on a real
circuit, and their change on the day sets their lap time: the best performer leads, and every move in the
market turns into overtakes, late braking and sparks.

**▶ Watch it live: [morenoise.it/en/stuff/nasdaq-racing](https://morenoise.it/en/stuff/nasdaq-racing)**

![Nasdaq Racing](https://morenoise.it/assets/stuff/nasdaq-racing/cover.jpg)

## Features

- **Real prices, real order.** During the US session (09:30–16:00 ET) cars run on live quotes; on-track order
  follows the day's % change, and a close fight in the standings becomes a nose-to-tail battle on track.
- **Demo out of hours.** At night, on weekends and on exchange holidays a demo race runs on simulated prices,
  and the viewer switches back to live by itself at the open.
- **Seven real circuits**: Monza, Monaco, Spa-Francorchamps, Silverstone, Suzuka, Catalunya and Interlagos, with
  their layout, width, pit lane, barriers and surroundings rebuilt from OpenStreetMap and their elevation and
  corner speeds from real F1 telemetry.
- **Low-poly 3D diorama** in Three.js: terrain, run-offs and gravel traps, grandstands, paddock, town and woods,
  soft shadows and ambient occlusion.
- **Cameras**: full view, chase cam and an auto-director that cuts between trackside TV cameras on the best battles.
- **Race radio**: live commentary on overtakes, battles and big moves; leaderboard with price and daily change.
- **Engine sound** synthesised from real F1 recordings, with gear changes, crowd and tyre squeal (off by default).
- Choose your own grid of Nasdaq 100 stocks; the selection is saved and shareable by link.
- Desktop and mobile, Italian and English.

## How it works

A car's lap time is the circuit's base lap time scaled by its daily % change (e.g. base 80 s, +2 % → 78.4 s).
Within a lap each car follows a speed profile built from the circuit's telemetry, so it brakes into corners and
flies down the straights, on a minimum-curvature racing line.

The code is a one-way pipeline, all in the browser:

```
feed (prices) → sim (race model) → render3d (Three.js) + ui (DOM overlay)
```

| Folder       | What's in it                                                                      |
| ------------ | --------------------------------------------------------------------------------- |
| `src/feed`   | `PriceFeed` interface, live `SupabaseFeed`, offline `SimulatedFeed`               |
| `src/sim`    | race model, overtakes, battles, session clock, market calendar                    |
| `src/track`  | circuits, telemetry → speed profile, racing line, gearbox                         |
| `src/render3d` | terrain, track surfaces, trackside, scenery, cars, cameras, post-processing     |
| `src/ui`     | leaderboard, controls, HUD, commentary, minimap                                   |
| `src/audio`  | engine, tyres, crowd                                                              |
| `_risorse`   | asset pipelines: OpenStreetMap processing, Blender model builders, audio source   |
| `supabase`   | live price backend: Edge Function and database setup                             |

Live prices come from a small [Supabase](https://supabase.com) backend: an Edge Function
([`supabase/functions/update-prices`](supabase/functions/update-prices/index.ts)) polls
[Finnhub](https://finnhub.io) every minute and writes a `prices` table the browser follows over Realtime.
The Finnhub key only ever lives server side, as an Edge Function secret, and the function only answers the
scheduled job, which authenticates with a secret kept in the database Vault.
[`supabase/sql/setup.sql`](supabase/sql/setup.sql) sets up the table, the job and that secret on a new project.

## Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:5173. Without Supabase credentials the viewer always runs the demo race.

For live data copy `.env.example` to `.env` and fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

Useful URL parameters:

| Parameter             | Effect                                                   |
| --------------------- | -------------------------------------------------------- |
| `?track=<n>`          | pick a circuit                                           |
| `?feed=demo` / `live` | force demo or live data instead of following market hours |
| `?lang=it` / `en`     | interface language                                       |
| `?symbols=AAPL,MSFT,…` | the stocks on the grid                                  |

`npm run build` type-checks and builds a static site in `dist/` with relative paths, so it can be served
from any folder.

## Credits

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, available under the ODbL.
- Circuit telemetry from [FastF1](https://github.com/theOehrly/Fast-F1).
- Sound sources and their licences: [`public/audio/CREDITS.md`](public/audio/CREDITS.md).

A playful visualisation, not financial advice.

## License

[MIT](LICENSE) © Morenoise
