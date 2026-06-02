import "./style.css";
import { Application, Container } from "pixi.js";
import { buildTrack, DEFAULT_TRACK_ID, TRACKS } from "./track/tracks";
import { computeLayout } from "./track/corners";
import { TrackView } from "./render/TrackView";
import { Scenery } from "./render/Scenery";
import { CarView } from "./render/CarView";
import { Camera } from "./render/Camera";
import { Minimap } from "./render/Minimap";
import { RaceModel } from "./sim/RaceModel";
import { SimulatedFeed } from "./feed/SimulatedFeed";
import { SupabaseFeed } from "./feed/SupabaseFeed";
import type { PriceFeed } from "./feed/PriceFeed";
import { DEFAULT_SYMBOLS } from "./data/nasdaq100";
import { Leaderboard } from "./ui/Leaderboard";
import { Controls } from "./ui/Controls";
import { StockSelector } from "./ui/StockSelector";
import { BattleBar } from "./ui/BattleBar";
import { detectBattles } from "./sim/battles";
import { RaceClock } from "./sim/RaceClock";
import { RaceHud } from "./ui/RaceHud";

async function boot() {
  const host = document.getElementById("app")!;

  const app = new Application();
  await app.init({
    background: "#0a0e14",
    resizeTo: host,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
  });
  host.appendChild(app.canvas);

  const params = new URLSearchParams(location.search);
  // Dev-only time acceleration: ?speed=10 makes a lap take 1/10th the time.
  const timeScale = Math.max(1, Number(params.get("speed")) || 1);
  // ?demo=N runs a compressed N-second session; otherwise the real US session.
  const demoSeconds = params.has("demo") ? Number(params.get("demo")) || 120 : null;
  const clock = new RaceClock(demoSeconds);
  const trackId = params.get("track") || DEFAULT_TRACK_ID;

  const world = new Container();
  app.stage.addChild(world);

  const track = buildTrack(trackId);
  const layout = computeLayout(track);
  world.addChild(new TrackView(track, layout).container);
  world.addChild(new Scenery(track, layout).container);

  const carLayer = new Container();
  world.addChild(carLayer);
  // Labels render above all car bodies so names are never occluded in a pack.
  const labelLayer = new Container();
  world.addChild(labelLayer);

  const model = new RaceModel(track, DEFAULT_SYMBOLS);
  const camera = new Camera(world, track, model, app.screen);

  const carViews = new Map<string, CarView>();
  const syncCarViews = () => {
    for (const [sym, car] of model.cars) {
      if (carViews.has(sym)) continue;
      const view = new CarView(car, labelLayer);
      view.root.eventMode = "static";
      view.root.cursor = "pointer";
      view.root.on("pointertap", () => camera.toggleFollow(sym));
      carViews.set(sym, view);
      carLayer.addChild(view.root);
    }
    for (const [sym, view] of carViews) {
      if (model.cars.has(sym)) continue;
      view.destroy();
      carViews.delete(sym);
    }
  };
  syncCarViews();

  const minimap = new Minimap(track, model);
  app.stage.addChild(minimap.container);
  minimap.layout(app.screen.width);

  // Feed selection: real data (Supabase) is the default when configured;
  // ?feed=demo forces the offline simulated feed. (Falls back to simulated if
  // Supabase env vars are missing.)
  const supaUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const supaKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  const wantDemo = params.get("feed") === "demo";
  const useSupabase = !wantDemo && !!supaUrl && !!supaKey;
  const feed: PriceFeed = useSupabase
    ? new SupabaseFeed(supaUrl!, supaKey!)
    : new SimulatedFeed();
  feed.onUpdate((updates) => model.applyUpdates(updates));
  feed.start(DEFAULT_SYMBOLS);

  // Late-join: if the session is already underway, seed the field's positions.
  const startSample = clock.sample();
  if (startSample.state === "running") {
    model.seedFromFraction(startSample.fraction, startSample.total);
  }

  // --- UI overlay (DOM) ---
  const overlay = document.createElement("div");
  overlay.className = "ui-overlay";
  host.appendChild(overlay);

  let activeSymbols = [...DEFAULT_SYMBOLS];
  const leaderboard = new Leaderboard((sym) => camera.toggleFollow(sym));
  const selector = new StockSelector(activeSymbols, (syms) => {
    activeSymbols = syms;
    model.setSymbols(syms);
    feed.start(syms);
    syncCarViews();
  });
  let directorOn = false;
  let labelsOn = true;
  const controls = new Controls({
    onFullView: () => {
      directorOn = false;
      camera.showFull();
    },
    onToggleSelector: () => selector.toggle(),
    onToggleDirector: () => {
      directorOn = !directorOn;
    },
    onToggleLabels: (on) => {
      labelsOn = on;
    },
    labelsOn,
    tracks: TRACKS.map((t) => ({ id: t.id, name: t.name })),
    currentTrack: trackId,
    onTrackChange: (id) => {
      params.set("track", id);
      location.search = params.toString();
    },
  });
  const battleBar = new BattleBar((sym) => camera.follow(sym));
  const raceHud = new RaceHud(track.length, (sym) => camera.follow(sym));
  overlay.append(
    controls.el,
    battleBar.el,
    leaderboard.el,
    selector.el,
    raceHud.status,
    raceHud.chaseInfo,
    raceHud.podium,
  );

  app.renderer.on("resize", () => {
    camera.resize();
    minimap.layout(app.screen.width);
  });

  // Keyboard: Esc / F returns to the full view.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.key.toLowerCase() === "f") camera.showFull();
  });

  const gapSeconds = (distAhead: number) =>
    (distAhead * track.def.baseLapTime) / track.length;

  let uiAccum = 0;
  let directorAccum = 0;
  let battleSymbols = new Set<string>();
  const frame = (dt: number) => {
    const clk = clock.sample();
    if (clk.state === "running") model.update(dt * timeScale);
    else if (clk.state === "finished") raceHud.showPodium(model.order);

    // Auto-director: every few seconds, cut to the hottest battle (or leader).
    if (directorOn) {
      directorAccum += dt;
      if (directorAccum >= 5 || camera.currentMode === "full") {
        directorAccum = 0;
        const battles = detectBattles(model.cars.values(), track);
        const target = battles[0]?.lead ?? model.order[0]?.symbol;
        if (target) camera.follow(target);
      }
    }

    camera.update(dt);

    const labelScale = 1 / camera.scale;
    // P1 = best performer by % (top of the standings).
    let leaderSym: string | undefined;
    let bestPct = -Infinity;
    for (const car of model.cars.values()) {
      if (car.changePct > bestPct) {
        bestPct = car.changePct;
        leaderSym = car.symbol;
      }
    }
    // Declutter: in full view label only the leader + cars in a battle; in
    // chase view (few cars on screen) label everyone.
    const inChase = camera.currentMode === "chase";
    for (const [sym, car] of model.cars) {
      // Boost glow decays in real time (independent of sim time-scale).
      if (car.boost > 0) car.boost = Math.max(0, car.boost - dt * 1.1);
      const showLabel =
        labelsOn && (inChase || sym === leaderSym || battleSymbols.has(sym));
      carViews
        .get(sym)
        ?.update(model.poseForCar(car), labelScale, showLabel, sym === leaderSym);
    }
    minimap.update(camera.followedSymbol);

    // Throttle DOM updates (~7/s) to avoid layout thrash.
    uiAccum += dt;
    if (uiAccum >= 0.15) {
      uiAccum = 0;
      // Standings ordered by best % of the day (best on top). The leader-relative
      // pace model makes on-track order converge to this, with live overtakes.
      const byPct = [...model.cars.values()].sort(
        (a, b) => b.changePct - a.changePct,
      );
      leaderboard.update(byPct, camera.followedSymbol);
      const battles = detectBattles(model.cars.values(), track);
      battleBar.update(battles);
      battleSymbols = new Set(battles.flatMap((b) => b.symbols));
      raceHud.setStatus(clk);

      // Broadcast gap readout for the chased car.
      const followed = camera.followedSymbol;
      const car = followed ? model.cars.get(followed) : null;
      if (car) {
        const pos = model.order.indexOf(car);
        const leader = model.order[0];
        const ahead = pos > 0 ? model.order[pos - 1] : null;
        const toLeader =
          pos > 0 ? `+${gapSeconds(leader.progress - car.progress).toFixed(1)}s` : "—";
        const toAhead = ahead
          ? `+${gapSeconds(ahead.progress - car.progress).toFixed(1)}s ${ahead.symbol}`
          : "in testa";
        raceHud.setChaseInfo(
          `<b>P${pos + 1}</b> ${car.symbol} · dal leader <b>${toLeader}</b> · ${toAhead}`,
        );
      } else {
        raceHud.setChaseInfo(null);
      }
    }
  };

  app.ticker.add(() => frame(Math.min(app.ticker.deltaMS / 1000, 0.05)));

  // Dev inspection hook (also lets the preview drive frames while the page is
  // hidden, since requestAnimationFrame is throttled there).
  (window as unknown as { __game: unknown }).__game = {
    model,
    camera,
    track,
    app,
    frame,
    render: () => app.renderer.render(app.stage),
  };
}

boot();
