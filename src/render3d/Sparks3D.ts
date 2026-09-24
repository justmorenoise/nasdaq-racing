import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
} from "three";
import { CONFIG } from "../config";
import type { Car } from "../sim/Car";
import type { Contact } from "../sim/RaceModel";

interface Particle {
  x: number;
  y: number; // height
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
}

type Pose = { x: number; y: number; tangent: number };

const MAX = 600;
const hot = new Color();
const warm = new Color();

/**
 * Short-lived sparks where two cars touch: streaks thrown backwards and up that
 * arc down under gravity and fade from white-hot to orange. One additive line
 * buffer holds every live particle. Burst size/energy scale with contact
 * intensity (CONFIG.sparks).
 */
export class Sparks3D {
  readonly lines: LineSegments;
  private particles: Particle[] = [];
  private lastEmit = new Map<string, number>();
  private clock = 0;
  private pos = new Float32Array(MAX * 6);
  private col = new Float32Array(MAX * 6);

  constructor() {
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    geo.setAttribute("color", new Float32BufferAttribute(this.col, 3));
    geo.setDrawRange(0, 0);
    this.lines = new LineSegments(
      geo,
      new LineBasicMaterial({ vertexColors: true, blending: AdditiveBlending, transparent: true, depthWrite: false }),
    );
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;
    hot.setHex(CONFIG.sparks.colorHot);
    warm.setHex(CONFIG.sparks.colorWarm);
  }

  emit(contacts: Contact[], poseOf: (c: Car) => Pose, dt: number): void {
    this.clock += dt;
    const s = CONFIG.sparks;
    for (const c of contacts) {
      const key = c.a.symbol < c.b.symbol ? `${c.a.symbol}|${c.b.symbol}` : `${c.b.symbol}|${c.a.symbol}`;
      const last = this.lastEmit.get(key) ?? -Infinity;
      if (this.clock - last < s.cooldown) continue;
      this.lastEmit.set(key, this.clock);
      const pa = poseOf(c.a);
      const pb = poseOf(c.b);
      this.spawn((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, pa.tangent + Math.PI, c.intensity);
    }
  }

  private spawn(x: number, z: number, dir: number, intensity: number): void {
    const s = CONFIG.sparks;
    const n = Math.max(1, Math.round(s.particleCount * intensity));
    for (let i = 0; i < n && this.particles.length < MAX; i++) {
      const ang = dir + (Math.random() * 2 - 1) * s.spread;
      const speed = (s.speedMin + Math.random() * (s.speedMax - s.speedMin)) * (0.5 + 0.5 * intensity);
      const life = s.lifeMin + Math.random() * (s.lifeMax - s.lifeMin);
      this.particles.push({
        x,
        y: 1.5,
        z,
        vx: Math.cos(ang) * speed,
        vy: speed * (0.25 + Math.random() * 0.45),
        vz: Math.sin(ang) * speed,
        life,
        maxLife: life,
      });
    }
  }

  update(dt: number): void {
    const g = CONFIG.sparks.gravity;
    const alive: Particle[] = [];
    let k = 0;
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy -= g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.5) {
        p.y = 0.5;
        p.vy *= -0.35; // skip along the asphalt
      }
      alive.push(p);
      const t = p.life / p.maxLife;
      const sp = Math.hypot(p.vx, p.vy, p.vz) || 1;
      const len = 2 + 5 * t;
      const c = t > 0.5 ? hot : warm;
      this.pos.set([p.x, p.y, p.z, p.x - (p.vx / sp) * len, p.y - (p.vy / sp) * len, p.z - (p.vz / sp) * len], k * 6);
      this.col.set([c.r * t, c.g * t, c.b * t, c.r * t * 0.3, c.g * t * 0.3, c.b * t * 0.3], k * 6);
      k++;
    }
    this.particles = alive;
    const geo = this.lines.geometry;
    geo.setDrawRange(0, k * 2);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }
}
