import {
  BoxGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  type Object3D,
} from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { Car } from "../sim/Car";
import type { CarPose } from "../sim/RaceModel";
import { hex, randomCascoColor } from "./colors";
import { buildCar, CAR_LEN, WHEEL_R } from "./CarModel";
import { headingToRotY } from "./coords";

const ringGeo = new RingGeometry(0.9, 1, 48).rotateX(-Math.PI / 2);
const goldMat = new MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.95, depthWrite: false, side: DoubleSide });
const purpleMat = new MeshBasicMaterial({ color: 0xb14bff, transparent: true, opacity: 0.95, depthWrite: false, side: DoubleSide });
const hitGeo = new BoxGeometry(CAR_LEN * 1.3, 10, 16).translate(0, 5, 0);
const hitMat = new MeshBasicMaterial({ visible: false });

const MAX_ROLL = 0.07;
const MAX_PITCH = 0.035;

/**
 * One car in the 3D scene: the low-poly model posed on the track with spinning
 * wheels and a little body roll/pitch from cornering and braking, flat leader
 * (gold) and "fastest lap" (purple) rings on the ground, and an upright DOM
 * ticker label (CSS2D) that stays a constant screen size.
 */
export class CarView3D {
  readonly root = new Group();
  /** Invisible, generous box used for click picking. */
  readonly hit: Mesh;
  private chassis = new Group();
  private wheels: Object3D[];
  private leaderRing = new Mesh(ringGeo, goldMat);
  private momentumRing = new Mesh(ringGeo, purpleMat);
  private labelEl = document.createElement("div");
  private label: CSS2DObject;
  private isLeader = false;
  private prevTangent: number | null = null;
  private prevSpeed = 0;
  private roll = 0;
  private pitch = 0;

  constructor(
    readonly car: Car,
    private scale = 1,
    onPick: (symbol: string) => void,
  ) {
    const parts = buildCar(car.color, car.color2 ?? parseInt(randomCascoColor(car.symbol).slice(1), 16));
    this.wheels = parts.wheels;
    this.chassis.add(parts.root);
    this.chassis.scale.setScalar(scale);
    this.root.add(this.chassis);

    this.leaderRing.visible = false;
    this.momentumRing.visible = false;
    this.leaderRing.position.y = this.momentumRing.position.y = 1.6;
    this.leaderRing.renderOrder = this.momentumRing.renderOrder = 2;
    this.root.add(this.leaderRing, this.momentumRing);

    this.hit = new Mesh(hitGeo, hitMat);
    this.hit.scale.setScalar(scale);
    this.hit.userData.symbol = car.symbol;
    this.root.add(this.hit);

    this.labelEl.className = "car-label";
    this.labelEl.textContent = car.symbol;
    this.labelEl.style.setProperty("--car", hex(car.color));
    this.labelEl.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.labelEl.addEventListener("click", () => onPick(car.symbol));
    this.label = new CSS2DObject(this.labelEl);
    this.label.position.set(0, 12 * scale, 0);
    this.root.add(this.label);
  }

  /**
   * @param worldPerPx  world units per screen pixel at the car (screen-constant rings).
   * @param ringScale   extra multiplier on the rings (0.5 on the mobile thumbnail).
   */
  update(
    pose: CarPose,
    dt: number,
    worldPerPx: number,
    showLabel: boolean,
    isLeader: boolean,
    ringScale = 1,
    isMomentum = false,
  ): void {
    const car = this.car;
    this.root.position.set(pose.x, 0, pose.y);
    this.root.rotation.y = headingToRotY(pose.tangent);

    // Lateral load from yaw rate × speed rolls the body toward the outside;
    // deceleration dips the nose. Both eased so data jumps don't jerk the body.
    if (dt > 0) {
      let yawRate = 0;
      if (this.prevTangent !== null) {
        let d = pose.tangent - this.prevTangent;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        yawRate = d / dt;
      }
      const accel = (car.worldSpeed - this.prevSpeed) / dt;
      const tRoll = Math.max(-MAX_ROLL, Math.min(MAX_ROLL, yawRate * car.worldSpeed * 0.00018));
      const tPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, accel * 0.00025));
      const e = 1 - Math.exp(-6 * dt);
      this.roll += (tRoll - this.roll) * e;
      this.pitch += (tPitch - this.pitch) * e;
    }
    this.prevTangent = pose.tangent;
    this.prevSpeed = car.worldSpeed;
    this.chassis.rotation.set(this.roll, 0, this.pitch);

    const spin = -car.distance / (WHEEL_R * this.scale);
    for (const w of this.wheels) w.rotation.z = spin;

    if (isLeader !== this.isLeader) {
      this.isLeader = isLeader;
      this.labelEl.classList.toggle("leader", isLeader);
      this.leaderRing.visible = isLeader;
    }
    const baseR = Math.max(CAR_LEN * this.scale * 0.62, 18 * worldPerPx) * ringScale;
    this.leaderRing.scale.setScalar(baseR);
    this.momentumRing.visible = isMomentum && !isLeader;
    this.momentumRing.scale.setScalar(baseR * 1.25);
    this.label.visible = showLabel;
  }

  destroy(): void {
    this.labelEl.remove();
    this.root.removeFromParent();
  }
}
