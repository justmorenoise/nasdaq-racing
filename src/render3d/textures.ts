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
  return noiseTexture("asphalt", 128, "#55585e", [
    { count: 320, r: [0.6, 1.6], color: "#474a50", alpha: 0.45 },
    { count: 220, r: [0.5, 1.3], color: "#63666c", alpha: 0.4 },
    { count: 60, r: [0.4, 0.9], color: "#74777c", alpha: 0.25 },
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
  return noiseTexture("gravel", 128, "#dccaa2", [
    { count: 380, r: [0.7, 1.8], color: "#cdb98f", alpha: 0.5 },
    { count: 280, r: [0.6, 1.5], color: "#e9dcbd", alpha: 0.45 },
    { count: 90, r: [0.5, 1.1], color: "#b8a37a", alpha: 0.35 },
  ]);
}

/**
 * Catch-fence wire mesh (one diamond per tile, white on transparent). Tiled on
 * see-through panels: its mipmaps fade the wires to a light haze with distance
 * instead of the crawling moiré that one-pixel line geometry gives.
 */
export function fenceTexture(): Texture {
  let t = cache.get("fence");
  if (!t) {
    const size = 64;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d")!;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    for (const [x0, y0, x1, y1] of [
      [0, 0, size, size],
      [size, 0, 0, size],
      [-size, 0, size, 2 * size],
      [0, -size, 2 * size, size],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, 3); // horizontal tension wire
    t = tiled(new CanvasTexture(c));
    cache.set("fence", t);
  }
  return t;
}
