/**
 * Mastering the mixdown: brought to an integrated loudness (BS.1770, gated: blocks under −70 LUFS, then under 10 LU
 * below the mean, don't count), its peaks held under a ceiling by a look-ahead limiter, so a timpani stroke doesn't
 * set the level of a whole song.
 */
import { kWeight } from "./loudness.ts";
import { SR, type Stereo } from "./wav.ts";

/** Integrated loudness (LUFS) of a stereo signal. */
export function integrated(s: Stereo): number {
  const k = { l: kWeight(s.l), r: kWeight(s.r) };
  const block = Math.round(0.4 * SR);
  const hop = Math.round(0.1 * SR);
  const z: number[] = [];
  for (let i = 0; i + block <= s.l.length; i += hop) {
    let e = 0;
    for (let j = i; j < i + block; j++) e += k.l[j] * k.l[j] + k.r[j] * k.r[j];
    z.push(e / block);
  }
  const lufs = (x: number) => -0.691 + 10 * Math.log10(x + 1e-20);
  const abs = z.filter((x) => lufs(x) > -70);
  if (!abs.length) return -Infinity;
  const mean = abs.reduce((a, x) => a + x, 0) / abs.length;
  const rel = abs.filter((x) => lufs(x) > lufs(mean) - 10);
  return lufs(rel.reduce((a, x) => a + x, 0) / rel.length);
}

export interface Mastered {
  /** LUFS before and after. */
  from: number;
  lufs: number;
  /** The most the limiter took off (dB). */
  limited: number;
}

/**
 * `s` brought to `lufs`, its peaks under `ceiling` dBFS (5 ms look-ahead, 80 ms release), in place. The limiter takes
 * loudness away as it works, so the gain is found over a few passes; it never limits by more than `squash` dB, and a
 * song that would need more comes out quieter.
 */
export function master(s: Stereo, lufs = -16, ceiling = -1, squash = 6): Mastered {
  const from = integrated(s);
  if (!Number.isFinite(from)) return { from, lufs: from, limited: 0 };
  const dry = { l: Float32Array.from(s.l), r: Float32Array.from(s.r) };
  let gain = lufs - from;
  let best: { out: Stereo; m: Mastered } | undefined;
  for (let pass = 0; pass < 4; pass++) {
    const out = { l: Float32Array.from(dry.l), r: Float32Array.from(dry.r) };
    const limited = limit(out, 10 ** (gain / 20), 10 ** (ceiling / 20));
    const m = { from: +from.toFixed(1), lufs: +integrated(out).toFixed(1), limited: +limited.toFixed(1) };
    if (limited > squash) { gain -= limited - squash; if (!best) best = { out, m }; continue; }
    best = { out, m };
    if (Math.abs(m.lufs - lufs) < 0.3) break;
    gain += lufs - m.lufs;
  }
  s.l.set(best!.out.l);
  s.r.set(best!.out.r);
  return best!.m;
}

/** `s` times `g`, its peaks held under `cap`, in place; the most it took off (dB). */
function limit(s: Stereo, g: number, cap: number): number {
  const n = s.l.length;
  const w = Math.round(0.005 * SR);
  const release = Math.exp(-1 / (0.08 * SR));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = Math.max(Math.abs(s.l[i]), Math.abs(s.r[i])) * g;
    need[i] = p > cap ? cap / p : 1;
  }
  // the least gain needed over the next w samples, averaged over the last w: a ramp that reaches each peak's gain at it
  const least = new Float32Array(n);
  const q: number[] = [];
  let head = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (q.length > head && need[q[q.length - 1]] >= need[i]) q.pop();
    q.push(i);
    while (q[head] > i + w) head++;
    least[i] = need[q[head]];
  }
  // the window starts full of unity gain
  let sum = w;
  let cur = 1;
  let worst = 1;
  for (let i = 0; i < n; i++) {
    sum += least[i] - (i >= w ? least[i - w] : 1);
    const ramp = sum / w;
    cur = ramp < cur ? ramp : cur + (1 - release) * (ramp - cur);
    if (cur < worst) worst = cur;
    s.l[i] *= g * cur;
    s.r[i] *= g * cur;
  }
  return -20 * Math.log10(worst);
}
