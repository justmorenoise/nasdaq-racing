import {
  CanvasTexture,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
} from "three";

/**
 * Procedural, seamlessly-tiling surface textures (asphalt, grass, gravel),
 * generated once from an offscreen canvas and cached. Surfaces use world-space
 * UVs, so `repeat` is not needed: one tile spans the `*Tile` world units set in
 * CONFIG.scenery (see FlatBatch).
 */

interface NoiseLayer {
  count: number;
  r: [number, number];
  color: string;
  alpha: number;
}

function fillNoise(ctx: CanvasRenderingContext2D, size: number, base: string, layers: NoiseLayer[]): void {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  for (const layer of layers) {
    ctx.fillStyle = layer.color;
    ctx.globalAlpha = layer.alpha;
    for (let i = 0; i < layer.count; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = layer.r[0] + Math.random() * (layer.r[1] - layer.r[0]);
      // 9 copies so dots near an edge wrap to the opposite edge (seamless tile).
      for (const ox of [-size, 0, size]) {
        for (const oy of [-size, 0, size]) {
          ctx.beginPath();
          ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
  ctx.globalAlpha = 1;
}

function tiled(tex: Texture): Texture {
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.anisotropy = 8;
  return tex;
}

const cache = new Map<string, Texture>();
function noiseTexture(key: string, size: number, base: string, layers: NoiseLayer[]): Texture {
  let t = cache.get(key);
  if (!t) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    fillNoise(c.getContext("2d")!, size, base, layers);
    t = tiled(new CanvasTexture(c));
    cache.set(key, t);
  }
  return t;
}

export function asphaltTexture(): Texture {
  return noiseTexture("asphalt", 128, "#4a4e57", [
    { count: 320, r: [0.6, 1.6], color: "#3a3e47", alpha: 0.5 },
    { count: 220, r: [0.5, 1.3], color: "#585d68", alpha: 0.4 },
    { count: 60, r: [0.4, 0.9], color: "#6a7080", alpha: 0.25 },
  ]);
}

export function grassTexture(): Texture {
  return noiseTexture("grass", 192, "#5f9a45", [
    { count: 720, r: [0.9, 2.4], color: "#558e3d", alpha: 0.5 },
    { count: 600, r: [0.8, 2.0], color: "#69a64d", alpha: 0.45 },
    { count: 240, r: [0.6, 1.5], color: "#78b458", alpha: 0.4 },
  ]);
}

export function gravelTexture(): Texture {
  return noiseTexture("gravel", 128, "#d9c18c", [
    { count: 380, r: [0.7, 1.8], color: "#c7ad76", alpha: 0.55 },
    { count: 280, r: [0.6, 1.5], color: "#e6d2a2", alpha: 0.45 },
    { count: 90, r: [0.5, 1.1], color: "#a88f5c", alpha: 0.4 },
  ]);
}
