import { Container } from "pixi.js";
import { CONFIG } from "../config";
import type { RaceModel } from "../sim/RaceModel";
import type { Track } from "../track/Track";

type Screen = { width: number; height: number };

type Mode = { kind: "full" } | { kind: "chase"; symbol: string };

/**
 * Drives the world container transform. Two modes:
 *  - full: fit the whole track in view.
 *  - chase: follow one car, with zoom that pulls out on fast sections and tucks
 *    in through slow corners. Center and zoom ease toward target for smoothness.
 */
export class Camera {
  private mode: Mode = { kind: "full" };
  private cx = 0;
  private cy = 0;
  private zoom = 1;
  private targetCx = 0;
  private targetCy = 0;
  private targetZoom = 1;

  constructor(
    private world: Container,
    private track: Track,
    private model: RaceModel,
    private screen: Screen,
  ) {
    this.computeFull();
    // Snap to initial full view (no animated intro).
    this.cx = this.targetCx;
    this.cy = this.targetCy;
    this.zoom = this.targetZoom;
    this.apply();
  }

  get currentMode(): "full" | "chase" {
    return this.mode.kind;
  }

  get followedSymbol(): string | null {
    return this.mode.kind === "chase" ? this.mode.symbol : null;
  }

  showFull(): void {
    this.mode = { kind: "full" };
  }

  follow(symbol: string): void {
    this.mode = { kind: "chase", symbol };
  }

  /** Toggle chase off if already following this symbol, else follow it. */
  toggleFollow(symbol: string): void {
    if (this.mode.kind === "chase" && this.mode.symbol === symbol) {
      this.showFull();
    } else {
      this.follow(symbol);
    }
  }

  resize(): void {
    if (this.mode.kind === "full") this.computeFull();
  }

  private computeFull(): void {
    const b = this.track.bounds;
    const pad = CONFIG.camera.fullPadding;
    const tw = b.maxX - b.minX;
    const th = b.maxY - b.minY;
    this.targetZoom = Math.min(
      (this.screen.width * (1 - pad * 2)) / tw,
      (this.screen.height * (1 - pad * 2)) / th,
    );
    this.targetCx = (b.minX + b.maxX) / 2;
    this.targetCy = (b.minY + b.maxY) / 2;
  }

  private computeChase(symbol: string): void {
    const car = this.model.cars.get(symbol);
    if (!car) {
      this.showFull();
      this.computeFull();
      return;
    }
    const pose = this.model.poseForCar(car);
    this.targetCx = pose.x;
    this.targetCy = pose.y;

    const { vMin, vMax } = CONFIG.profile;
    const rel = car.worldSpeed / Math.max(car.speedScalar, 1e-6);
    const norm = Math.min(1, Math.max(0, (rel - vMin) / (vMax - vMin)));
    const { chaseZoom, chaseZoomSpeedSpread } = CONFIG.camera;
    this.targetZoom = chaseZoom * (1 - chaseZoomSpeedSpread * norm);
  }

  update(dt: number): void {
    if (this.mode.kind === "chase") this.computeChase(this.mode.symbol);
    else this.computeFull();

    const e = 1 - Math.exp(-CONFIG.camera.transitionRate * dt);
    this.cx += (this.targetCx - this.cx) * e;
    this.cy += (this.targetCy - this.cy) * e;
    this.zoom += (this.targetZoom - this.zoom) * e;
    this.apply();
  }

  /** Current world->screen scale, for sizing screen-constant overlays. */
  get scale(): number {
    return this.zoom;
  }

  private apply(): void {
    this.world.scale.set(this.zoom);
    this.world.position.set(
      this.screen.width / 2 - this.cx * this.zoom,
      this.screen.height / 2 - this.cy * this.zoom,
    );
  }
}
