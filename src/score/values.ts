/**
 * A control's value as overrides write it, and as the performer reads it.
 *
 * Written, a value is:
 * - a level 0–1, or a dynamic mark (`ppp` … `fff`);
 * - keyframes `[[0, 0.2], [0.7, 0.9], [1, 0.6]]`: [where, level], `where` running 0–1 over the note (or the span the
 *   override picked, cascade.ts), straight between them;
 * - a shape `{ from, to, ease, delay }`: from `from`, held until `delay` (0–1), then to `to`, eased `linear`, `in`,
 *   `out` or `inout`.
 *
 * Resolved, it's keyframes in beats, held flat before the first and after the last.
 */
export type Level = number | string;
export type Ease = "linear" | "in" | "out" | "inout";
export type Written = Level | [number, Level][] | { from: Level; to: Level; ease?: Ease; delay?: number };
export type Value = [number, number][];

export const MARKS: Record<string, number> = { ppp: 0.08, pp: 0.2, p: 0.33, mp: 0.45, mf: 0.58, f: 0.72, ff: 0.86, fff: 1 };

export function level(v: Level): number {
  const n = typeof v === "string" ? MARKS[v] : v;
  if (typeof n !== "number" || !(n >= 0 && n <= 1)) throw new Error(`a level is 0–1 or ${Object.keys(MARKS).join("/")}, not ${JSON.stringify(v)}`);
  return n;
}

const EASE: Record<Ease, (x: number) => number> = {
  linear: (x) => x,
  in: (x) => x * x,
  out: (x) => 1 - (1 - x) * (1 - x),
  inout: (x) => (x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x)),
};

/** A written value over beats `t0`–`t1`. */
export function resolve(w: Written, t0: number, t1: number): Value {
  const span = t1 - t0;
  if (typeof w === "number" || typeof w === "string") return [[t0, level(w)]];
  if (Array.isArray(w)) {
    if (!w.length) throw new Error("keyframes can't be empty");
    let last = -Infinity;
    return w.map(([f, v]) => {
      if (!(f >= 0 && f <= 1) || f < last) throw new Error(`keyframes run 0–1 in order: ${JSON.stringify(w)}`);
      last = f;
      return [t0 + f * span, level(v)];
    });
  }
  if (w && typeof w === "object" && "from" in w && "to" in w) {
    const a = level(w.from);
    const b = level(w.to);
    const d = w.delay ?? 0;
    const ease = EASE[w.ease ?? "linear"];
    if (!ease) throw new Error(`no ease "${w.ease}" (${Object.keys(EASE).join(", ")})`);
    const steps = w.ease && w.ease !== "linear" ? 8 : 1;
    const out: Value = [[t0, a]];
    if (d > 0) out.push([t0 + d * span, a]);
    for (let k = 1; k <= steps; k++) out.push([t0 + (d + ((1 - d) * k) / steps) * span, a + (b - a) * ease(k / steps)]);
    return out;
  }
  throw new Error(`can't read the value ${JSON.stringify(w)}`);
}

/** The value at beat `t`. */
export function valueAt(v: Value, t: number): number {
  if (t <= v[0][0]) return v[0][1];
  for (let k = 1; k < v.length; k++) {
    const [t1, b] = v[k];
    if (t <= t1) {
      const [t0, a] = v[k - 1];
      return t1 === t0 ? b : a + ((b - a) * (t - t0)) / (t1 - t0);
    }
  }
  return v[v.length - 1][1];
}

export const isFlat = (v: Value): boolean => v.every(([, x]) => x === v[0][1]);
