/**
 * Voice leading: a chord progression spread over voices (each its own range, top voice first), the way a part-writer
 * would: every voice moves as little as it can, none crosses another, the third and seventh are kept before the
 * fifth, the third and seventh aren't doubled, and two voices don't move in parallel fifths or octaves.
 */
import { isChordTone, type Chord } from "./harmony.ts";

export interface Range {
  lo: number;
  hi: number;
}

const pc = (n: number): number => ((n % 12) + 12) % 12;

/** What a voicing costs, moving from `prev` (none for the first). */
function cost(c: Chord, v: number[], prev: number[] | undefined, ranges: Range[]): number {
  let x = 0;
  const pcs = v.map(pc);
  const count = (p: number) => pcs.filter((q) => q === p).length;
  const third = c.ints.find((i) => [2, 3, 4, 5].includes(i % 12));
  const seventh = c.ints.length > 3 ? c.ints.find((i) => [9, 10, 11].includes(i % 12)) : undefined;
  const t = third === undefined ? -1 : pc(c.root + third);
  const s = seventh === undefined ? -1 : pc(c.root + seventh);
  if (t >= 0) x += count(t) === 0 ? 10 : count(t) > 1 ? 4 : 0;
  if (s >= 0) x += count(s) === 0 ? 6 : count(s) > 1 ? 8 : 0;
  if (!count(c.root)) x += 7;
  if (c.ints.includes(7) && !count(pc(c.root + 7))) x += 1;
  v.forEach((p, k) => {
    const mid = (ranges[k].lo + ranges[k].hi) / 2;
    x += Math.abs(p - mid) * 0.12;
  });
  if (prev) {
    for (let k = 0; k < v.length; k++) {
      const d = Math.abs(v[k] - prev[k]);
      x += d <= 2 ? d * 0.6 : d * 1.1;
    }
    for (let a = 0; a < v.length; a++) {
      for (let b = a + 1; b < v.length; b++) {
        const i0 = pc(prev[a] - prev[b]);
        const i1 = pc(v[a] - v[b]);
        const moved = v[a] !== prev[a] && Math.sign(v[a] - prev[a]) === Math.sign(v[b] - prev[b]);
        if (moved && i0 === i1 && (i1 === 0 || i1 === 7)) x += 9;
      }
    }
  }
  return x;
}

/**
 * One pitch per voice for each chord, voices listed top first. `start` places the first chord near the voices'
 * last pitches (from a section before).
 */
export function voiceLead(chords: Chord[], ranges: Range[], start?: number[]): number[][] {
  // voices sharing a register stay within an octave (the lowest within a twelfth); sections apart may stand apart
  const gap = ranges.map((r, k) => {
    if (k === 0) return Infinity;
    const shared = Math.min(ranges[k - 1].hi, r.hi) - Math.max(ranges[k - 1].lo, r.lo);
    return shared < 7 ? Infinity : k === ranges.length - 1 && ranges.length > 2 ? 19 : 12;
  });
  const out: number[][] = [];
  let prev = start;
  for (const c of chords) {
    let best: number[] | undefined;
    let bestCost = Infinity;
    const pick: number[] = [];
    const walk = (k: number) => {
      if (k === ranges.length) {
        const x = cost(c, pick, prev, ranges);
        if (x < bestCost - 1e-9) { bestCost = x; best = [...pick]; }
        return;
      }
      const { lo, hi } = ranges[k];
      const near = prev?.[k];
      for (let p = hi; p >= lo; p--) {
        if (!isChordTone(c, p)) continue;
        if (near !== undefined && Math.abs(p - near) > 7) continue;
        if (k > 0 && (p >= pick[k - 1] || pick[k - 1] - p > gap[k])) continue;
        pick[k] = p;
        walk(k + 1);
      }
    };
    walk(0);
    if (!best) {
      // too far to move in a step (a leap of register, a new range): place it afresh
      prev = undefined;
      walk(0);
    }
    if (!best) throw new Error(`can't voice ${c.symbol} over ${ranges.map((r) => `${r.lo}–${r.hi}`).join(", ")}`);
    out.push(best);
    prev = best;
  }
  return out;
}
