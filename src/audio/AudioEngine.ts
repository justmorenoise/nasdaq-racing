import { CONFIG } from "../config";
import type { Car } from "../sim/Car";
import type { Track } from "../track/Track";
import crowdUrl from "../../circuits/crowd.mp3?url";

/**
 * Mostly-synthesized race audio for a SINGLE focused car, to avoid a cacophony
 * of twenty engines: the leader in full view, or the chased car when one is
 * followed. Generated with the Web Audio API —
 *  - a continuous engine note whose pitch/volume track the car's speed,
 *  - a tyre screech on hard corner braking,
 *  - a "team radio" blip (bandpassed beep) on a boost/overtake.
 * — plus one real sample, `crowd.mp3`, that fades in as the car nears a
 * grandstand and fades out as it leaves (see CROWD_* below).
 *
 * The context is created lazily on the first enable (a user gesture), per the
 * browser autoplay policy. `enabled` is the on/off toggle; when off the master
 * gain is ramped to silence but the graph stays alive.
 */
// Engine pitch endpoints PER GEAR (revs, not speed): just after a shift the
// revs sit low (ENGINE_MIN_HZ) and climb to the redline (ENGINE_MAX_HZ) as the
// car accelerates through that gear; the next upshift drops back to MIN. So the
// note saws up-and-down once per gear — that's how the shifts become audible.
const ENGINE_MIN_HZ = 180;
const ENGINE_MAX_HZ = 500;
const BRAKE_REL_NORM = 0.32; // below this normalised speed (and slowing) → screech
const BRAKE_COOLDOWN = 0.9; // s
// Crowd cheer (crowd.mp3) plays continuously while the focused car is within
// CROWD_WINDOW of ANY grandstand, so a row of consecutive stands reads as one
// unbroken cheer; it only fades out once the car is past the last stand. The
// clip loops silently in the background and these knobs shape the fade envelope.
const CROWD_WINDOW = 150; // world units: how close counts as "at a grandstand"
const CROWD_FADE_IN = 1.0; // s ramp-up as the car reaches the first stand
const CROWD_FADE_OUT = 1.8; // s ramp-down once past the last stand
const CROWD_GAIN = 0.6; // crowd level while alongside the stands
const RADIO_COOLDOWN = 4; // s
const GEARS = 8; // 1..8
const SHIFT_HYST = 0.006; // relSpeed deadband so a car at a boundary won't chatter
const DOWNSHIFT_GAP = 0.055; // s between blips in a fast multi-gear scalata

export class AudioEngine {
  enabled = false;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private osc!: OscillatorNode;
  private sub!: OscillatorNode;
  private noiseBuffer!: AudioBuffer;
  private crowdBuffer: AudioBuffer | null = null;
  private crowdGain!: GainNode;
  private crowdSource: AudioBufferSourceNode | null = null;
  private crowdOn = false;

  private prevRel = 1;
  private gear = 1;
  private lastBrake = -Infinity;
  private lastRadio = -Infinity;
  private prevOvertakes = 0;

  /** Flip sound on/off; builds the audio graph on first enable. Returns state. */
  toggle(): boolean {
    if (!this.ctx) this.build();
    this.enabled = !this.enabled;
    void this.ctx!.resume();
    const t = this.ctx!.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.linearRampToValueAtTime(this.enabled ? 0.9 : 0, t + 0.2);
    return this.enabled;
  }

  private build(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // Engine: a sawtooth + a sub-octave, through a lowpass that opens with revs.
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 600;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0001;
    this.engineFilter.connect(this.engineGain).connect(this.master);

    this.osc = ctx.createOscillator();
    this.osc.type = "sawtooth";
    this.osc.frequency.value = ENGINE_MIN_HZ;
    this.sub = ctx.createOscillator();
    this.sub.type = "square";
    this.sub.frequency.value = ENGINE_MIN_HZ / 2;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.18; // just a touch of body under the high scream
    this.osc.connect(this.engineFilter);
    this.sub.connect(subGain).connect(this.engineFilter);
    this.osc.start();
    this.sub.start();

    // One white-noise buffer reused for screech / radio bursts.
    const len = ctx.sampleRate * 1.5;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Crowd-cheer bus: a looping sample (started once the clip decodes) whose
    // gain is opened/closed by proximity to the stands.
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0;
    this.crowdGain.connect(this.master);
    void this.loadCrowd(ctx);
  }

  private async loadCrowd(ctx: AudioContext): Promise<void> {
    try {
      const res = await fetch(crowdUrl);
      this.crowdBuffer = await ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      /* crowd clip is optional; the rest of the audio still works */
    }
  }

  /**
   * Per-frame update for the focused car (null = silence the engine). Detects
   * braking, grandstand passes and boosts internally from the car's own state.
   */
  update(car: Car | null, track: Track, grandstandDists: number[]): void {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;

    if (!car) {
      this.engineGain.gain.setTargetAtTime(0.0001, t, 0.1);
      this.setCrowd(false, t); // no focused car → let the crowd fade out
      return;
    }

    // Normalised speed (0 at the slowest corner, 1 flat out). Tracks the speed
    // profile's own vMin/vMax so it stays correct if those are retuned.
    const { vMin, vMax } = CONFIG.profile;
    const rel = Math.max(0, Math.min(1, (car.relSpeed - vMin) / (vMax - vMin)));

    // 8-speed gearbox: pick the gear matching the current speed using THIS
    // circuit's shift points (so Monza sits in 7th/8th, Monaco in 2nd–4th), with
    // a deadband against chatter. Done BEFORE pitch so the note reflects the gear.
    const bounds = track.gearBounds;
    let target = this.gear;
    while (target < GEARS && car.relSpeed >= bounds[target - 1] + SHIFT_HYST) target++;
    while (target > 1 && car.relSpeed < bounds[target - 2] - SHIFT_HYST) target--;
    if (target > this.gear) this.upshift(t);
    else if (target < this.gear) this.downshift(t, this.gear - target);
    this.gear = target;

    // Engine pitch = REVS within the current gear, not raw speed. Within a gear
    // the revs climb from just-shifted toward the redline as speed crosses that
    // gear's band; an upshift drops to a longer gear so the revs (pitch) fall
    // back, a downshift jumps them up. That discontinuity is the audible shift.
    // Lower edge clamped to the speed floor (a disabled gear's edge is −∞).
    const lo = Math.max(vMin, this.gear > 1 ? bounds[this.gear - 2] : vMin);
    const hi = bounds[this.gear - 1];
    const inGear = hi > lo + 1e-4 ? Math.max(0, Math.min(1, (car.relSpeed - lo) / (hi - lo))) : 1;
    const hz = ENGINE_MIN_HZ + inGear * (ENGINE_MAX_HZ - ENGINE_MIN_HZ);
    this.osc.frequency.setTargetAtTime(hz, t, 0.03);
    this.sub.frequency.setTargetAtTime(hz / 2, t, 0.03);
    this.engineFilter.frequency.setTargetAtTime(900 + inGear * 3200, t, 0.04);
    this.engineGain.gain.setTargetAtTime(0.05 + inGear * 0.13, t, 0.05);

    // Tyre screech: a sharp drop into one of the slowest corners.
    if (
      rel < BRAKE_REL_NORM &&
      car.relSpeed < this.prevRel - 0.01 &&
      t - this.lastBrake > BRAKE_COOLDOWN
    ) {
      this.lastBrake = t;
      this.burst(1300, 8, 0.18, 0.5, "bandpass");
    }
    this.prevRel = car.relSpeed;

    // Crowd cheer: on whenever the car is within range of ANY grandstand, so a
    // run of consecutive stands stays one continuous cheer, only fading out once
    // the car is clear of the last stand of the row.
    const pos = track.wrap(car.progress);
    const L = track.length;
    let near = false;
    for (const d of grandstandDists) {
      const dd = Math.abs(pos - d);
      if (Math.min(dd, L - dd) < CROWD_WINDOW) {
        near = true;
        break;
      }
    }
    this.setCrowd(near, t);

    // Team-radio blip on a fresh overtake by the focused car.
    if (car.overtakes > this.prevOvertakes && t - this.lastRadio > RADIO_COOLDOWN) {
      this.lastRadio = t;
      this.radioBlip();
    }
    this.prevOvertakes = car.overtakes;
  }

  /**
   * Open or close the continuous crowd cheer. The looping sample is started on
   * first use (once decoded); only a state change triggers a fade, so a row of
   * stands holds one steady cheer until the car clears the last one.
   */
  private setCrowd(on: boolean, t: number): void {
    if (!this.crowdBuffer) return;
    if (!this.crowdSource) {
      const src = this.ctx!.createBufferSource();
      src.buffer = this.crowdBuffer;
      src.loop = true;
      src.connect(this.crowdGain);
      src.start();
      this.crowdSource = src;
    }
    if (on === this.crowdOn) return;
    this.crowdOn = on;
    const g = this.crowdGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(on ? CROWD_GAIN : 0, t + (on ? CROWD_FADE_IN : CROWD_FADE_OUT));
  }

  /** A filtered noise burst (screech) with attack + exponential decay. */
  private burst(freq: number, q: number, gain: number, dur: number, type: BiquadFilterType): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq;
    filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur);
  }

  /** Two-tone "over the radio" beep (bandpassed sines) suggesting a pit call. */
  private radioBlip(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.value = 1800;
    filt.Q.value = 2;
    filt.connect(this.master);
    [880, 1240].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      const g = ctx.createGain();
      const start = t + i * 0.12;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.1);
      o.connect(g).connect(filt);
      o.start(start);
      o.stop(start + 0.12);
    });
  }

  /** Upshift: a short mechanical "tk" (bandpassed noise click). */
  private upshift(t: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2700;
    bp.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.06);
  }

  /**
   * Downshift scalata: one rev-matching throttle blip per gear dropped, spaced
   * out so a multi-gear drop into a hairpin sounds like a rapid "blap-blap-blap".
   */
  private downshift(t: number, drops: number): void {
    const ctx = this.ctx!;
    const n = Math.min(drops, GEARS);
    for (let i = 0; i < n; i++) {
      const start = t + i * DOWNSHIFT_GAP;
      // Throttle blip: a quick saw sweep up (the auto blips to rev-match).
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(170, start);
      o.frequency.exponentialRampToValueAtTime(430, start + 0.04);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 2400;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.17, start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.07);
      o.connect(lp).connect(g).connect(this.master);
      o.start(start);
      o.stop(start + 0.08);
      // A mechanical click layered on each blip.
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 2300;
      bp.Q.value = 5;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, start);
      cg.gain.exponentialRampToValueAtTime(0.11, start + 0.004);
      cg.gain.exponentialRampToValueAtTime(0.0001, start + 0.035);
      src.connect(bp).connect(cg).connect(this.master);
      src.start(start);
      src.stop(start + 0.05);
    }
  }
}
