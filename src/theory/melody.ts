/**
 * Melody: themes the plan writes in scale degrees, developed and fitted to the harmony under them, and the lines the
 * engine writes itself: an answer to a theme, a counter-melody against another part.
 *
 * A theme is tokens laid end to end, `<degree>:<beats>`: `1:1 b2:1/2 1:1/2 5:2 | b6:4`. A degree counts in the key
 * (harmony.ts); `'` after it lifts it an octave, `,` drops it one (`5,` the fifth under the tonic); `r` rests. After
 * the length, `>` accents the note and `?` softens it; `@<vel>` and `!<artic>` set its own. Bar lines are only for
 * reading.
 *
 * A melody part plays statements end to end (`line`):
 * - a theme's name, then what's done to it: `+2` two degrees higher (a sequence; `-1`; `+3s` three semitones),
 *   `inv` upside down (around its first note), `rev` backwards, `x2` twice as slow (`x1.5`, `/2` twice as fast),
 *   `[4-8]` only its beats 4 to 8, `vary=0.4` ornamented (passing and neighbour notes, dotted rhythms, turns, drawn
 *   from the seed), `end=1` ending on that degree, `fit=no` played exactly as written;
 * - `gen <bars> [rise|fall|arch|valley|wave|flat] [from=<theme>] [end=<degree>]`: a phrase the engine writes in a
 *   theme's rhythm (the last one played, by default), shaped by the contour and the chords;
 * - `rest <bars>`, or a theme written in place (`5:2 4:1 3:1`).
 *
 * Fitted, a note on a strong beat (or held 1.5 beats or longer) is a tone of the chord under it, the nearest one; a
 * note between strong beats is in the key and a step from a neighbour. A degree written with an accidental, and a
 * theme moved by semitones, are meant as they are, and kept.
 */
import { degreeSemis, inKey, isChordTone, parseDegree, type Chord, type Key } from "./harmony.ts";
import { weight } from "./rhythm.ts";

export interface Ev {
  pitch: number | string;
  at: number;
  len: number;
  vel?: number;
  artic?: string;
  /** −1 soft, 0, 1 accented. */
  accent: number;
}

/** What's sounding where: the key, the chord, the meter and how loud the music is at a beat. */
export interface Context {
  key(at: number): Key;
  chord(at: number): Chord;
  meter(at: number): [number, number];
  /** The first beat of the bar a beat falls in. */
  bar(at: number): number;
  /** 0–1 */
  level(at: number): number;
}

export type Rng = () => number;

/** Draws 0–1, the same for the same label on every build. */
export function rng(label: string): Rng {
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ThemeNote {
  /** Degrees above the tonic from 0, octaves counted (7 is the tonic an octave up); null rests. */
  deg: number | null;
  acc: number;
  /** Semitones it's moved by, past the key. */
  shift: number;
  at: number;
  len: number;
  accent: number;
  vel?: number;
  artic?: string;
}

const fraction = (s: string): number => {
  const m = s.match(/^(\d+(?:\.\d+)?)(?:\/(\d+))?$/);
  if (!m) throw new Error(`not a length: "${s}"`);
  return Number(m[1]) / (m[2] ? Number(m[2]) : 1);
};

export function parseTheme(src: string): ThemeNote[] {
  const out: ThemeNote[] = [];
  let at = 0;
  for (const tok of src.split(/\s+/).filter((t) => t && t !== "|")) {
    const m = tok.match(/^(r|[b#]*\d+)(['’,]*):([\d./]+)([>?])?(?:@(\d+))?(?:!([\w-]+))?$/);
    if (!m) throw new Error(`can't read "${tok}" in the theme "${src}"`);
    const len = fraction(m[3]);
    const accent = m[4] === ">" ? 1 : m[4] === "?" ? -1 : 0;
    if (m[1] === "r") out.push({ deg: null, acc: 0, shift: 0, at, len, accent });
    else {
      const [i, acc] = parseDegree(m[1]);
      const oct = [...m[2]].reduce((a, c) => a + (c === "," ? -7 : 7), 0);
      out.push({ deg: i + oct, acc, shift: 0, at, len, accent, vel: m[5] ? Number(m[5]) : undefined, artic: m[6] });
    }
    at += len;
  }
  return out;
}

export const themeLen = (t: ThemeNote[]): number => t.reduce((a, n) => Math.max(a, n.at + n.len), 0);

/** Ornaments drawn from `r`: passing notes through a third, neighbours between repeats, dotted pairs, turns. */
function vary(t: ThemeNote[], amount: number, r: Rng): ThemeNote[] {
  const out: ThemeNote[] = [];
  for (let i = 0; i < t.length; i++) {
    const n = t[i];
    const next = t[i + 1];
    const x = r();
    if (n.deg !== null && next?.deg != null && n.len >= 1 && Math.abs(next.deg - n.deg) === 2 && x < amount) {
      out.push({ ...n, len: n.len / 2 }, { ...n, deg: n.deg + Math.sign(next.deg - n.deg), acc: 0, at: n.at + n.len / 2, len: n.len / 2, accent: 0, vel: undefined });
    } else if (n.deg !== null && next?.deg === n.deg && n.len >= 1 && x < amount * 0.6) {
      out.push({ ...n, len: n.len / 2 }, { ...n, deg: n.deg + (r() < 0.5 ? 1 : -1), acc: 0, at: n.at + n.len / 2, len: n.len / 2, accent: 0, vel: undefined });
    } else if (n.deg !== null && next?.deg != null && n.len === next.len && n.len <= 1 && n.len >= 1 / 2 && next.at === n.at + n.len && x < amount * 0.35 && (n.at / n.len) % 2 === 0) {
      out.push({ ...n, len: n.len * 1.5 }, { ...next, at: n.at + n.len * 1.5, len: n.len / 2 });
      i++;
    } else if (n.deg !== null && next?.deg != null && n.len >= 2 && x < amount * 0.5) {
      // a long note turns into the next: its last half beat the note above, then itself
      const turn = 0.5;
      out.push({ ...n, len: n.len - turn }, { ...n, deg: n.deg + 1, acc: 0, at: n.at + n.len - turn, len: turn / 2, accent: 0, vel: undefined }, { ...n, at: n.at + n.len - turn / 2, len: turn / 2, accent: 0, vel: undefined });
    } else out.push(n);
  }
  return out;
}

/** A theme with a statement's operations done to it (`+2 inv x2 [0-4] vary=0.3 end=1`); `fit` says if it's fitted. */
export function develop(theme: ThemeNote[], ops: string[], r: Rng): { notes: ThemeNote[]; fit: boolean } {
  let t = theme.map((n) => ({ ...n }));
  let fit = true;
  for (const op of ops) {
    let m: RegExpMatchArray | null;
    if ((m = op.match(/^([+-]\d+)$/))) t = t.map((n) => (n.deg === null ? n : { ...n, deg: n.deg + Number(m![1]) }));
    else if ((m = op.match(/^([+-]\d+)s$/))) t = t.map((n) => (n.deg === null ? n : { ...n, shift: n.shift + Number(m![1]) }));
    else if (op === "inv") {
      const pivot = t.find((n) => n.deg !== null)?.deg ?? 0;
      t = t.map((n) => (n.deg === null ? n : { ...n, deg: 2 * pivot - n.deg, acc: -n.acc }));
    } else if (op === "rev") {
      const L = themeLen(t);
      t = t.map((n) => ({ ...n, at: L - n.at - n.len })).sort((a, b) => a.at - b.at);
    } else if ((m = op.match(/^x(\d+(?:\.\d+)?)$/))) t = t.map((n) => ({ ...n, at: n.at * Number(m![1]), len: n.len * Number(m![1]) }));
    else if ((m = op.match(/^\/(\d+(?:\.\d+)?)$/))) t = t.map((n) => ({ ...n, at: n.at / Number(m![1]), len: n.len / Number(m![1]) }));
    else if ((m = op.match(/^\[(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\]$/))) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      t = t.filter((n) => n.at >= a - 1e-6 && n.at < b - 1e-6).map((n) => ({ ...n, at: n.at - a, len: Math.min(n.len, b - n.at) }));
    } else if ((m = op.match(/^vary=(\d*\.?\d+)$/))) t = vary(t, Number(m[1]), r);
    else if ((m = op.match(/^end=([b#]*\d+)$/))) {
      const [want] = parseDegree(m[1]);
      const last = t.findLast((n) => n.deg !== null);
      if (last) {
        const d = last.deg!;
        const below = d - ((((d - want) % 7) + 7) % 7);
        last.deg = d - below <= below + 7 - d ? below : below + 7;
        last.acc = 0;
      }
    } else if (op === "fit=no") fit = false;
    else throw new Error(`can't read "${op}": +n, -n, +ns, inv, rev, xN, /N, [a-b], vary=n, end=<degree>, fit=no`);
  }
  if (!t.length) throw new Error(`"${ops.join(" ")}" leaves no notes`);
  return { notes: t, fit };
}

/** Its pitches, the tonic at MIDI `tonic`, placed from beat `at0`; `kept` marks the ones meant chromatic. */
export function realize(t: ThemeNote[], key: Key, tonic: number, at0: number): { evs: Ev[]; kept: boolean[] } {
  const evs: Ev[] = [];
  const kept: boolean[] = [];
  for (const n of t) {
    if (n.deg === null) continue;
    evs.push({ pitch: tonic + degreeSemis(key, n.deg, n.acc) + n.shift, at: at0 + n.at, len: n.len, accent: n.accent, vel: n.vel, artic: n.artic });
    kept.push(n.acc !== 0 || n.shift !== 0);
  }
  return { evs, kept };
}

const strongAt = (ctx: Context, at: number, len: number): boolean => weight(at - ctx.bar(at), ctx.meter(at)) > 0 || len >= 1.5;

/** The chord tone (or key tone) nearest `p`, leaning toward `toward` when two are as near. */
function snap(p: number, ok: (q: number) => boolean, toward: number): number {
  for (let d = 0; d <= 7; d++) {
    const a = p + d;
    const b = p - d;
    const okA = ok(a);
    const okB = ok(b);
    if (okA && okB) return Math.abs(a - toward) <= Math.abs(b - toward) ? a : b;
    if (okA) return a;
    if (okB) return b;
  }
  return p;
}

/** Notes moved onto the harmony: chord tones on strong beats, steps in the key between them. */
export function fit(evs: Ev[], kept: boolean[], ctx: Context): number {
  let moved = 0;
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    if (kept[i] || typeof e.pitch !== "number") continue;
    const c = ctx.chord(e.at);
    const k = ctx.key(e.at);
    const p = e.pitch;
    const prev = evs[i - 1]?.pitch as number | undefined;
    const next = evs[i + 1]?.pitch as number | undefined;
    const toward = next ?? prev ?? p;
    let q = p;
    if (isChordTone(c, p)) q = p;
    else if (strongAt(ctx, e.at, e.len)) q = snap(p, (x) => isChordTone(c, x), toward);
    else {
      q = inKey(k, p) ? p : snap(p, (x) => inKey(k, x), toward);
      // a tone outside the chord has to be a step from a neighbour, passing or turning
      const stepwise = (prev !== undefined && Math.abs(q - prev) <= 2) || (next !== undefined && Math.abs(next - q) <= 2);
      if (!isChordTone(c, q) && !stepwise) q = snap(q, (x) => isChordTone(c, x), toward);
    }
    if (q !== p) { e.pitch = q; moved++; }
  }
  return moved;
}

const CONTOURS: Record<string, (x: number) => number> = {
  rise: (x) => x,
  fall: (x) => -x,
  arch: (x) => Math.sin(Math.PI * x),
  valley: (x) => -Math.sin(Math.PI * x),
  wave: (x) => Math.sin(2 * Math.PI * x) * 0.6,
  flat: () => 0,
};
export const CONTOUR_NAMES = Object.keys(CONTOURS);

const leapCost = (d: number): number => [1.2, 0, 0, 0.7, 0.9, 1.5, 5, 1.9, 3.2, 3.4, 5, 6, 4][Math.min(12, d)] + (d > 12 ? 8 : 0);

export interface GenOpts {
  /** Its rhythm: a theme's notes, cycled to fill the phrase. */
  rhythm: ThemeNote[];
  bars: number;
  barBeats: number;
  contour: string;
  /** Where it starts from: the last pitch before, or the middle of its range. */
  from: number;
  range: [number, number];
  /** A degree to end on (from 0), else the chord's root or third. */
  end?: number;
}

/** A phrase written by the engine: steps and small leaps, a leap answered by a step back, chord tones where they count. */
export function generate(at0: number, o: GenOpts, ctx: Context, r: Rng): Ev[] {
  const span = o.bars * o.barBeats;
  const L = themeLen(o.rhythm);
  if (L <= 0) throw new Error("gen: the rhythm it's given is empty");
  const slots: ThemeNote[] = [];
  for (let off = 0; off < span - 1e-6; off += L) {
    for (const n of o.rhythm) if (off + n.at < span - 1e-6) slots.push({ ...n, at: off + n.at, len: Math.min(n.len, span - off - n.at) });
  }
  const pitched = slots.filter((s) => s.deg !== null);
  const shape = CONTOURS[o.contour];
  if (!shape) throw new Error(`no contour "${o.contour}" (${CONTOUR_NAMES.join(", ")})`);
  const [lo, hi] = o.range;
  const p0 = Math.max(lo, Math.min(hi, o.from));
  const amp = 7;
  let p = p0;
  let lastLeap = 0;
  let repeats = 0;
  const out: Ev[] = [];
  pitched.forEach((s, j) => {
    const at = at0 + s.at;
    const c = ctx.chord(at);
    const k = ctx.key(at);
    const x = pitched.length > 1 ? j / (pitched.length - 1) : 1;
    const target = Math.max(lo + 2, Math.min(hi - 2, p0 + amp * shape(x)));
    const last = j === pitched.length - 1;
    const strong = strongAt(ctx, at, s.len) || last;
    let best = p;
    let bestCost = Infinity;
    const endPc = last && o.end !== undefined ? (k.tonic + degreeSemis(k, o.end)) % 12 : undefined;
    for (let q = Math.max(lo, p - 9); q <= Math.min(hi, p + 9); q++) {
      if (!inKey(k, q) && !isChordTone(c, q)) continue;
      const tone = isChordTone(c, q);
      // an ending asked for wins over the chord under it
      if (endPc !== undefined ? ((q % 12) + 12) % 12 !== endPc : strong && !tone) continue;
      const d = q - p;
      let cost = leapCost(Math.abs(d)) + Math.abs(q - target) * 0.35;
      if (!tone && Math.abs(d) > 2) cost += 2.5;
      if (Math.abs(lastLeap) >= 5) cost += Math.sign(d) === Math.sign(lastLeap) ? 3 : Math.abs(d) <= 2 ? -0.8 : 0;
      if (d === 0 && repeats >= 1) cost += 2;
      if (last && endPc === undefined) cost += (((q - c.root) % 12) + 12) % 12 === 0 ? -1.5 : 0;
      cost += r() * 1.1;
      if (cost < bestCost) { bestCost = cost; best = q; }
    }
    repeats = best === p ? repeats + 1 : 0;
    lastLeap = best - p;
    p = best;
    out.push({ pitch: best, at, len: s.len, accent: s.accent });
  });
  return out;
}

export interface CounterOpts {
  range: [number, number];
  /** Under the melody (the default when its range is lower), or over it. */
  below: boolean;
  /** Onsets in beats from the window's start, with lengths; by default half notes, quarters under a held note. */
  onsets?: { at: number; len: number; accent: number }[];
  from?: number;
}

const sounding = (evs: Ev[], at: number): Ev | undefined =>
  evs.findLast((e) => e.at <= at + 1e-6 && e.at + e.len > at + 1e-6) ?? evs.findLast((e) => e.at <= at + 1e-6);

/** The onsets a counter-line takes over `a`–`b` by default: moving where the melody holds, holding where it moves. */
export function counterOnsets(mel: Ev[], a: number, b: number, ctx: Context): { at: number; len: number; accent: number }[] {
  const out: { at: number; len: number; accent: number }[] = [];
  let t = a;
  while (t < b - 1e-6) {
    const m = sounding(mel, t);
    const held = m && m.at + m.len - t >= 2 - 1e-6;
    const barBeats = (ctx.meter(t)[0] * 4) / ctx.meter(t)[1];
    const unit = held ? 1 : barBeats % 2 === 0 ? 2 : barBeats;
    const len = Math.min(unit, b - t, ctx.bar(t) + barBeats - t);
    out.push({ at: t, len, accent: 0 });
    t += len;
  }
  return out;
}

/** A line against `mel`: thirds and sixths where it can, contrary motion, no parallel fifths or octaves. */
export function counter(mel: Ev[], a: number, b: number, o: CounterOpts, ctx: Context, r: Rng): Ev[] {
  const onsets = o.onsets ?? counterOnsets(mel, a, b, ctx);
  const [lo, hi] = o.range;
  let p = o.from ?? Math.round((lo + hi) / 2);
  let prevM: number | undefined;
  const out: Ev[] = [];
  for (const s of onsets) {
    const m = sounding(mel, s.at);
    const mp = typeof m?.pitch === "number" ? m.pitch : undefined;
    const c = ctx.chord(s.at);
    const k = ctx.key(s.at);
    const strong = strongAt(ctx, s.at, s.len);
    let best = p;
    let bestCost = Infinity;
    for (let q = Math.max(lo, p - 9); q <= Math.min(hi, p + 9); q++) {
      const tone = isChordTone(c, q);
      if (!tone && (strong || !inKey(k, q))) continue;
      let cost = leapCost(Math.abs(q - p)) * 0.8 + Math.abs(q - (lo + hi) / 2) * 0.06;
      if (!tone && Math.abs(q - p) > 2) cost += 3;
      if (mp !== undefined) {
        const gap = o.below ? mp - q : q - mp;
        if (gap < 3) continue;
        const iv = gap % 12;
        cost += [3, 5, 4, -1, -1, 1.5, 4, 0.2, -1, -1, 4, 5][iv];
        if (gap === 12 || gap === 24) cost += 0.3;
        if (gap > 19) cost += 2;
        if (prevM !== undefined && out.length) {
          const prevIv = (o.below ? prevM - p : p - prevM) % 12;
          const both = q !== p && Math.sign(q - p) === Math.sign(mp - prevM);
          if (both && prevIv === iv && (iv === 0 || iv === 7)) cost += 6;
          if (q !== p && mp !== prevM && Math.sign(q - p) === -Math.sign(mp - prevM)) cost -= 0.8;
        }
      }
      cost += r() * 0.6;
      if (cost < bestCost) { bestCost = cost; best = q; }
    }
    out.push({ pitch: best, at: s.at, len: s.len, accent: s.accent });
    p = best;
    prevM = mp;
  }
  return out;
}
