import { CONFIG } from "../config";
import type { Car } from "../sim/Car";
import type { Track } from "../track/Track";
import { gearAtSpeed } from "../track/gearbox";
import crowdUrl from "../../circuits/crowd.mp3?url";

/**
 * Race audio for a SINGLE focused car (the leader in full view, the chased car
 * otherwise), built from real recordings (see public/audio/CREDITS.md):
 *  - the engine is two seamless loops cut from F1 V8 launches at Goodwood (a
 *    mid and a high rev band), equal-power cross-faded and re-pitched with
 *    playbackRate to follow the revs *within the current gear*: the note climbs
 *    toward the redline, drops on each upshift, jumps on each downshift (with a
 *    throttle blip per gear in a scalata). Lifting off closes a low-pass and
 *    drops the level, with the odd overrun crackle;
 *  - a second, quieter engine voice for the nearest rival, doppler-shifted, so
 *    a battle sounds like two cars nose to tail;
 *  - a sampled tyre squeal on hard braking, the crowd (crowd.mp3) while the car
 *    is alongside the grandstands, and a team-radio blip on an overtake.
 * The AudioContext is created on the first enable (autoplay policy).
 */

const AUDIO_BASE = "audio/";
const BRAKE_REL_NORM = 0.32; // below this normalised speed (and slowing) → squeal
const BRAKE_COOLDOWN = 0.9; // s
const CROWD_WINDOW = 150; // world units: how close counts as "at a grandstand"
const CROWD_FADE_IN = 1.0;
const CROWD_FADE_OUT = 1.8;
const CROWD_GAIN = 0.55;
const RADIO_COOLDOWN = 4;
const GEARS = 8;
const SHIFT_HYST = 0.006;
const DOWNSHIFT_GAP = 0.07; // s between blips in a fast multi-gear scalata
/** Perceived engine pitch (Hz) just after an upshift and at the redline. */
const PITCH_LO = 390;
const PITCH_HI = 610;
/** Rev band where the mid loop hands over to the high loop. */
const XFADE_LO = 440;
const XFADE_HI = 530;
const RIVAL_RANGE = 140; // world units along the track
const SOUND_SPEED = 620; // world units/s (≈ 343 m/s at the game's scale)

interface LoopSpec {
  file: string;
  pitch: number;
}

/** One engine: both rev-band loops playing in sync, mixed by the revs. */
interface EngineVoice {
  mid: AudioBufferSourceNode;
  high: AudioBufferSourceNode;
  midGain: GainNode;
  highGain: GainNode;
  filter: BiquadFilterNode;
  out: GainNode;
}

export class AudioEngine {
  enabled = false;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private specs: { mid: LoopSpec; high: LoopSpec } | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private engine: EngineVoice | null = null;
  private rival: EngineVoice | null = null;
  private rivalPan!: StereoPannerNode;
  private noiseBuffer!: AudioBuffer;
  private crowdGain!: GainNode;
  private crowdSource: AudioBufferSourceNode | null = null;
  private crowdOn = false;

  private prevRel = 1;
  private gear = 1;
  private lastBrake = -Infinity;
  private lastRadio = -Infinity;
  private lastPop = 0;
  private prevOvertakes = 0;
  private blipUntil = 0;

  toggle(): boolean {
    if (!this.ctx) this.build();
    this.enabled = !this.enabled;
    void this.ctx!.resume();
    const t = this.ctx!.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(this.enabled ? 0.9 : 0, t + 0.2);
    return this.enabled;
  }

  private build(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;
    // A soft compressor on the bus keeps launches, squeals and the crowd from clipping.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(comp);

    const len = ctx.sampleRate;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0;
    this.crowdGain.connect(this.master);

    this.rivalPan = ctx.createStereoPanner();
    this.rivalPan.connect(this.master);

    void this.load(ctx);
  }

  private async fetchBuffer(ctx: AudioContext, url: string): Promise<AudioBuffer | null> {
    try {
      const res = await fetch(url);
      return await ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  private async load(ctx: AudioContext): Promise<void> {
    const [manifest, crowd, tyres] = await Promise.all([
      fetch(AUDIO_BASE + "engine.json").then((r) => r.json() as Promise<{ mid: LoopSpec; high: LoopSpec }>).catch(() => null),
      this.fetchBuffer(ctx, crowdUrl),
      this.fetchBuffer(ctx, AUDIO_BASE + "tyres.wav"),
    ]);
    if (crowd) this.buffers.set("crowd", crowd);
    if (tyres) this.buffers.set("tyres", tyres);
    if (!manifest) return;
    const [mid, high] = await Promise.all([
      this.fetchBuffer(ctx, AUDIO_BASE + manifest.mid.file),
      this.fetchBuffer(ctx, AUDIO_BASE + manifest.high.file),
    ]);
    if (!mid || !high) return;
    this.buffers.set("mid", mid);
    this.buffers.set("high", high);
    this.specs = manifest;
    this.engine = this.voice(this.master, 0.0001);
    this.rival = this.voice(this.rivalPan, 0.0001);
  }

  private voice(dest: AudioNode, gain: number): EngineVoice {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = gain;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 9000;
    filter.Q.value = 0.8;
    filter.connect(out).connect(dest);
    const loop = (key: "mid" | "high") => {
      const src = ctx.createBufferSource();
      src.buffer = this.buffers.get(key)!;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(filter);
      // Random start offset so the two loops never phase-lock audibly.
      src.start(0, Math.random() * src.buffer.duration);
      return [src, g] as const;
    };
    const [mid, midGain] = loop("mid");
    const [high, highGain] = loop("high");
    return { mid, high, midGain, highGain, filter, out };
  }

  /** Point an engine voice at a perceived pitch (Hz) and mix its two loops. */
  private drive(v: EngineVoice, hz: number, t: number, tc: number): void {
    const s = this.specs!;
    v.mid.playbackRate.setTargetAtTime(hz / s.mid.pitch, t, tc);
    v.high.playbackRate.setTargetAtTime(hz / s.high.pitch, t, tc);
    const x = Math.max(0, Math.min(1, (hz - XFADE_LO) / (XFADE_HI - XFADE_LO)));
    v.midGain.gain.setTargetAtTime(Math.cos((x * Math.PI) / 2), t, 0.05);
    v.highGain.gain.setTargetAtTime(Math.sin((x * Math.PI) / 2), t, 0.05);
  }

  /** Revs within the gear for a car, as a perceived engine pitch. */
  private pitchFor(relSpeed: number, gear: number, track: Track): number {
    const { vMin } = CONFIG.profile;
    const bounds = track.gearBounds;
    const lo = Math.max(vMin, gear > 1 ? bounds[gear - 2] : vMin);
    const hi = bounds[gear - 1];
    const inGear = hi > lo + 1e-4 ? Math.max(0, Math.min(1, (relSpeed - lo) / (hi - lo))) : 1;
    return PITCH_LO + inGear * (PITCH_HI - PITCH_LO);
  }

  update(car: Car | null, track: Track, grandstandDists: number[], field?: Iterable<Car>): void {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;

    if (!car) {
      this.engine?.out.gain.setTargetAtTime(0.0001, t, 0.15);
      this.rival?.out.gain.setTargetAtTime(0.0001, t, 0.15);
      this.setCrowd(false, t);
      return;
    }

    const { vMin, vMax } = CONFIG.profile;
    const rel = Math.max(0, Math.min(1, (car.relSpeed - vMin) / (vMax - vMin)));
    const slowing = car.relSpeed < this.prevRel - 0.0015;

    const bounds = track.gearBounds;
    let target = this.gear;
    while (target < GEARS && car.relSpeed >= bounds[target - 1] + SHIFT_HYST) target++;
    while (target > 1 && car.relSpeed < bounds[target - 2] - SHIFT_HYST) target--;
    if (target > this.gear) this.upshift(t);
    else if (target < this.gear) this.downshift(t, this.gear - target);
    this.gear = target;

    if (this.engine) {
      const e = this.engine;
      const hz = this.pitchFor(car.relSpeed, this.gear, track);
      // Revs fall fast on an upshift; a scalata's blips are layered on top.
      if (t >= this.blipUntil) this.drive(e, hz, t, 0.035);
      // On the throttle: open and loud. Lifting off: darker and quieter.
      e.filter.frequency.setTargetAtTime(slowing ? 1400 : 5200 + rel * 4000, t, slowing ? 0.04 : 0.12);
      e.out.gain.setTargetAtTime(slowing ? 0.28 : 0.45 + rel * 0.2, t, 0.06);
      if (slowing && t - this.lastPop > 0.09 && Math.random() < 0.35) {
        this.lastPop = t;
        this.pop(t);
      }
    }

    if (this.rival && field) this.updateRival(car, track, field, t);

    if (rel < BRAKE_REL_NORM && slowing && t - this.lastBrake > BRAKE_COOLDOWN) {
      this.lastBrake = t;
      this.squeal(t);
    }
    this.prevRel = car.relSpeed;

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

    if (car.overtakes > this.prevOvertakes && t - this.lastRadio > RADIO_COOLDOWN) {
      this.lastRadio = t;
      this.radioBlip();
    }
    this.prevOvertakes = car.overtakes;
  }

  /** The closest rival along the track, level by distance, doppler-shifted. */
  private updateRival(car: Car, track: Track, field: Iterable<Car>, t: number): void {
    const L = track.length;
    let best: Car | null = null;
    let bestD = Infinity;
    for (const o of field) {
      if (o === car) continue;
      let d = track.wrap(o.progress - car.progress);
      if (d > L / 2) d -= L; // signed: + ahead, − behind
      if (Math.abs(d) < Math.abs(bestD)) {
        bestD = d;
        best = o;
      }
    }
    const r = this.rival!;
    if (!best || Math.abs(bestD) > RIVAL_RANGE) {
      r.out.gain.setTargetAtTime(0.0001, t, 0.3);
      return;
    }
    const closeness = 1 - Math.abs(bestD) / RIVAL_RANGE;
    // Approaching (a faster car behind, or a slower one ahead) raises the pitch.
    const approach = bestD < 0 ? best.worldSpeed - car.worldSpeed : car.worldSpeed - best.worldSpeed;
    const doppler = SOUND_SPEED / (SOUND_SPEED - Math.max(-200, Math.min(200, approach)));
    const hz = this.pitchFor(best.relSpeed, gearAtSpeed(best.relSpeed, track.gearBounds), track) * doppler;
    this.drive(r, hz, t, 0.08);
    r.filter.frequency.setTargetAtTime(1800 + closeness * 4000, t, 0.1);
    r.out.gain.setTargetAtTime(0.02 + closeness * closeness * 0.22, t, 0.1);
    this.rivalPan.pan.setTargetAtTime(bestD > 0 ? 0.25 : -0.25, t, 0.2);
  }

  private setCrowd(on: boolean, t: number): void {
    const buf = this.buffers.get("crowd");
    if (!buf) return;
    if (!this.crowdSource) {
      const src = this.ctx!.createBufferSource();
      src.buffer = buf;
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

  /** Sampled tyre squeal: a random slice of the loop with a quick swell and decay. */
  private squeal(t: number): void {
    const buf = this.buffers.get("tyres");
    if (!buf) return;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.9 + Math.random() * 0.25;
    const g = ctx.createGain();
    const dur = 0.35 + Math.random() * 0.3;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(g).connect(this.master);
    src.start(t, Math.random() * (buf.duration - 1));
    src.stop(t + dur + 0.05);
  }

  /** Overrun crackle: a very short band-passed noise crack from the exhaust. */
  private pop(t: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 500 + Math.random() * 700;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 + Math.random() * 0.12, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.8);
    src.stop(t + 0.06);
  }

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
      g.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.1);
      o.connect(g).connect(filt);
      o.start(start);
      o.stop(start + 0.12);
    });
  }

  /** Upshift: ignition cut — a ~40 ms dip in the engine level plus a gearbox tick. */
  private upshift(t: number): void {
    const e = this.engine;
    if (e) {
      e.out.gain.cancelScheduledValues(t);
      e.out.gain.setValueAtTime(e.out.gain.value, t);
      e.out.gain.linearRampToValueAtTime(e.out.gain.value * 0.35, t + 0.012);
      e.out.gain.linearRampToValueAtTime(e.out.gain.value, t + 0.05);
    }
    this.tick(t, 2600, 0.12);
  }

  /**
   * Downshift scalata: one rev-matching throttle blip per gear dropped, spaced
   * out so a multi-gear drop into a hairpin sounds like "blap-blap-blap".
   */
  private downshift(t: number, drops: number): void {
    const e = this.engine;
    const n = Math.min(drops, GEARS);
    for (let i = 0; i < n; i++) {
      const start = t + i * DOWNSHIFT_GAP;
      this.tick(start, 2200, 0.08);
      if (!e || !this.specs) continue;
      const peak = PITCH_HI * (0.92 + i * 0.02);
      for (const [src, spec] of [[e.mid, this.specs.mid], [e.high, this.specs.high]] as const) {
        src.playbackRate.setTargetAtTime(peak / spec.pitch, start, 0.012);
        src.playbackRate.setTargetAtTime((PITCH_LO * 1.1) / spec.pitch, start + 0.035, 0.03);
      }
      e.out.gain.setTargetAtTime(0.5, start, 0.01);
    }
    this.blipUntil = t + n * DOWNSHIFT_GAP + 0.05;
  }

  private tick(t: number, freq: number, gain: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq;
    bp.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.8);
    src.stop(t + 0.05);
  }
}
