import { Container, Graphics, Text } from "pixi.js";
import type { Car } from "../sim/Car";
import type { CarPose } from "../sim/RaceModel";

const CAR_LEN = 20;
const CAR_W = 9;

/**
 * One car: a top-view body that rotates with heading, plus a ticker label that
 * stays upright and a constant screen size (counter-scaled by the camera zoom).
 */
export class CarView {
  readonly root = new Container();
  private body = new Container();
  private chassis = new Graphics();
  private aura = new Graphics();
  private leaderRing = new Graphics();
  private label: Text;
  private isLeader = false;

  constructor(private car: Car) {
    // Boost glow sits behind the chassis.
    this.aura.circle(0, 0, CAR_LEN * 0.8).fill({ color: car.color, alpha: 1 });
    this.aura.alpha = 0;
    this.root.addChild(this.aura);

    // Leader highlight ring (hidden unless P1).
    this.leaderRing.circle(0, 0, CAR_LEN * 0.78).stroke({
      width: 2,
      color: 0xffd23f,
      alpha: 0.9,
    });
    this.leaderRing.visible = false;
    this.root.addChild(this.leaderRing);

    this.drawChassis();
    this.body.addChild(this.chassis);
    this.root.addChild(this.body);

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
    this.root.addChild(this.label);
  }

  private drawChassis() {
    const g = this.chassis;
    const c = this.car.color;
    // Body (nose points +x).
    g.roundRect(-CAR_LEN / 2, -CAR_W / 2, CAR_LEN, CAR_W, 3).fill(c);
    // Front + rear wings.
    g.rect(CAR_LEN / 2 - 2, -CAR_W / 2 - 1.5, 3, CAR_W + 3).fill(0x222222);
    g.rect(-CAR_LEN / 2, -CAR_W / 2 - 1.5, 3, CAR_W + 3).fill(0x222222);
    // Cockpit accent.
    g.roundRect(-2, -2.5, 6, 5, 2).fill(0x0e0e0e);
    // Subtle outline for contrast on asphalt.
    g.roundRect(-CAR_LEN / 2, -CAR_W / 2, CAR_LEN, CAR_W, 3).stroke({
      width: 1,
      color: 0x000000,
      alpha: 0.4,
    });
  }

  /**
   * @param labelScale  1 / cameraZoom, keeps the label a constant screen size.
   * @param showLabel   hide when too cluttered (e.g. zoomed out far).
   * @param isLeader    P1 — gold label + highlight ring.
   */
  update(
    pose: CarPose,
    labelScale: number,
    showLabel: boolean,
    isLeader: boolean,
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
    // Leader is always labelled; ring stays constant screen size.
    this.leaderRing.scale.set(labelScale);
    this.label.visible = showLabel || isLeader;
    if (this.label.visible) {
      this.label.scale.set(labelScale);
      this.label.position.set(0, -14 * labelScale - CAR_W);
    }
  }

  destroy() {
    this.root.destroy({ children: true });
  }
}
