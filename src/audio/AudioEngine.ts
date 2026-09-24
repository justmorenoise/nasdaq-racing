import { CONFIG } from "../config";
import type { Car } from "../sim/Car";
import type { Track } from "../track/Track";
import { gearAtSpeed } from "../track/gearbox";
import crowdUrl from "../../circuits/crowd.mp3?url";

/**
 * Race audio for a SINGLE focused car (the leader in full view, the chased car
 * otherwise). The engine is synthesised — one continuous voice, so it stays
 * coherent across every gear and rev — but voiced with material taken from
 * real F1 recordings (public/audio/CREDITS.md, `_risorse/audio_src/make_engine.py`):
 *  - the oscillator's waveform is a PeriodicWave built from the harmonic
 *    spectrum of a Williams FW32 V8 at full throttle;
 *  - the non-harmonic residue of a Ferrari F60 launch (combustion roar,
 *    exhaust and mechanical noise) loops underneath, re-pitched with the revs
 *    and amplitude-pulsed at the firing frequency so it stays locked to the note;
 *  - a soft saturator and a low-pass that opens with revs and throttle.
 * Pitch follows the revs *within the current gear* of the circuit's 8-speed
 * box: it climbs to the redline, drops on each upshift (with an ignition-cut
 * dip) and jumps on each downshift, one throttle blip per gear in a scalata.
 * A second, quieter voice plays the nearest rival (doppler-shifted). Plus a
 * sampled tyre squeal, the crowd near the stands and a team-radio blip.
 */

const AUDIO_BASE = "audio/";
// Firing frequency per gear: just after an upshift and at the redline.
const ENGINE_MIN_HZ = 205;
const ENGINE_MAX_HZ = 520;
const BRAKE_REL_NORM = 0.32;
const BRAKE_COOLDOWN = 0.9;
const CROWD_WINDOW = 150;
const CROWD_FADE_IN = 1.0;
const CROWD_FADE_OUT = 1.8;
const CROWD_GAIN = 0.55;
const RADIO_COOLDOWN = 4;
const GEARS = 8;
const SHIFT_HYST = 0.006;
const DOWNSHIFT_GAP = 0.075;
const RIVAL_RANGE = 140;
const SOUND_SPEED = 620; // world units/s (≈ 343 m/s at the game's scale)

interface EngineSpec {
  low: { f0: number; real: number[]; imag: number[] };
  noiseF0: number;
}

/** One synthesised engine: tone + sub + pulsed real noise → saturator → filter. */
interface Voice {
  osc: OscillatorNode;
  sub: OscillatorNode;
  pulse: OscillatorNode;
  noise: AudioBufferSourceNode | null;
  noiseGain: GainNode;
  filter: BiquadFilterNode;
  out: GainNode;
}

function saturationCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return c;
}

export class AudioEngine {
  enabled = false;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private spec: EngineSpec | null = null;
  private wave: PeriodicWave | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private engine: Voice | null = null;
  private rival: Voice | null = null;
  private rivalPan!: StereoPannerNode;
  private whiteNoise!: AudioBuffer;
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
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(comp);

    const len = ctx.sampleRate;
    this.whiteNoise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.whiteNoise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0;
    this.crowdGain.connect(this.master);
    this.rivalPan = ctx.createStereoPanner();
    this.rivalPan.connect(this.master);

    // The engine starts right away with a plain waveform; the recorded timbre
    // and noise are swapped in as soon as they've loaded.
    this.engine = this.voice(this.master);
    this.rival = this.voice(this.rivalPan);
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
    const [spec, noise, crowd, tyres] = await Promise.all([
      fetch(AUDIO_BASE + "engine.json").then((r) => r.json() as Promise<EngineSpec>).catch(() => null),
      this.fetchBuffer(ctx, AUDIO_BASE + "engine_noise.wav"),
      this.fetchBuffer(ctx, crowdUrl),
      this.fetchBuffer(ctx, AUDIO_BASE + "tyres.wav"),
    ]);
    if (crowd) this.buffers.set("crowd", crowd);
    if (tyres) this.buffers.set("tyres", tyres);
    this.spec = spec;
    if (spec) {
      // DC term first; PeriodicWave normalises the overall level itself.
      const real = new Float32Array([0, ...spec.low.real]);
      const imag = new Float32Array([0, ...spec.low.imag]);
      this.wave = ctx.createPeriodicWave(real, imag);
      for (const v of [this.engine, this.rival]) v?.osc.setPeriodicWave(this.wave);
    }
    if (noise) {
      this.noiseBuf = noise;
      for (const v of [this.engine, this.rival]) if (v) this.attachNoise(v);
    }
  }

  private voice(dest: AudioNode): Voice {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = 0.0001;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 3000;
    filter.Q.value = 0.9;
    const shaper = ctx.createWaveShaper();
    shaper.curve = saturationCurve(2.2);
    shaper.oversample = "2x";
    shaper.connect(filter).connect(out).connect(dest);

    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = ENGINE_MIN_HZ;
    const toneGain = ctx.createGain();
    toneGain.gain.value = 0.55;
    osc.connect(toneGain).connect(shaper);

    const sub = ctx.createOscillator();
    sub.type = "triangle";
    sub.frequency.value = ENGINE_MIN_HZ / 2;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.22;
    sub.connect(subGain).connect(shaper);

    // Real noise, amplitude-pulsed at the firing frequency: base level plus a
    // sine at the engine frequency feeding the gain param (audio-rate AM).
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.35;
    noiseGain.connect(shaper);
    const pulse = ctx.createOscillator();
    pulse.frequency.value = ENGINE_MIN_HZ;
    const depth = ctx.createGain();
    depth.gain.value = 0.3;
    pulse.connect(depth).connect(noiseGain.gain);

    osc.start();
    sub.start();
    pulse.start();
    return { osc, sub, pulse, noise: null, noiseGain, filter, out };
  }

  private attachNoise(v: Voice): void {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.connect(v.noiseGain);
    src.start(0, Math.random() * this.noiseBuf!.duration);
    v.noise = src;
  }

  /** Point a voice at a firing frequency. */
  private drive(v: Voice, hz: number, t: number, tc: number): void {
    v.osc.frequency.setTargetAtTime(hz, t, tc);
    v.sub.frequency.setTargetAtTime(hz / 2, t, tc);
    v.pulse.frequency.setTargetAtTime(hz, t, tc);
    // Noise was recorded at noiseF0; its spectrum rides up and down with the revs.
    if (v.noise && this.spec) v.noise.playbackRate.setTargetAtTime(Math.max(0.35, (hz / this.spec.noiseF0) * 1.25), t, tc);
  }

  /** Firing frequency for revs within the gear. */
  private hzFor(relSpeed: number, gear: number, track: Track): { hz: number; inGear: number } {
    const { vMin } = CONFIG.profile;
    const bounds = track.gearBounds;
    const lo = Math.max(vMin, gear > 1 ? bounds[gear - 2] : vMin);
    const hi = bounds[gear - 1];
    const inGear = hi > lo + 1e-4 ? Math.max(0, Math.min(1, (relSpeed - lo) / (hi - lo))) : 1;
    return { hz: ENGINE_MIN_HZ + inGear * (ENGINE_MAX_HZ - ENGINE_MIN_HZ), inGear };
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

    const e = this.engine!;
    const { hz, inGear } = this.hzFor(car.relSpeed, this.gear, track);
    if (t >= this.blipUntil) this.drive(e, hz, t, 0.03);
    // On the throttle: open, loud, more roar. Lifting off: darker, quieter,
    // with overrun crackle.
    e.filter.frequency.setTargetAtTime(slowing ? 1100 : 1800 + inGear * 3200 + rel * 1200, t, slowing ? 0.05 : 0.1);
    e.noiseGain.gain.setTargetAtTime(slowing ? 0.18 : 0.3 + inGear * 0.25, t, 0.08);
    e.out.gain.setTargetAtTime(slowing ? 0.07 : 0.1 + inGear * 0.08, t, 0.06);
    if (slowing && t - this.lastPop > 0.09 && Math.random() < 0.3) {
      this.lastPop = t;
      this.pop(t);
    }

    if (field) this.updateRival(car, track, field, t);

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
      if (d > L / 2) d -= L;
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
    const approach = bestD < 0 ? best.worldSpeed - car.worldSpeed : car.worldSpeed - best.worldSpeed;
    const doppler = SOUND_SPEED / (SOUND_SPEED - Math.max(-200, Math.min(200, approach)));
    const { hz } = this.hzFor(best.relSpeed, gearAtSpeed(best.relSpeed, track.gearBounds), track);
    this.drive(r, hz * doppler, t, 0.08);
    r.filter.frequency.setTargetAtTime(900 + closeness * 2600, t, 0.1);
    r.out.gain.setTargetAtTime(0.005 + closeness * closeness * 0.06, t, 0.1);
    this.rivalPan.pan.setTargetAtTime(bestD > 0 ? 0.3 : -0.3, t, 0.2);
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
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(g).connect(this.master);
    src.start(t, Math.random() * (buf.duration - 1));
    src.stop(t + dur + 0.05);
  }

  /** Overrun crackle: a very short band-passed crack from the exhaust. */
  private pop(t: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf ?? this.whiteNoise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 450 + Math.random() * 600;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14 + Math.random() * 0.1, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.4);
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

  /** Upshift: ~40 ms ignition cut on the engine voice plus a gearbox tick. */
  private upshift(t: number): void {
    const g = this.engine!.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(g.value * 0.3, t + 0.012);
    g.linearRampToValueAtTime(g.value, t + 0.05);
    this.tick(t, 2600, 0.1);
  }

  /**
   * Downshift scalata: the same engine voice blips its revs once per gear
   * dropped ("blap-blap-blap"), then settles on the new, higher revs.
   */
  private downshift(t: number, drops: number): void {
    const e = this.engine!;
    const n = Math.min(drops, GEARS);
    for (let i = 0; i < n; i++) {
      const start = t + i * DOWNSHIFT_GAP;
      this.tick(start, 2200, 0.07);
      const peak = ENGINE_MAX_HZ * (0.9 + i * 0.03);
      for (const p of [e.osc.frequency, e.pulse.frequency]) {
        p.setTargetAtTime(peak, start, 0.012);
        p.setTargetAtTime(ENGINE_MIN_HZ * 1.25, start + 0.035, 0.03);
      }
      e.sub.frequency.setTargetAtTime(peak / 2, start, 0.012);
      e.sub.frequency.setTargetAtTime((ENGINE_MIN_HZ * 1.25) / 2, start + 0.035, 0.03);
      e.noiseGain.gain.setTargetAtTime(0.6, start, 0.01);
    }
    this.blipUntil = t + n * DOWNSHIFT_GAP + 0.05;
  }

  private tick(t: number, freq: number, gain: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.whiteNoise;
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
