/**
 * Keys and chords as a plan names them, down to pitch classes (0 = C).
 *
 * A key is `<tonic> <mode>`: `C# minor`, `Eb dorian`, `F phrygian dominant`. Degrees count in the key's own scale,
 * and `b`/`#` move them: in E minor `3` is G, `b2` F, `#7` D#. An accidental the mode already has changes nothing,
 * so both habits read the same: in minor `b3`, `b6` and `b7` are its own third, sixth and seventh.
 *
 * A chord is a Roman numeral in the key or a chord symbol:
 * - numerals count the key's degrees the same way: in minor `VI` and `bVI` are both the flat sixth, `#vii°` the
 *   leading tone (`bII`, `#iv°`). Case gives the third (upper major, lower minor); then `°` diminished, `ø` half-diminished,
 *   `+` augmented, and a suffix: `7`, `maj7`, `9`, `6`, `add9`, `sus2`, `sus4`, `5` (no third), `b9`. In a key whose
 *   seventh lies a whole step under the tonic, `vii°` and `viiø` stand on the leading tone;
 * - `N` is the Neapolitan (`bII`); `It`, `Fr`, `Ger` the augmented sixths, on the flat sixth;
 * - `/3`, `/5`, `/7` put that chord tone in the bass; `/<numeral>` makes it applied (`V7/V`, `vii°/iv`);
 * - a symbol is absolute: `C#m`, `Ab`, `G7`, `Bbmaj7`, `F#dim7`, `Db/F`.
 */

export const MODES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
  melodic: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  "phrygian dominant": [0, 1, 4, 5, 7, 8, 10],
  "hungarian minor": [0, 2, 3, 6, 7, 8, 11],
};
const ALIAS: Record<string, string> = { ionian: "major", aeolian: "minor", "natural minor": "minor", "harmonic minor": "harmonic", "melodic minor": "melodic", hijaz: "phrygian dominant" };

const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const pc = (n: number): number => ((n % 12) + 12) % 12;

export interface Key {
  name: string;
  tonic: number;
  mode: string;
  /** Semitones above the tonic, one per degree. */
  scale: number[];
}

/** A note name's pitch class: `C#` 1, `Bb` 10. */
export function notePc(s: string): number {
  const m = s.match(/^([A-G])(#|b)?$/);
  if (!m) throw new Error(`not a note name: "${s}"`);
  return pc(LETTER[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0));
}

export function parseKey(s: string): Key {
  const m = s.trim().match(/^([A-G][#b]?)\s+(.+)$/);
  if (!m) throw new Error(`a key is "<tonic> <mode>" ("C# minor"), not "${s}"`);
  const mode = ALIAS[m[2].toLowerCase()] ?? m[2].toLowerCase();
  const scale = MODES[mode];
  if (!scale) throw new Error(`no mode "${m[2]}" (${[...Object.keys(MODES), ...Object.keys(ALIAS)].join(", ")})`);
  return { name: s.trim(), tonic: notePc(m[1]), mode, scale };
}

/** A degree written `5`, `b2`, `#4` as [index from 0, semitones moved]. */
export function parseDegree(s: string): [number, number] {
  const m = s.match(/^([b#]*)(\d+)$/);
  if (!m || Number(m[2]) < 1) throw new Error(`not a degree: "${s}"`);
  const acc = [...m[1]].reduce((a, c) => a + (c === "#" ? 1 : -1), 0);
  return [Number(m[2]) - 1, acc];
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];

/** Semitones above the tonic of the degree at `index` (from 0, past 6 into higher octaves), moved by `acc`. */
export function degreeSemis(key: Key, index: number, acc = 0): number {
  const n = key.scale.length;
  const oct = Math.floor(index / n);
  const i = ((index % n) + n) % n;
  const own = key.scale[i];
  // `b6` in minor is minor's own sixth, not a step under it
  const redundant = n === 7 && acc !== 0 && MAJOR[i] + acc === own;
  return oct * 12 + own + (redundant ? 0 : acc);
}

export const inKey = (key: Key, p: number): boolean => key.scale.includes(pc(p - key.tonic));

/** The pitch `k` steps along the key's scale from `p`; off the scale, the first step lands on the nearest one. */
export function step(key: Key, p: number, k: number): number {
  let q = p;
  if (k === 0) return q;
  const dir = Math.sign(k);
  for (let i = 0; i < Math.abs(k); i++) {
    q += dir;
    while (!inKey(key, q)) q += dir;
  }
  return q;
}

export interface Chord {
  symbol: string;
  root: number;
  /** Semitones above the root, stacked: `[0, 3, 7, 10]`. */
  ints: number[];
  /** Its pitch classes, root first. */
  pcs: number[];
  bass: number;
}

const SYMBOLS: Record<string, number[]> = {
  "": [0, 4, 7], m: [0, 3, 7], "5": [0, 7], dim: [0, 3, 6], "°": [0, 3, 6], aug: [0, 4, 8], "+": [0, 4, 8],
  "7": [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], mmaj7: [0, 3, 7, 11], dim7: [0, 3, 6, 9], "°7": [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10], "ø": [0, 3, 6, 10], "ø7": [0, 3, 6, 10], "6": [0, 4, 7, 9], m6: [0, 3, 7, 9], "9": [0, 4, 7, 10, 14],
  m9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14], add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14], sus2: [0, 2, 7], sus4: [0, 5, 7],
  sus: [0, 5, 7], "7sus4": [0, 5, 7, 10], "7b9": [0, 4, 7, 10, 13], "7#9": [0, 4, 7, 10, 15], aug7: [0, 4, 8, 10], "+7": [0, 4, 8, 10],
};

const make = (symbol: string, root: number, ints: number[], bassTone?: number): Chord => {
  const pcs = ints.map((i) => pc(root + i));
  return { symbol, root: pc(root), ints, pcs, bass: bassTone === undefined ? pc(root) : pcs[bassTone] };
};

const NUMERALS = ["VII", "VI", "IV", "V", "III", "II", "I"];
const NUM_INDEX: Record<string, number> = { I: 0, II: 1, III: 2, IV: 3, V: 4, VI: 5, VII: 6 };

/** A chord tone by its name (`3`, `5`, `7`) as its place in `ints`. */
function inversion(ints: number[], tone: string, symbol: string): number {
  const want = { "3": [3, 4, 2, 5], "5": [7, 6, 8], "7": [10, 11, 9] }[tone];
  const k = want ? ints.findIndex((i) => want.includes(i % 12)) : -1;
  if (k < 0) throw new Error(`"${symbol}": no ${tone} to put in the bass`);
  return k;
}

function numeral(src: string, key: Key, symbol: string): Chord {
  if (key.scale.length !== 7) throw new Error(`"${symbol}": numerals want a seven-note mode, not ${key.mode}`);
  const aug6 = src.match(/^(It|Fr|Ger)$/);
  if (aug6) {
    const ints = { It: [0, 4, 10], Fr: [0, 4, 6, 10], Ger: [0, 4, 7, 10] }[aug6[1]]!;
    return make(symbol, key.tonic + 8, ints);
  }
  if (src === "N") return make(symbol, key.tonic + 1, [0, 4, 7]);
  const m = src.match(/^([b#]*)(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(°|o|ø|\+)?(.*)$/);
  if (!m) throw new Error(`can't read the chord "${symbol}"`);
  const acc = [...m[1]].reduce((a, c) => a + (c === "#" ? 1 : -1), 0);
  const upper = m[2] === m[2].toUpperCase();
  const index = NUM_INDEX[m[2].toUpperCase()];
  const mark = m[3] === "o" ? "°" : m[3];
  const ext = m[4];
  let semis = degreeSemis(key, index, acc);
  // the leading tone, not the subtonic, carries vii° in minor
  if (index === 6 && !upper && (mark === "°" || mark === "ø") && key.scale[6] === 10 && acc === 0) semis = 11;
  let ints = mark === "°" ? [0, 3, 6] : mark === "ø" ? [0, 3, 6, 10] : mark === "+" ? [0, 4, 8] : upper ? [0, 4, 7] : [0, 3, 7];
  const seventh = mark === "°" ? 9 : 10;
  switch (ext) {
    case "": break;
    case "7": ints = [...ints.slice(0, 3), seventh]; break;
    case "maj7": ints = [...ints.slice(0, 3), 11]; break;
    case "9": ints = [...ints.slice(0, 3), seventh, 14]; break;
    case "maj9": ints = [...ints.slice(0, 3), 11, 14]; break;
    case "b9": ints = [...ints.slice(0, 3), 10, 13]; break;
    case "6": ints = [...ints.slice(0, 3), 9]; break;
    case "add9": ints = [...ints.slice(0, 3), 14]; break;
    case "sus2": ints = [0, 2, ints[2]]; break;
    case "sus4": ints = [0, 5, ints[2]]; break;
    case "7sus4": ints = [0, 5, ints[2], 10]; break;
    case "5": ints = [0, 7]; break;
    default: throw new Error(`"${symbol}": no chord suffix "${ext}" (7, maj7, 9, maj9, b9, 6, add9, sus2, sus4, 7sus4, 5)`);
  }
  return make(symbol, key.tonic + semis, ints);
}

/** A chord named in `key`. */
export function parseChord(symbol: string, key: Key): Chord {
  const [head, ...slashes] = symbol.split("/");
  const abs = /^(It|Fr|Ger)$/.test(head) ? null : head.match(/^([A-G][#b]?)(.*)$/);
  let c: Chord;
  if (abs) {
    const ints = SYMBOLS[abs[2]];
    if (!ints) throw new Error(`"${symbol}": no chord quality "${abs[2]}" (${Object.keys(SYMBOLS).filter(Boolean).join(", ")})`);
    c = make(symbol, notePc(abs[1]), ints);
  } else {
    let k = key;
    // an applied chord counts in the key of the chord it leans to
    const target = slashes.find((s) => !/^\d$/.test(s) && !/^[A-G]/.test(s));
    if (target) {
      const t = numeral(target, key, symbol);
      const minor = /^[b#]*[iv]/.test(target);
      k = { name: `${symbol}`, tonic: t.root, mode: minor ? "minor" : "major", scale: MODES[minor ? "minor" : "major"] };
    }
    c = numeral(head, k, symbol);
  }
  for (const s of slashes) {
    if (/^[357]$/.test(s)) c = { ...c, bass: c.pcs[inversion(c.ints, s, symbol)] };
    else if (/^[A-G][#b]?$/.test(s)) c = { ...c, bass: notePc(s) };
  }
  return c;
}

export const isChordTone = (c: Chord, p: number): boolean => c.pcs.includes(pc(p));

/** The chord tones from `lo` to `hi`, rising. */
export function chordTones(c: Chord, lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let p = lo; p <= hi; p++) if (isChordTone(c, p)) out.push(p);
  return out;
}

/** The pitch in `lo`…`hi` with pitch class `pcOf` nearest to `near`. */
export function nearest(pcOf: number, near: number, lo: number, hi: number): number {
  let best = NaN;
  for (let p = lo; p <= hi; p++) if (pc(p) === pc(pcOf) && (Number.isNaN(best) || Math.abs(p - near) < Math.abs(best - near))) best = p;
  if (Number.isNaN(best)) throw new Error(`no pitch class ${pc(pcOf)} between ${lo} and ${hi}`);
  return best;
}
