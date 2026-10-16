/** Pitch tracking (YIN), for checks that read a note's pitch and its wobble from a render. */
import { SR, type Stereo } from "./wav.ts";

/** The pitch (Hz) frame by frame between `a` and `b` (s), searched between `lo` and `hi` Hz; NaN where unvoiced. */
export function f0Track(s: Stereo, a: number, b: number, lo: number, hi: number, frame = 2048, hop = 512): number[] {
  const tauMin = Math.floor(SR / hi);
  const tauMax = Math.ceil(SR / lo);
  const out: number[] = [];
  const c = new Float64Array(tauMax + 2);
  for (let i = Math.round(a * SR); i + frame + tauMax + 1 < Math.min(s.l.length, b * SR); i += hop) {
    // the cumulative mean normalized difference: dips to near 0 at the period
    let run = 0;
    c[0] = 1;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let d = 0;
      for (let j = 0; j < frame; j++) {
        const x = s.l[i + j] + s.r[i + j] - s.l[i + j + tau] - s.r[i + j + tau];
        d += x * x;
      }
      run += d;
      c[tau] = run > 0 ? (d * tau) / run : 1;
    }
    let best = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) if (c[tau] < 0.15) { best = tau; break; }
    if (best < 0) for (let tau = tauMin; tau <= tauMax; tau++) if (best < 0 || c[tau] < c[best]) best = tau;
    while (best < tauMax && c[best + 1] < c[best]) best++;
    if (c[best] > 0.4) { out.push(NaN); continue; }
    const den = c[best - 1] - 2 * c[best] + c[best + 1];
    out.push(SR / (den !== 0 ? best + (0.5 * (c[best - 1] - c[best + 1])) / den : best));
  }
  return out;
}

export const median = (xs: number[]): number => { const v = xs.filter(Number.isFinite).sort((p, q) => p - q); return v[Math.floor(v.length / 2)]; };

/** How far a pitch track strays from its median, in cents (RMS). */
export function wobble(f0: number[]): number {
  const m = median(f0);
  const c = f0.filter(Number.isFinite).map((f) => 1200 * Math.log2(f / m));
  return Math.sqrt(c.reduce((s, x) => s + x * x, 0) / Math.max(1, c.length));
}
