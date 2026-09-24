import { MathUtils, Vector3, type PerspectiveCamera } from "three";
import { CONFIG } from "../config";
import type { RaceModel } from "../sim/RaceModel";
import type { Track } from "../track/Track";
import type { TrackLayout } from "../track/corners";

type Mode =
  | { kind: "full" }
  | { kind: "chase"; symbol: string }
  | { kind: "tv"; symbol: string };

/** Camera rig: a look-at point plus orbit angles/distance around it. */
interface Rig {
  target: Vector3;
  yaw: number; // 0 = camera south of the target, looking north (−Z)
  pitch: number; // elevation above the horizon
  dist: number;
  fov: number;
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/**
 * Tilted perspective camera with three shots, all eased (dt-based):
 *  - full: the whole circuit framed at a ~54° tilt, slowly drifting in yaw so
 *    the diorama breathes;
 *  - chase: behind and above one car, swinging round with it through corners;
 *    it pulls back and widens the FOV with speed, and shakes a little under
 *    heavy braking;
 *  - tv: fixed trackside cameras at the sharpest corners that pan and zoom to
 *    follow a car, cutting to the next camera as it passes (auto-director).
 */
export class Camera3D {
  private mode: Mode = { kind: "full" };
  private cur: Rig;
  private goal: Rig;
  private sinceSwitch = 99;
  private clock = 0;
  private tvCams: Vector3[];
  private tvIndex = -1;
  /** Set when the TV director switches camera: snap instead of easing. */
  private cutPending = false;
  private prevRel = 1;
  private shake = 0;
  private tmp = new Vector3();
  private meanH = 0;
  private pinned: Rig | null = null;

  constructor(
    private camera: PerspectiveCamera,
    private track: Track,
    layout: TrackLayout,
    private model: RaceModel,
    private screen: { width: number; height: number },
    private ground: (x: number, y: number) => number = () => 0,
  ) {
    const s = track.samples;
    this.meanH = s.reduce((a, p) => a + p.h, 0) / s.length;
    this.tvCams = this.placeTvCams(layout);
    this.goal = this.fullRig();
    this.cur = { ...this.goal, target: this.goal.target.clone() };
    this.apply();
  }

  get currentMode(): "full" | "chase" {
    return this.mode.kind === "full" ? "full" : "chase";
  }

  get followedSymbol(): string | null {
    return this.mode.kind === "full" ? null : this.mode.symbol;
  }

  /** Where the camera is looking (for shadow focus / audio). */
  get focus(): Vector3 {
    return this.cur.target;
  }

  /** Radius of ground worth covering with shadows at the current framing. */
  get focusRadius(): number {
    return this.cur.dist * Math.tan(MathUtils.degToRad(this.cur.fov) / 2) * 1.8;
  }

  private setMode(m: Mode): void {
    this.mode = m;
    this.sinceSwitch = 0;
    this.tvIndex = -1;
  }

  showFull(): void {
    if (this.mode.kind !== "full") this.setMode({ kind: "full" });
  }

  follow(symbol: string): void {
    if (this.mode.kind === "chase" && this.mode.symbol === symbol) return;
    this.setMode({ kind: "chase", symbol });
  }

  toggleFollow(symbol: string): void {
    if (this.mode.kind !== "full" && this.mode.symbol === symbol) this.showFull();
    else this.follow(symbol);
  }

  /** Auto-director cut: alternate trackside TV shots and on-board chase. */
  director(symbol: string): void {
    const tv = this.mode.kind !== "tv" && Math.random() < 0.6;
    this.setMode(tv ? { kind: "tv", symbol } : { kind: "chase", symbol });
  }

  resize(): void {
    this.camera.aspect = this.screen.width / this.screen.height;
    this.camera.updateProjectionMatrix();
  }

  /** World units per screen pixel at a world point (for screen-constant markers). */
  worldPerPx(p: Vector3): number {
    const d = this.camera.position.distanceTo(p);
    return (2 * d * Math.tan(MathUtils.degToRad(this.camera.fov) / 2)) / this.screen.height;
  }

  private placeTvCams(layout: TrackLayout): Vector3[] {
    const c = CONFIG.camera;
    const s = this.track.samples;
    return [...layout.runs]
      .sort((a, b) => b.peakSeverity - a.peakSeverity)
      .slice(0, c.tvCamCount)
      .map((run) => {
        const p = s[run.indices[Math.round((run.apexStart + run.apexEnd) / 2)]];
        const out = -run.turnSign;
        const off = this.track.def.width / 2 + c.tvCamOffset;
        const x = p.x + p.nx * out * off;
        const y = p.y + p.ny * out * off;
        return new Vector3(x, Math.max(this.ground(x, y), p.h) + c.tvCamHeight, y);
      });
  }

  private rigFrom(cam: Vector3, target: Vector3, fov: number): Rig {
    const d = this.tmp.subVectors(cam, target);
    const dist = d.length();
    return {
      target: target.clone(),
      yaw: Math.atan2(d.x, d.z),
      pitch: Math.asin(MathUtils.clamp(d.y / dist, -1, 1)),
      dist,
      fov,
    };
  }

  private position(r: Rig, out: Vector3): Vector3 {
    const cp = Math.cos(r.pitch);
    return out.set(
      r.target.x + Math.sin(r.yaw) * cp * r.dist,
      r.target.y + Math.sin(r.pitch) * r.dist,
      r.target.z + Math.cos(r.yaw) * cp * r.dist,
    );
  }

  /** Whole circuit framed at a tilt: bisect the distance so every bounds corner fits. */
  private fullRig(): Rig {
    const c = CONFIG.camera;
    const b = this.track.bounds;
    const yaw = c.fullYawSwing * Math.sin((2 * Math.PI * this.clock) / c.fullYawPeriod);
    const rig: Rig = {
      target: new Vector3((b.minX + b.maxX) / 2, this.meanH, (b.minY + b.maxY) / 2),
      yaw,
      pitch: c.fullPitch,
      dist: 1000,
      fov: c.fov,
    };
    const corners = [
      new Vector3(b.minX, this.meanH, b.minY),
      new Vector3(b.maxX, this.meanH, b.minY),
      new Vector3(b.minX, this.meanH, b.maxY),
      new Vector3(b.maxX, this.meanH, b.maxY),
    ];
    const lim = 1 - c.fullPadding * 2;
    const cam = this.camera.clone();
    cam.fov = rig.fov;
    cam.aspect = this.screen.width / this.screen.height;
    cam.updateProjectionMatrix();
    const ndc = new Vector3();
    const measure = (): [number, number, boolean] => {
      this.position(rig, cam.position);
      cam.lookAt(rig.target);
      cam.updateMatrixWorld();
      let ymin = Infinity;
      let ymax = -Infinity;
      let fits = true;
      for (const p of corners) {
        ndc.copy(p).project(cam);
        if (Math.abs(ndc.x) > lim || Math.abs(ndc.y) > lim) fits = false;
        ymin = Math.min(ymin, ndc.y);
        ymax = Math.max(ymax, ndc.y);
      }
      return [ymin, ymax, fits];
    };
    const fit = () => {
      let lo = 50;
      let hi = 200000;
      for (let i = 0; i < 28; i++) {
        rig.dist = (lo + hi) / 2;
        if (measure()[2]) hi = rig.dist;
        else lo = rig.dist;
      }
      rig.dist = hi;
    };
    fit();
    // Perspective shrinks the far side: slide the target so the circuit sits
    // vertically centred, then refit.
    const [ymin, ymax] = measure();
    const mid = (ymin + ymax) / 2;
    const halfH = rig.dist * Math.tan(MathUtils.degToRad(rig.fov) / 2);
    const shift = (mid * halfH) / Math.sin(rig.pitch);
    rig.target.x += -Math.sin(yaw) * shift;
    rig.target.z += -Math.cos(yaw) * shift;
    fit();
    return rig;
  }

  private chaseRig(symbol: string): Rig | null {
    const car = this.model.cars.get(symbol);
    if (!car) return null;
    const c = CONFIG.camera;
    const pose = this.model.poseForCar(car);
    const { vMin, vMax } = CONFIG.profile;
    const norm = MathUtils.clamp((car.relSpeed - vMin) / (vMax - vMin), 0, 1);
    const fx = Math.cos(pose.tangent);
    const fz = Math.sin(pose.tangent);
    const zoom = c.chaseZoom * (1 - c.chaseZoomSpeedSpread * norm);
    const fov = c.fov + c.fovSpeedBoost * norm;
    const worldH = this.screen.height / zoom;
    const dist = Math.max(c.chaseMinDist, worldH / (2 * Math.tan(MathUtils.degToRad(fov) / 2)));

    // Heavy braking into a slow corner → a short burst of camera shake.
    if (car.relSpeed < this.prevRel - 0.004 && norm < 0.5) this.shake = Math.min(1, this.shake + 0.25);
    this.prevRel = car.relSpeed;

    return {
      target: new Vector3(pose.x + fx * c.lookAhead, this.track.heightAt(car.progress + c.lookAhead) + 4, pose.y + fz * c.lookAhead),
      yaw: Math.atan2(-fx, -fz),
      pitch: MathUtils.lerp(c.chasePitchSlow, c.chasePitchFast, norm),
      dist,
      fov,
    };
  }

  private tvRig(symbol: string): Rig | null {
    const car = this.model.cars.get(symbol);
    if (!car || !this.tvCams.length) return null;
    const pose = this.model.poseForCar(car);
    const at = new Vector3(pose.x, pose.h + 4, pose.y);
    // Nearest trackside camera, with hysteresis so shots don't flicker.
    let best = -1;
    let bestD = Infinity;
    this.tvCams.forEach((cam, i) => {
      const d = Math.hypot(cam.x - at.x, cam.z - at.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const curD =
      this.tvIndex >= 0 ? Math.hypot(this.tvCams[this.tvIndex].x - at.x, this.tvCams[this.tvIndex].z - at.z) : Infinity;
    if (this.tvIndex < 0 || bestD < curD * 0.7) {
      if (this.tvIndex >= 0) this.cutPending = true;
      this.tvIndex = best;
    }
    const cam = this.tvCams[this.tvIndex];
    const d = Math.hypot(cam.x - at.x, cam.z - at.z);
    if (d > CONFIG.camera.tvCamRange) return null;
    // Zoom the lens to hold the car at a steady on-screen size.
    const fov = MathUtils.clamp(MathUtils.radToDeg(2 * Math.atan(110 / d)), 10, 55);
    return this.rigFrom(cam, at, fov);
  }

  /** Dev inspection: pin the camera to a fixed rig (null releases it). */
  inspect(rig: { x: number; y: number; h: number; yaw: number; pitch: number; dist: number } | null): void {
    this.pinned = rig
      ? { target: new Vector3(rig.x, rig.h, rig.y), yaw: rig.yaw, pitch: rig.pitch, dist: rig.dist, fov: CONFIG.camera.fov }
      : null;
  }

  update(dt: number): void {
    if (this.pinned) {
      this.cur = { ...this.pinned, target: this.pinned.target.clone() };
      this.apply();
      return;
    }
    const c = CONFIG.camera;
    this.clock += dt;
    this.sinceSwitch += dt;
    const transitioning = this.sinceSwitch < 1.6;

    let goal: Rig | null = null;
    if (this.mode.kind === "chase") goal = this.chaseRig(this.mode.symbol);
    else if (this.mode.kind === "tv") {
      goal = this.tvRig(this.mode.symbol) ?? this.chaseRig(this.mode.symbol);
    }
    if (!goal) {
      if (this.mode.kind !== "full") this.setMode({ kind: "full" });
      goal = this.fullRig();
    }
    this.goal = goal;
    if (this.cutPending) {
      this.cutPending = false;
      this.sinceSwitch = 99;
      this.cur = { ...goal, target: goal.target.clone() };
    }

    const slow = ease(c.transitionRate, dt);
    const tRate = transitioning ? slow : ease(this.mode.kind === "full" ? c.transitionRate : c.chaseFollowRate, dt);
    const yRate = transitioning ? slow : ease(this.mode.kind === "chase" ? c.chaseYawRate : 8, dt);
    this.cur.target.lerp(goal.target, tRate);
    this.cur.yaw += wrapAngle(goal.yaw - this.cur.yaw) * yRate;
    this.cur.pitch += (goal.pitch - this.cur.pitch) * slow;
    // Distance eases in log space so long full↔chase swoops feel even.
    this.cur.dist = Math.exp(Math.log(this.cur.dist) + (Math.log(goal.dist) - Math.log(this.cur.dist)) * slow);
    this.cur.fov += (goal.fov - this.cur.fov) * slow;
    this.shake *= Math.exp(-5 * dt);
    this.apply();
  }

  private apply(): void {
    const cam = this.camera;
    this.position(this.cur, cam.position);
    if (this.shake > 0.01) {
      const a = this.shake * 1.2;
      cam.position.x += (Math.random() - 0.5) * a;
      cam.position.y += (Math.random() - 0.5) * a;
    }
    cam.lookAt(this.cur.target);
    if (Math.abs(cam.fov - this.cur.fov) > 1e-3) cam.fov = this.cur.fov;
    // Depth range tracks the framing so the stacked ground layers never z-fight.
    cam.near = Math.max(2, this.cur.dist / 40);
    cam.far = this.cur.dist * 30 + 5000;
    cam.updateProjectionMatrix();
  }
}
