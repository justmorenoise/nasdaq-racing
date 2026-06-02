import { Texture } from "pixi.js";
import carSvgRaw from "../../car/car.svg?raw";

/** 0xRRGGBB → "#rrggbb". */
export function hex(color: number): string {
  return "#" + color.toString(16).padStart(6, "0");
}

/** Stable, distinct helmet color derived from the ticker (when no secondary). */
export function randomCascoColor(symbol: string): string {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return hslToHex(hue, 70, 58);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const cache = new Map<string, Promise<Texture>>();

/**
 * A top-down F1 car texture from car.svg, tinted: the `base` body gets the
 * primary color, the `casco` (helmet) the secondary. Cached per color combo.
 */
export function carTexture(baseHex: string, cascoHex: string): Promise<Texture> {
  const key = `${baseHex}|${cascoHex}`;
  let p = cache.get(key);
  if (p) return p;

  const svg = carSvgRaw
    .replace('width="100%" height="100%"', 'width="240" height="480"')
    .replaceAll("rgb(255,0,0)", baseHex) // the `base` body
    .replace(/(id="casco"[\s\S]*?fill:)white/, `$1${cascoHex}`); // the helmet

  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  p = new Promise<Texture>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(Texture.from(img));
    img.onerror = reject;
    img.src = url;
  });
  cache.set(key, p);
  return p;
}
