import { FillPattern, Matrix, Texture } from "pixi.js";

/**
 * Procedural, seamlessly-tiling surface textures (asphalt, grass, gravel) and a
 * crowd speckle, generated once from an offscreen canvas and cached. Mirrors the
 * caching style of carSprite.ts. No binary assets: everything is drawn in code
 * so it works for every circuit at any scale.
 */

interface NoiseLayer {
  count: number;
  /** Min/max dot radius (px). */
  r: [number, number];
  color: string;
  alpha: number;
}

/** Draw a base color plus speckle layers, wrapping each dot so the tile seams. */
function fillNoise(
  ctx: CanvasRenderingContext2D,
  size: number,
  base: string,
  layers: NoiseLayer[],
): void {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  for (const layer of layers) {
    ctx.fillStyle = layer.color;
    ctx.globalAlpha = layer.alpha;
    for (let i = 0; i < layer.count; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = layer.r[0] + Math.random() * (layer.r[1] - layer.r[0]);
      // 9 copies so dots near an edge appear on the opposite edge too.
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

function hexToRgba(hexColor: string, a: number): string {
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** Large, soft radial blobs (wrapped) for low-frequency tonal variation. */
function softPatches(
  ctx: CanvasRenderingContext2D,
  size: number,
  count: number,
  r: [number, number],
  colors: string[],
  alpha: number,
): void {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const rad = r[0] + Math.random() * (r[1] - r[0]);
    const color = colors[(Math.random() * colors.length) | 0];
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const grad = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad);
        grad.addColorStop(0, hexToRgba(color, alpha));
        grad.addColorStop(1, hexToRgba(color, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function makeTexture(
  size: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): Texture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  draw(ctx);
  const tex = Texture.from(c);
  tex.source.addressMode = "repeat";
  tex.source.scaleMode = "linear";
  return tex;
}

const texCache = new Map<string, Texture>();
function cachedTexture(
  key: string,
  size: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): Texture {
  let t = texCache.get(key);
  if (!t) {
    t = makeTexture(size, draw);
    texCache.set(key, t);
  }
  return t;
}

export function asphaltTexture(): Texture {
  return cachedTexture("asphalt", 128, (ctx) =>
    fillNoise(ctx, 128, "#3b3f49", [
      { count: 320, r: [0.6, 1.6], color: "#2c303a", alpha: 0.5 },
      { count: 220, r: [0.5, 1.3], color: "#494e5a", alpha: 0.4 },
      { count: 60, r: [0.4, 0.9], color: "#5a6070", alpha: 0.25 },
    ]),
  );
}

export function grassTexture(): Texture {
  // 256px + large soft tonal patches so the (seamless) tile doesn't read as an
  // obvious repeat: low-frequency mown/worn variation plus a fine blade speckle.
  return cachedTexture("grass", 256, (ctx) => {
    fillNoise(ctx, 256, "#2b5d33", [
      { count: 760, r: [1.2, 3.0], color: "#23502b", alpha: 0.5 },
      { count: 620, r: [1.0, 2.6], color: "#356f3c", alpha: 0.45 },
      { count: 260, r: [0.8, 1.8], color: "#43874b", alpha: 0.4 },
    ]);
    softPatches(ctx, 256, 14, [40, 95], ["#21492a", "#326a39", "#2f6536", "#1f4527"], 0.22);
  });
}

export function gravelTexture(): Texture {
  return cachedTexture("gravel", 128, (ctx) =>
    fillNoise(ctx, 128, "#b6a06a", [
      { count: 380, r: [0.7, 1.8], color: "#9c8454", alpha: 0.55 },
      { count: 280, r: [0.6, 1.5], color: "#cdba85", alpha: 0.45 },
      { count: 90, r: [0.5, 1.1], color: "#7d6840", alpha: 0.4 },
    ]),
  );
}

const patternCache = new Map<string, FillPattern>();

/**
 * A repeating fill anchored in world space, scaled so one texture tile spans
 * `worldTile` world units. FillPattern pre-scales UVs to 1 texel = 1 world unit,
 * so we only need a uniform scale of worldTile / textureWidth.
 */
export function pattern(
  key: string,
  texture: Texture,
  worldTile: number,
): FillPattern {
  let p = patternCache.get(key);
  if (!p) {
    p = new FillPattern(texture, "repeat");
    p.setTransform(new Matrix().scale(worldTile / texture.width, worldTile / texture.width));
    patternCache.set(key, p);
  }
  return p;
}
