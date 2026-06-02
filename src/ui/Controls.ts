/**
 * Top control bar: return-to-full-view button and a toggle for the stock
 * selector panel.
 */
export class Controls {
  readonly el = document.createElement("div");

  constructor(opts: {
    onFullView: () => void;
    onToggleSelector: () => void;
    onToggleDirector: () => void;
    onToggleLabels: (on: boolean) => void;
    labelsOn: boolean;
    tracks: { id: string; name: string }[];
    currentTrack: string;
    onTrackChange: (id: string) => void;
  }) {
    this.el.className = "controls";

    const full = document.createElement("button");
    full.className = "btn";
    full.textContent = "◳ Vista completa";
    full.addEventListener("click", opts.onFullView);

    const director = document.createElement("button");
    director.className = "btn";
    director.textContent = "🎬 Regia auto";
    director.addEventListener("click", () => {
      const on = director.classList.toggle("active");
      director.textContent = on ? "🎬 Regia ON" : "🎬 Regia auto";
      opts.onToggleDirector();
    });

    const trackSel = document.createElement("select");
    trackSel.className = "btn select";
    for (const t of opts.tracks) {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = t.name;
      if (t.id === opts.currentTrack) o.selected = true;
      trackSel.appendChild(o);
    }
    trackSel.addEventListener("change", () => opts.onTrackChange(trackSel.value));

    const labels = document.createElement("button");
    labels.className = "btn" + (opts.labelsOn ? " active" : "");
    const labelText = () => (opts.labelsOn ? "🏷 Etichette ON" : "🏷 Etichette");
    labels.textContent = labelText();
    labels.addEventListener("click", () => {
      opts.labelsOn = !opts.labelsOn;
      labels.classList.toggle("active", opts.labelsOn);
      labels.textContent = labelText();
      opts.onToggleLabels(opts.labelsOn);
    });

    const sel = document.createElement("button");
    sel.className = "btn";
    sel.textContent = "☰ Titoli";
    sel.addEventListener("click", opts.onToggleSelector);

    this.el.append(full, director, trackSel, labels, sel);
  }
}
