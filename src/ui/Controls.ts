import { signupUrl, affiliateEnabled, AFFILIATE_REL } from "../affiliate";

/** Build a button with a separate icon and label span. The label is hidden on
 * mobile (CSS), collapsing the bar to a single row of icons; the icon's `title`
 * keeps it discoverable. Returns the button and its label span so callers can
 * retitle it (e.g. toggles) without touching the icon. */
function iconButton(
  icon: string,
  label: string,
): { btn: HTMLButtonElement; setLabel: (text: string) => void } {
  const btn = document.createElement("button");
  btn.className = "btn";
  const ico = document.createElement("span");
  ico.className = "btn-icon";
  ico.textContent = icon;
  const lbl = document.createElement("span");
  lbl.className = "btn-label";
  lbl.textContent = label;
  btn.append(ico, lbl);
  btn.title = label;
  const setLabel = (text: string) => {
    lbl.textContent = text;
    btn.title = text;
  };
  return { btn, setLabel };
}

/**
 * Top control bar: return-to-full-view button and a toggle for the stock
 * selector panel.
 */
export class Controls {
  readonly el = document.createElement("div");
  private director!: HTMLButtonElement;
  private setDirectorLabel!: (text: string) => void;

  constructor(opts: {
    onFullView: () => void;
    onToggleSelector: () => void;
    onToggleDirector: (on: boolean) => void;
    onToggleLabels: (on: boolean) => void;
    labelsOn: boolean;
    onToggleSound: () => boolean;
    tracks: { id: string; name: string }[];
    currentTrack: string;
    onTrackChange: (id: string) => void;
  }) {
    this.el.className = "controls";

    const full = iconButton("◳", "Vista completa");
    full.btn.addEventListener("click", opts.onFullView);

    const director = iconButton("🎬", "Regia auto");
    this.director = director.btn;
    this.setDirectorLabel = director.setLabel;
    director.btn.addEventListener("click", () => {
      this.setDirector(!director.btn.classList.contains("active"));
      opts.onToggleDirector(director.btn.classList.contains("active"));
    });

    const trackSel = document.createElement("select");
    trackSel.className = "btn select";
    trackSel.title = "Circuito";
    for (const t of opts.tracks) {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = t.name;
      if (t.id === opts.currentTrack) o.selected = true;
      trackSel.appendChild(o);
    }
    trackSel.addEventListener("change", () => opts.onTrackChange(trackSel.value));

    const labelText = () => (opts.labelsOn ? "Etichette ON" : "Etichette");
    const labels = iconButton("🏷", labelText());
    labels.btn.classList.toggle("active", opts.labelsOn);
    labels.btn.addEventListener("click", () => {
      opts.labelsOn = !opts.labelsOn;
      labels.btn.classList.toggle("active", opts.labelsOn);
      labels.setLabel(labelText());
      opts.onToggleLabels(opts.labelsOn);
    });

    const sound = iconButton("🔇", "Audio");
    sound.btn.addEventListener("click", () => {
      const on = opts.onToggleSound();
      sound.btn.classList.toggle("active", on);
      sound.setLabel(on ? "Audio ON" : "Audio");
      sound.btn.querySelector(".btn-icon")!.textContent = on ? "🔊" : "🔇";
    });

    const sel = iconButton("☰", "Titoli");
    sel.btn.addEventListener("click", opts.onToggleSelector);

    this.el.append(full.btn, director.btn, trackSel, labels.btn, sound.btn, sel.btn);

    if (affiliateEnabled) {
      const invest = document.createElement("a");
      invest.className = "btn invest";
      const ico = document.createElement("span");
      ico.className = "btn-icon";
      ico.textContent = "💸";
      const lbl = document.createElement("span");
      lbl.className = "btn-label";
      lbl.textContent = "Apri conto";
      invest.append(ico, lbl);
      invest.title = "Apri conto";
      invest.href = signupUrl();
      invest.target = "_blank";
      invest.rel = AFFILIATE_REL;
      this.el.append(invest);
    }
  }

  /** Reflect the auto-director state in the button (e.g. when the user takes
   * manual control by picking a car, the director turns off). */
  setDirector(on: boolean): void {
    this.director.classList.toggle("active", on);
    this.setDirectorLabel(on ? "Regia ON" : "Regia auto");
  }
}
