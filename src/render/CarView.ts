import { Container, Graphics, Sprite, Text } from "pixi.js";
import type { Car } from "../sim/Car";
import type { CarPose } from "../sim/RaceModel";
import { carTexture, hex, randomCascoColor } from "./carSprite";

const CAR_LEN = 30; // long axis in world units
const CAR_W = 14;
// The car art points along its vertical axis; rotate so the nose faces +x
// (heading direction) within the body container.
const SPRITE_ROT = -Math.PI / 2;

/**
 * One car: a tinted top-view F1 sprite (from car.svg) that rotates with heading,
 * plus a boost aura, a leader ring, and a ticker label that stays upright at a
 * constant screen size.
 */
export class CarView {
  readonly root = new Container();
  private body = new Container();
  private sprite = new Sprite();
  private aura = new Graphics();
  private leaderRing = new Graphics();
  private label: Text;
  private isLeader = false;

  constructor(
    private car: Car,
    labelLayer: Container,
    /** Per-track size lever (default 1): scales the car art and its markers. */
    private scale = 1,
  ) {
    this.aura.circle(0, 0, CAR_LEN * this.scale * 0.6).fill({ color: car.color, alpha: 1 });
    this.aura.alpha = 0;
    this.root.addChild(this.aura);

    this.leaderRing.circle(0, 0, CAR_LEN * this.scale * 0.62).stroke({
      width: 2,
      color: 0xffd23f,
      alpha: 0.9,
    });
    this.leaderRing.visible = false;
    this.root.addChild(this.leaderRing);

    this.sprite.anchor.set(0.5);
    this.sprite.rotation = SPRITE_ROT;
    this.sprite.visible = false;
    this.body.addChild(this.sprite);
    this.root.addChild(this.body);

    const baseHex = hex(car.color);
    const cascoHex =
      car.color2 != null ? hex(car.color2) : randomCascoColor(car.symbol);
    carTexture(baseHex, cascoHex)
      .then((tex) => {
        this.sprite.texture = tex;
        this.sprite.scale.set((CAR_LEN * this.scale) / tex.height); // height is the long axis
        this.sprite.visible = true;
      })
      .catch(() => {});

    this.label = new Text({
      text: car.symbol,
      style: {
        fontFamily:
          "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
        fontSize: 12,
        fontWeight: "700",
        fill: 0xffffff,
        stroke: { color: 0x000000, width: 3 },
      },
    });
    this.label.anchor.set(0.5, 1);
    // Labels live in a dedicated layer above all cars so a car body never
    // occludes another car's name; positioned in world coords each frame.
    labelLayer.addChild(this.label);
  }

  /**
   * @param labelScale  1 / cameraZoom, keeps the label a constant screen size.
   * @param showLabel   whether labels are enabled (global toggle).
   * @param isLeader    P1 — gold label + highlight ring.
   * @param ringScale   extra multiplier on the leader ring (e.g. 0.5 to shrink
   *                    it on the mobile circuit thumbnail).
   */
  update(
    pose: CarPose,
    labelScale: number,
    showLabel: boolean,
    isLeader: boolean,
    ringScale = 1,
  ): void {
    this.root.position.set(pose.x, pose.y);
    this.body.rotation = pose.tangent;
    // Boost glow: pulse alpha + scale with the car's transient boost value.
    const b = this.car.boost;
    this.aura.alpha = b * 0.55;
    this.aura.scale.set(0.8 + b * 0.5);

    if (isLeader !== this.isLeader) {
      this.isLeader = isLeader;
      this.label.style.fill = isLeader ? 0xffd23f : 0xffffff;
      this.leaderRing.visible = isLeader;
    }
    this.leaderRing.scale.set(labelScale * ringScale);
    this.label.visible = showLabel;
    if (this.label.visible) {
      this.label.scale.set(labelScale);
      this.label.position.set(pose.x, pose.y - 14 * labelScale - CAR_W * this.scale);
    }
  }

  destroy() {
    this.label.destroy();
    this.root.destroy({ children: true });
  }
}
