/**
 * Loudness as ITU-R BS.1770 hears it: K-weighted (a shelf lifting the presence over 1.7 kHz, a high-pass at 38 Hz),
 * so a tuba and a flute that measure alike sound alike. The level counts only the 50 ms blocks where the stem
 * sounds (over −70 dBFS unweighted), so a part's rests don't lower it.
 */
import { SR, type Stereo } from "./wav.ts";

type Biquad = [number, number, number, number, number];

function shelf(f0: number, gain: number, q: number): Biquad {
  const A = 10 ** (gain / 40), w = (2 * Math.PI * f0) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q), r = 2 * Math.sqrt(A) * al;
  const a0 = A + 1 - (A - 1) * c + r;
  return [(A * (A + 1 + (A - 1) * c + r)) / a0, (-2 * A * (A - 1 + (A + 1) * c)) / a0, (A * (A + 1 + (A - 1) * c - r)) / a0, (2 * (A - 1 - (A + 1) * c)) / a0, (A + 1 - (A - 1) * c - r) / a0];
}

function highpass(f0: number, q: number): Biquad {
  const w = (2 * Math.PI * f0) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  return [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0];
}

const STAGES = [shelf(1681.974450955533, 3.999843853973347, 0.7071752369554196), highpass(38.13547087602444, 0.5003270373238773)];

export function kWeight(x: Float32Array): Float32Array {
  let y = Float32Array.from(x);
  for (const [b0, b1, b2, a1, a2] of STAGES) {
    const out = new Float32Array(y.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = y[i]; y2 = y1; y1 = v;
      out[i] = v;
    }
    y = out;
  }
  return y;
}

const BLOCK = Math.round(0.05 * SR);

/** A stem's loudness (LUFS) between `a` and `b` seconds while it sounds, and for how long it sounds there. */
export function loudness(s: Stereo, k: Stereo, a: number, b: number): { lufs: number; seconds: number } {
  let e = 0;
  let n = 0;
  for (let i = Math.max(0, Math.round(a * SR)); i + BLOCK <= Math.min(s.l.length, Math.round(b * SR)); i += BLOCK) {
    let raw = 0;
    let kw = 0;
    for (let j = i; j < i + BLOCK; j++) { raw += s.l[j] * s.l[j] + s.r[j] * s.r[j]; kw += k.l[j] * k.l[j] + k.r[j] * k.r[j]; }
    if (raw / (2 * BLOCK) < 1e-7) continue;
    e += kw / BLOCK;
    n++;
  }
  return { lufs: n ? -0.691 + 10 * Math.log10(e / n + 1e-20) : -Infinity, seconds: (n * BLOCK) / SR };
}
