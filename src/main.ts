import "./style.css";
import { Application, Container } from "pixi.js";
import { buildTrack, TRACKS, resolveTrackParam, trackParamFor } from "./track/tracks";
import { computeLayout } from "./track/corners";
import { TrackView } from "./render/TrackView";
import { loadGrassBackground } from "./render/textures";
import { Scenery } from "./render/Scenery";
import { CarView } from "./render/CarView";
import { SkidMarks } from "./render/SkidMarks";
import { SparksLayer } from "./render/SparksLayer";
import { Camera } from "./render/Camera";
import { Minimap } from "./render/Minimap";
import { RaceModel } from "./sim/RaceModel";
import { SimulatedFeed } from "./feed/SimulatedFeed";
import { SupabaseFeed } from "./feed/SupabaseFeed";
import type { PriceFeed } from "./feed/PriceFeed";
import { DEFAULT_SYMBOLS } from "./data/nasdaq100";
import { loadGridSelection, saveGridSelection } from "./data/gridState";
import { Leaderboard } from "./ui/Leaderboard";
import { Controls } from "./ui/Controls";
import { resolveLang, t } from "./i18n";
import { StockSelector } from "./ui/StockSelector";
import { Commentary } from "./ui/Commentary";
import { detectBattles } from "./sim/battles";
import { RaceClock } from "./sim/RaceClock";
import { RaceHud } from "./ui/RaceHud";
import { AudioEngine } from "./audio/AudioEngine";
import { gearAtSpeed } from "./track/gearbox";
import { CONFIG } from "./config";
import { affiliateUrl, affiliateEnabled, AFFILIATE_REL } from "./affiliate";

async function boot() {
  const host = document.getElementById("app")!;

  // The canvas + DOM overlay live in a stage wrapper. On desktop it fills the
  // screen; on mobile it becomes a fixed, collapsing header (see applyLayout)
  // so the leaderboard can scroll below it. The renderer tracks the wrapper.
  const stageWrap = document.createElement("div");
  stageWrap.className = "stage-wrap";
  host.appendChild(stageWrap);

  const app = new Application();
  await app.init({
    background: "#0a0e14",
    resizeTo: stageWrap,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
  });
  stageWrap.appendChild(app.canvas);

  const params = new URLSearchParams(location.search);
  // La lingua dell'interfaccia: `?lang=` la passa l'iframe di morenoise.it.
  resolveLang(params);
  // Dev-only time acceleration: ?speed=10 makes a lap take 1/10th the time.
  const timeScale = Math.max(1, Number(params.get("speed")) || 1);
  // ?demo=N runs a compressed N-second session that ends with a podium.
  const demoSeconds = params.has("demo") ? Number(params.get("demo")) || 120 : null;

  // Feed selection: real data (Supabase) is the default when configured;
  // ?feed=demo forces the offline simulated feed (also the fallback when the
  // Supabase env vars are missing).
  const supaUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const supaKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  const wantDemo = params.get("feed") === "demo";
  const useSupabase = !wantDemo && !!supaUrl && !!supaKey;

  // Offline/demo runs the race endlessly so it can be shown at any hour without
  // hitting the US market close; an explicit ?demo=N still ends with a podium.
  const clock = new RaceClock(demoSeconds, !useSupabase && demoSeconds == null);
  // ?track= is a numeric index into TRACKS (slug/id still accepted for old links).
  const trackId = resolveTrackParam(params.get("track"));
  // The starting grid is shareable/persisted (?symbols= + localStorage); falls
  // back to the default top 20 when there's no saved or shared selection.
  const initialSymbols = loadGridSelection(params) ?? [...DEFAULT_SYMBOLS];

  const world = new Container();
  app.stage.addChild(world);

  const track = await buildTrack(trackId);
  await loadGrassBackground();
  const layout = computeLayout(track);
  world.addChild(new TrackView(track, layout).container);
  const scenery = new Scenery(track, layout);
  world.addChild(scenery.container);

  // Rubber marks accumulate under the cars at hard-braking corners.
  const skid = new SkidMarks(track, app.renderer);
  world.addChild(skid.container);

  const carLayer = new Container();
  world.addChild(carLayer);
  // Sparks fly up from car-to-car contact, above the bodies.
  const sparks = new SparksLayer();
  world.addChild(sparks.container);
  // Crane jibs overhang the track, so they sit above the cars, marks and sparks.
  world.addChild(scenery.cranesLayer);
  // Labels render above everything so names are never occluded in a pack.
  const labelLayer = new Container();
  world.addChild(labelLayer);

  const model = new RaceModel(track, initialSymbols);
  const camera = new Camera(world, track, model, app.screen);

  let directorOn = false;
  // Picking a car (on track or in the standings) is the user taking manual
  // control, so the auto-director must step aside.
  const followManually = (sym: string) => {
    if (directorOn) {
      directorOn = false;
      controls.setDirector(false);
    }
    camera.toggleFollow(sym);
  };

  const carViews = new Map<string, CarView>();
  const syncCarViews = () => {
    for (const [sym, car] of model.cars) {
      if (carViews.has(sym)) continue;
      const view = new CarView(car, labelLayer, track.def.scale ?? 1);
      view.root.eventMode = "static";
      view.root.cursor = "pointer";
      view.root.on("pointertap", () => followManually(sym));
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

  const feed: PriceFeed = useSupabase
    ? new SupabaseFeed(supaUrl!, supaKey!)
    : new SimulatedFeed();
  feed.onUpdate((updates) => model.applyUpdates(updates));
  feed.start(initialSymbols);

  // Late-join: if the session is already underway, seed the field's positions.
  const startSample = clock.sample();
  if (startSample.state === "running") {
    model.seedFromFraction(startSample.fraction, startSample.total);
  }

  // --- UI overlay (DOM) ---
  const overlay = document.createElement("div");
  overlay.className = "ui-overlay";
  stageWrap.appendChild(overlay);

  let activeSymbols = [...initialSymbols];
  const leaderboard = new Leaderboard((sym) => followManually(sym));
  const selector = new StockSelector(activeSymbols, (syms) => {
    activeSymbols = syms;
    saveGridSelection(syms);
    model.setSymbols(syms);
    feed.start(syms);
    syncCarViews();
  });
  let labelsOn = true;
  const audio = new AudioEngine();
  const controls = new Controls({
    onFullView: () => {
      directorOn = false;
      controls.setDirector(false);
      camera.showFull();
    },
    onToggleSelector: () => selector.toggle(),
    onToggleDirector: (on) => {
      directorOn = on;
    },
    onToggleLabels: (on) => {
      labelsOn = on;
    },
    labelsOn,
    onToggleSound: () => audio.toggle(),
    tracks: TRACKS.map((t) => ({ id: t.id, name: t.name })),
    currentTrack: trackId,
    onTrackChange: (id) => {
      params.set("track", trackParamFor(id));
      location.search = params.toString();
    },
  });
  const commentary = new Commentary((sym) => followManually(sym));
  const raceHud = new RaceHud(track.length, (sym) => camera.follow(sym));
  // Debug-only gear readout for the focused car (hidden unless CONFIG.debug.showGear).
  const gearHud = document.createElement("div");
  gearHud.className = "gear-debug hidden";
  // Leaderboard placement is layout-dependent (see applyLayout below): an
  // absolute overlay panel on desktop, an in-flow block under the circuit on
  // mobile, so the rest goes in the overlay here.
  overlay.append(
    controls.el,
    commentary.el,
    selector.el,
    raceHud.status,
    raceHud.chaseInfo,
    raceHud.podium,
  );
  if (CONFIG.debug.showGear) overlay.append(gearHud);

  // Persistent compliance note for the sponsored affiliate CTAs.
  if (affiliateEnabled) {
    const disclaimer = document.createElement("div");
    disclaimer.className = "disclaimer";
    disclaimer.textContent = t("disclaimer.affiliate");
    overlay.append(disclaimer);
  }

  // --- Mobile layout: circuit as a collapsing sticky header + scrollable board.
  // On phones the page scrolls. The stage is fixed at the top and shrinks from
  // its initial tall size to 33vh as the user scrolls, then stays pinned; the
  // leaderboard sits in normal flow below it (full width, all positions). At
  // rest the stage is tall enough to leave only the top ~3 rows peeking.
  const mq = window.matchMedia("(max-width: 640px)");
  const STAGE_MIN_FRAC = 0.33;
  const spacer = document.createElement("div");
  spacer.className = "stage-spacer";
  // True once the mobile circuit is shrunk to its minimum: we then declutter it
  // (hide car labels and the floating chips) so it reads as a clean thumbnail.
  let stageCollapsed = false;

  // Height of the leaderboard header + first three rows, so the resting stage
  // height can leave exactly that much peeking at the bottom.
  const peekHeight = (): number => {
    const header = leaderboard.el.querySelector(".lb-toggle") as HTMLElement | null;
    const rows = leaderboard.el.querySelectorAll<HTMLElement>(".lb-row");
    let h = header?.offsetHeight ?? 32;
    for (let i = 0; i < Math.min(3, rows.length); i++) h += rows[i].offsetHeight;
    return h + 12;
  };

  const updateStage = () => {
    if (!mq.matches) return;
    const vh = window.innerHeight;
    const hMin = Math.round(vh * STAGE_MIN_FRAC);
    // Constant reserved space so the document height is stable while scrolling;
    // keep the resting circuit at least 45vh tall even on short viewports.
    const h0 = Math.max(Math.round(vh * 0.45), vh - peekHeight());
    spacer.style.height = `${h0}px`;
    const h = Math.max(hMin, h0 - host.scrollTop);
    if (Math.round(stageWrap.clientHeight) !== h) {
      stageWrap.style.height = `${h}px`;
      // Resize the renderer now rather than waiting for Pixi's rAF-based
      // ResizeObserver, so the circuit reframes in lock-step with the scroll.
      app.resize();
    }
    const collapsed = h <= hMin + 2;
    if (collapsed !== stageCollapsed) {
      stageCollapsed = collapsed;
      stageWrap.classList.toggle("stage-collapsed", collapsed);
    }
    // "Full" only at the resting height: the battle bar shows just here and
    // disappears the moment the circuit starts shrinking.
    stageWrap.classList.toggle("stage-full", h >= h0 - 2);
  };

  const applyLayout = () => {
    if (mq.matches) {
      leaderboard.el.classList.add("mobile-board");
      leaderboard.el.classList.remove("collapsed");
      if (spacer.parentElement !== host) host.appendChild(spacer);
      if (leaderboard.el.parentElement !== host) host.appendChild(leaderboard.el);
      host.scrollTop = 0;
      updateStage();
    } else {
      leaderboard.el.classList.remove("mobile-board");
      spacer.remove();
      if (leaderboard.el.parentElement !== overlay) overlay.appendChild(leaderboard.el);
      stageWrap.style.height = "";
      stageCollapsed = false;
      stageWrap.classList.remove("stage-collapsed", "stage-full");
    }
  };
  applyLayout();
  mq.addEventListener("change", applyLayout);
  host.addEventListener("scroll", updateStage, { passive: true });
  window.addEventListener("resize", updateStage);

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
  const frame = (dt: number) => {
    const clk = clock.sample();
    if (clk.state === "running") {
      model.update(dt * timeScale);
      skid.update(model.cars.values(), (c) => model.poseForCar(c));
      sparks.emit(model.contacts, (c) => model.poseForCar(c), dt);
    } else if (clk.state === "finished") {
      raceHud.showPodium(model.order, model.driverOfTheDay());
    }
    // Always advance sparks so any in-flight particles finish their arc.
    sparks.update(dt);

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
    // "Fastest lap" holder — the car climbing hardest right now (may be none).
    const momentumSym = model.momentumLeaderSymbol();

    // Audio tracks one car: the chased car if any, else P1. Silent unless racing.
    const focusSym = camera.followedSymbol ?? leaderSym;
    const focusCar =
      clk.state === "running" && focusSym ? model.cars.get(focusSym) ?? null : null;
    audio.update(focusCar, track, scenery.grandstandDists);

    if (CONFIG.debug.showGear) {
      if (focusCar) {
        const gear = gearAtSpeed(focusCar.relSpeed, track.gearBounds);
        const [kmhMin, kmhMax] = track.speedRangeKmh;
        const { vMin, vMax } = CONFIG.profile;
        const kmh = Math.round(
          kmhMin + ((focusCar.relSpeed - vMin) / (vMax - vMin)) * (kmhMax - kmhMin),
        );
        // Drop the redundant "(Turn 1-2)" suffix — the corner is on screen.
        const sector = track.sectorAt(focusCar.progress).replace(/\s*\(.*\)\s*$/, "");
        gearHud.innerHTML =
          `<div class="gear-debug-main">${focusCar.symbol} · ${gear}ª · ${kmh} km/h</div>` +
          (sector ? `<div class="gear-debug-sector">${sector}</div>` : "");
        gearHud.classList.remove("hidden");
      } else {
        gearHud.classList.add("hidden");
      }
    }
    // Labels follow the global toggle, but are suppressed on the shrunken mobile
    // thumbnail where they'd be oversized and overlap.
    const showLabels = labelsOn && !stageCollapsed;
    // Shrink the P1 ring on the reduced mobile circuit so it doesn't dominate.
    const ringScale = stageCollapsed ? 0.5 : 1;
    for (const [sym, car] of model.cars) {
      // Labels follow the global toggle (rendered in a top layer so names in a
      // pack never hide behind another car).
      carViews
        .get(sym)
        ?.update(
          model.poseForCar(car),
          labelScale,
          showLabels,
          sym === leaderSym,
          ringScale,
          sym === momentumSym,
        );
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
      // Keep the mobile circuit's resting height in sync with the row heights.
      updateStage();
      const battles = detectBattles(model.cars.values(), track);
      if (clk.state === "running") commentary.update(byPct, model.order, battles);
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
          : t("hud.leading");
        const investLink = affiliateEnabled
          ? ` · <a class="chase-invest" href="${affiliateUrl(car.symbol)}" target="_blank" rel="${AFFILIATE_REL}">${t("hud.investShort")}</a>`
          : "";
        raceHud.setChaseInfo(
          `<b>P${pos + 1}</b> ${car.symbol} · ${t("hud.fromLeader")} <b>${toLeader}</b> · ${toAhead}` +
            investLink,
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
    scenery,
    app,
    frame,
    render: () => app.renderer.render(app.stage),
  };
}

boot();
