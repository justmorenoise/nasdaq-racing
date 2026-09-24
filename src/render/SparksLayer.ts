import { Container, Graphics } from "pixi.js";
import { CONFIG } from "../config";
import type { Car } from "../sim/Car";
import type { Contact } from "../sim/RaceModel";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

type Pose = { x: number; y: number; tangent: number };

/**
 * Short-lived sparks where two cars touch. Live particles are redrawn into a
 * single Graphics each frame (no RenderTexture - they move, arc under gravity
 * and fade), so the layer is cheap as long as bursts stay small. Burst size and
 * energy scale with the contact intensity, all tunable in CONFIG.sparks.
 */
export class SparksLayer {
  readonly container = new Container();
  private g = new Graphics();
  private particles: Particle[] = [];
  /** Last emit time per car pair, to rate-limit a sustained scrape. */
  private lastEmit = new Map<string, number>();
  private clock = 0;

  constructor() {
    this.container.addChild(this.g);
  }

  /** Emit sparks for this frame's contacts (rate-limited per car pair). */
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
      this.spawn((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, pa.tangent, c.intensity);
    }
  }

  private spawn(x: number, y: number, tangent: number, intensity: number): void {
    const s = CONFIG.sparks;
    const n = Math.max(1, Math.round(s.particleCount * intensity));
    for (let i = 0; i < n; i++) {
      const ang = tangent + (Math.random() * 2 - 1) * s.spread;
      const speed = (s.speedMin + Math.random() * (s.speedMax - s.speedMin)) * (0.5 + 0.5 * intensity);
      const life = s.lifeMin + Math.random() * (s.lifeMax - s.lifeMin);
      this.particles.push({
        x,
        y,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed,
        life,
        maxLife: life,
      });
    }
  }

  /** Advance and redraw all live particles; drop the dead ones. */
  update(dt: number): void {
    const s = CONFIG.sparks;
    const g = this.g;
    g.clear();
    const alive: Particle[] = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy += s.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      alive.push(p);
      const t = p.life / p.maxLife; // 1 fresh → 0 dead
      const sp = Math.hypot(p.vx, p.vy) || 1;
      const len = 2 + 5 * t;
      g.moveTo(p.x, p.y)
        .lineTo(p.x - (p.vx / sp) * len, p.y - (p.vy / sp) * len)
        .stroke({ width: 1.5, color: t > 0.5 ? s.colorHot : s.colorWarm, alpha: t });
    }
    this.particles = alive;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
