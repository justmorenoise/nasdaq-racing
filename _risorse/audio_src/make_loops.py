"""Cut seamless engine loops from the CC BY-SA Goodwood recordings.

Each loop is a whole number of engine firing periods with its tail
cross-faded into its head, so an AudioBufferSourceNode can loop it with no
click. Native fundamental frequencies go to engine.json for pitch mapping.
"""
import json, wave, numpy as np, os

OUT = os.path.join("..", "..", "public", "audio")
os.makedirs(OUT, exist_ok=True)
SR = 44100

def load(p):
    w = wave.open(p)
    a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    return a

def save(p, a):
    a = np.clip(a, -1, 1)
    w = wave.open(p, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((a * 32767).astype(np.int16).tobytes()); w.close()

def autocorr_f0(seg, lo, hi):
    seg = seg - seg.mean()
    n = len(seg)
    spec = np.fft.rfft(seg, n * 2)
    ac = np.fft.irfft(spec * np.conj(spec))[:n]
    lags = np.arange(n)
    m = (lags > SR / hi) & (lags < SR / lo)
    lag = lags[m][np.argmax(ac[m])]
    # Parabolic refinement of the peak.
    y0, y1, y2 = ac[lag - 1], ac[lag], ac[lag + 1]
    lag = lag + 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2)
    return SR / lag

def hps_pitch(seg, lo, hi):
    """Perceived pitch (harmonic product spectrum), for matching layers."""
    n = len(seg)
    spec = np.abs(np.fft.rfft(seg * np.hanning(n), n * 4))
    freqs = np.fft.rfftfreq(n * 4, 1 / SR)
    hps = spec.copy()
    for h in (2, 3):
        d = spec[::h]
        hps[: len(d)] *= d
    m = (freqs > lo) & (freqs < hi)
    return float(freqs[m][np.argmax(hps[m])])

def make(name, src, t0, dur, lo, hi, xfade=0.06):
    a = load(src)
    i0 = int(t0 * SR)
    seg = a[i0:i0 + int((dur + xfade + 0.1) * SR)]
    f0 = autocorr_f0(seg[: int(dur * SR)], lo, hi)
    periods = max(1, round(dur * f0))
    L = int(round(periods * SR / f0))
    X = int(xfade * SR)
    body = seg[:L].copy()
    tail = seg[L:L + X]
    t = np.linspace(0, np.pi / 2, X)
    body[:X] = body[:X] * np.sin(t) + tail * np.cos(t)
    # Gentle high-pass (remove wind rumble) and loudness normalisation.
    body = body - np.convolve(body, np.ones(64) / 64, mode="same")
    body *= 0.35 / (np.sqrt((body ** 2).mean()) + 1e-9)
    save(os.path.join(OUT, f"{name}.wav"), body)
    pitch = hps_pitch(body, lo, hi * 1.3)
    return {"file": f"{name}.wav", "pitch": round(pitch, 1), "seconds": round(L / SR, 3)}

manifest = {
    "mid": make("engine_mid", "fw32.wav", 13.55, 0.35, 330, 520),
    "high": make("engine_high", "f60.wav", 5.55, 0.5, 430, 620),
}
print(json.dumps(manifest, indent=1))
json.dump(manifest, open(os.path.join(OUT, "engine.json"), "w"), indent=1)
