/**
 * Rhythms written as steps, the way a drum machine shows them: `X..x..x.x..x..x.`. The steps of one bar share it
 * evenly (16 steps in 4/4 are sixteenths); `|` starts the next bar of a longer pattern, which then cycles. Spaces are
 * only for reading.
 *
 * - `x` a hit, `X` an accented one, `o` a soft one (a ghost note);
 * - `-` holds the hit before it a step longer;
 * - `~` rolls: the step played as hits an eighth of a beat apart (a timpani or snare roll), `~` after `~` going on;
 * - `.` a rest.
 */

export interface Hit {
  /** Beats from the bar's start. */
  at: number;
  len: number;
  accent: number;
  roll: boolean;
}

const ROLL = 1 / 8;

/** The bars of a pattern, each its hits. */
export function grid(src: string, barBeats: number): Hit[][] {
  const bars = src.replace(/\s+/g, "").split("|").filter(Boolean);
  if (!bars.length) throw new Error(`an empty rhythm`);
  return bars.map((b) => {
    if (!/^[xXo.\-~]+$/.test(b)) throw new Error(`a rhythm is x X o - ~ . and |, not "${src}"`);
    const step = barBeats / b.length;
    const out: Hit[] = [];
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c === "-") {
        if (out.length && Math.abs(out[out.length - 1].at + out[out.length - 1].len - i * step) < 1e-6) out[out.length - 1].len += step;
        continue;
      }
      if (c === ".") continue;
      if (c === "~") {
        for (let t = 0; t < step - 1e-6; t += ROLL) out.push({ at: i * step + t, len: Math.min(ROLL, step - t), accent: 0, roll: true });
        continue;
      }
      out.push({ at: i * step, len: step, accent: c === "X" ? 1 : c === "o" ? -1 : 0, roll: false });
    }
    return out;
  });
}

/** The pattern's hits in bar `n` (its bars cycle). */
export const barOf = (bars: Hit[][], n: number): Hit[] => bars[((n % bars.length) + bars.length) % bars.length];

/** The strong beats after the downbeat, by meter (4/4 leans on its middle, 6/8 on its second dotted beat, 7/8 is 2+2+3). */
const STRONG: Record<string, number[]> = {
  "4/4": [2], "2/2": [2], "5/4": [3], "6/4": [3], "7/4": [4], "6/8": [1.5], "9/8": [1.5, 3], "12/8": [1.5, 3, 4.5], "7/8": [1, 2], "5/8": [1],
};

/** Where a beat sits in a bar: 2 on the downbeat, 1 on another strong beat, 0 off them. */
export function weight(at: number, meter: [number, number]): number {
  const barBeats = (meter[0] * 4) / meter[1];
  const x = ((at % barBeats) + barBeats) % barBeats;
  if (x < 1e-6 || barBeats - x < 1e-6) return 2;
  return (STRONG[`${meter[0]}/${meter[1]}`] ?? []).some((s) => Math.abs(s - x) < 1e-6) ? 1 : 0;
}

/** A length in beats as the score writes it: `1`, `1/2`, `3/2`, `1/3`. */
export function fmtLen(x: number): string {
  for (const d of [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48]) {
    const n = Math.round(x * d);
    if (Math.abs(n / d - x) < 1e-6) return d === 1 ? String(n) : `${n}/${d}`;
  }
  return String(+x.toFixed(6));
}
