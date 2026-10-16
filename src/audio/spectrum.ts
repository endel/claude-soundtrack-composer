/** Band levels, for checks that read a render's spectrum. */
import { SR, type Stereo } from "./wav.ts";

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const vr = re[b] * wr - im[b] * wi;
        const vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
      }
    }
  }
}

/** dB of the energy between each pair of `edges` (Hz), over the 2^n samples from `at` (s), both channels. */
export function bandLevels(s: Stereo, at: number, edges: number[], n = 65536): number[] {
  const out = edges.slice(1).map(() => 0);
  const a = Math.round(at * SR);
  for (const ch of [s.l, s.r]) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = (ch[a + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
    fft(re, im);
    for (let k = 1; k < n / 2; k++) {
      const f = (k * SR) / n;
      const b = edges.findIndex((e, i) => i < edges.length - 1 && f >= e && f < edges[i + 1]);
      if (b >= 0) out[b] += re[k] ** 2 + im[k] ** 2;
    }
  }
  return out.map((e) => 10 * Math.log10(e + 1e-30));
}
