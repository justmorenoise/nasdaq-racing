"""Derive the synth engine's timbre and texture from the Goodwood F1 recordings.

For each source segment (a whole number of firing periods, see make_loops.py):
  * the harmonic spectrum (amplitude + phase of each multiple of the firing
    frequency) becomes a Web Audio PeriodicWave, so the synthesised note has
    the real engine's waveform at any pitch;
  * everything that is NOT harmonic (combustion roar, exhaust and mechanical
    noise) is kept as a seamless noise loop, pulsed at the firing frequency
    at runtime so it stays locked to the synthesised revs.
Writes public/audio/engine.json (harmonics) and engine_noise.wav.
"""
import json
import os
import wave

import numpy as np

SR = 44100
OUT = os.path.join("..", "..", "public", "audio")
HARMONICS = 48


def load(p):
    w = wave.open(p)
    return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768


def save(p, a):
    a = np.clip(a, -1, 1)
    w = wave.open(p, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((a * 32767).astype(np.int16).tobytes())
    w.close()


def f0_autocorr(seg, lo, hi):
    seg = seg - seg.mean()
    n = len(seg)
    spec = np.fft.rfft(seg, n * 2)
    ac = np.fft.irfft(spec * np.conj(spec))[:n]
    lags = np.arange(n)
    m = (lags > SR / hi) & (lags < SR / lo)
    lag = lags[m][np.argmax(ac[m])]
    y0, y1, y2 = ac[lag - 1], ac[lag], ac[lag + 1]
    return SR / (lag + 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2))


def analyse(src, t0, dur, lo, hi):
    a = load(src)
    seg = a[int(t0 * SR): int((t0 + dur + 0.2) * SR)]
    f0 = f0_autocorr(seg[: int(dur * SR)], lo, hi)
    periods = max(4, round(dur * f0))
    # Resample the chosen whole-period span to an exact integer length so each
    # harmonic lands on one FFT bin (bin k*periods).
    L = periods * SR / f0
    n = int(round(L))
    x = np.interp(np.linspace(0, L, n, endpoint=False), np.arange(len(seg)), seg)
    x = x - x.mean()
    X = np.fft.rfft(x)
    harm = []
    for k in range(1, HARMONICS + 1):
        b = k * periods
        if b >= len(X):
            harm.append((0.0, 0.0))
            continue
        harm.append((float(X[b].real), float(X[b].imag)))
    peak = max(np.hypot(r, i) for r, i in harm) or 1
    harm = [(round(r / peak, 5), round(i / peak, 5)) for r, i in harm]
    # Residual: remove the harmonic bins (±1) and keep the rest.
    R = X.copy()
    for k in range(1, len(X) // periods + 1):
        b = k * periods
        R[max(0, b - 1): b + 2] = 0
    R[:3] = 0
    noise = np.fft.irfft(R, n)
    return f0, periods, harm, noise


results = {}
noises = []
for name, src, t0, dur, lo, hi in [
    ("low", "fw32.wav", 13.5, 0.45, 330, 520),
    ("high", "f60.wav", 5.5, 0.6, 430, 620),
]:
    f0, periods, harm, noise = analyse(src, t0, dur, lo, hi)
    results[name] = {"f0": round(f0, 2), "real": [h[0] for h in harm], "imag": [h[1] for h in harm]}
    noise = noise / (np.sqrt((noise ** 2).mean()) + 1e-9) * 0.3
    noises.append((noise, f0))
    print(name, round(f0, 1), "Hz,", periods, "periods")

# Noise loop: the high-rev residual (circular, so it loops seamlessly),
# recorded at `noiseF0`.
loop, nf0 = noises[1]
save(os.path.join(OUT, "engine_noise.wav"), loop)
results["noiseF0"] = round(nf0, 2)
json.dump(results, open(os.path.join(OUT, "engine.json"), "w"))
print("wrote engine.json + engine_noise.wav", len(loop) / SR, "s")
