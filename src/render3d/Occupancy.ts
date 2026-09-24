/**
 * Coarse occupancy grid of circular footprints, so independently placed
 * scenery (stands, paddock, props, trees, buildings) never overlaps.
 */
export class Occupancy {
  private cells = new Map<string, { x: number; y: number; r: number }[]>();
  constructor(private cell = 120) {}

  private key(i: number, j: number): string {
    return `${i},${j}`;
  }

  add(x: number, y: number, r: number): void {
    const c = this.cell;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
      for (let j = Math.floor((y - r) / c); j <= Math.floor((y + r) / c); j++) {
        const k = this.key(i, j);
        const l = this.cells.get(k) ?? [];
        l.push({ x, y, r });
        this.cells.set(k, l);
      }
    }
  }

  free(x: number, y: number, r: number): boolean {
    const c = this.cell;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
      for (let j = Math.floor((y - r) / c); j <= Math.floor((y + r) / c); j++) {
        for (const o of this.cells.get(this.key(i, j)) ?? []) {
          if (Math.hypot(o.x - x, o.y - y) < o.r + r) return false;
        }
      }
    }
    return true;
  }
}
