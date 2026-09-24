/**
 * The full-screen loading card (markup inline in index.html, so it shows
 * before any script): circuit name, a progress bar and the current build step.
 * Building a circuit is a few heavy synchronous passes; `step` yields a frame
 * after updating the card so the browser actually paints it between passes.
 */
export class Loader {
  private el = document.getElementById("loader");

  private part(sel: string): HTMLElement | null {
    return this.el?.querySelector<HTMLElement>(sel) ?? null;
  }

  show(trackName: string): void {
    if (!this.el) return;
    this.el.classList.remove("done");
    const t = this.part(".ld-track");
    if (t) t.textContent = trackName;
  }

  async step(label: string, fraction: number): Promise<void> {
    const s = this.part(".ld-step");
    const f = this.part(".ld-fill");
    if (s) s.textContent = label;
    if (f) f.style.width = `${Math.round(Math.max(0.04, Math.min(1, fraction)) * 100)}%`;
    await new Promise((r) => setTimeout(r, 30));
  }

  hide(): void {
    this.el?.classList.add("done");
  }
}
