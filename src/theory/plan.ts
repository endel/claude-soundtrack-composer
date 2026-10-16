/**
 * The plan (`plan.yaml`): a song at the level of music theory, what an AI writes from a prompt. The engine derives
 * every note from it, the same notes for the same plan and seed, into `score.yaml` (score/song.ts).
 *
 *   title, key ("C# minor"), tempo, meter ([4, 4]), seed
 *   ensemble:  { <track id>: { instrument, name?, group?, vol?, pan?, setup? } }  the tracks, in order
 *   themes:    { <name>: "<degrees>" }                                           melody.ts has the notation
 *   sections:  [{ name, bars, key?, tempo?, meter?, chords, dynamics?, parts }]
 *
 * A section's `chords` run bar by bar (`|`), cycling to fill it: `i | bII | i:3 V7:1 | %` (harmony.ts names them;
 * chords in a bar share it evenly unless given beats; `%` repeats the bar before). `dynamics` is `p<ff`, `f>p<mf`,
 * `mf`, or keyframes `[[0, p], [0.7, ff], [1, f]]` over the section. `tempo` may be `[from, to]`.
 *
 * A track's `vol` is on top of its instrument's own loudness (orchestra.ts `trim`): 0 is level with the others.
 *
 * `parts` gives each track (or several: `vc,cb`) its role in the section; a track not named rests. Every part takes
 * `bars` ("5-8": only those bars of the section), `artic` (one of the instrument's, or `auto`: short notes short),
 * `register` ("C3-C5", else the track's, else where its role sounds best on the instrument: orchestra.ts), `octave` (a
 * melody's tonic octave; elsewhere octaves up or down), `dynamics` (else the section's, accompaniment a mark or so
 * under it) and `vel` (+/−).
 * - `melody`: `line`, statements played end to end (melody.ts).
 * - `counter`: a line against `against` (a track), `below` or above it, in `rhythm` if given.
 * - `harmony`: the chords, voice-led across every harmony part of the section (`voices` per track, default 1); held,
 *   or struck on `rhythm` (rhythm.ts).
 * - `bass`: each chord's bass note, held, or on `rhythm` playing `notes`; `walk: true` walks in quarters;
 *   `pedal: "1"` holds a degree under everything.
 * - `figure`: an ostinato or arpeggio: `notes` cycled over `rhythm`. Notes count up from the chord's root in the key
 *   (`1 5 8 b2`; 3, 5 and 7 are the chord's own), `relative: key` from the tonic instead, or `arp: up|down|updown`
 *   through the chord's tones; `chord: true` strikes the whole voiced chord on each hit; the cycle restarts each bar
 *   (`cycle: chord` each chord, `cycle: on` never).
 * - `double`: plays what `of` plays, `octave` up or down.
 * - `drums`: `groove`, `cymbal`, `fill`, `crash`, `ghosts` (drums.ts).
 *
 * The score also carries `shape`: the dynamics as curves on each track, humanizing and the melody's swells. Overrides
 * apply over it (score/cascade.ts), so the plan can be re-rolled under them.
 */
import { MARKS, type Level } from "../score/values.ts";
import { barAt, layout, pitch, pitchName, seconds, type Score, type Section, type TrackDef } from "../score/song.ts";
import type { Rule } from "../score/cascade.ts";
import { configured, instrument, type Instrument } from "../patches.ts";
import { chordTones, degreeSemis, nearest, parseChord, parseDegree, parseKey, step, type Chord, type Key } from "./harmony.ts";
import { counter, CONTOUR_NAMES, develop, fit, generate, parseTheme, realize, rng, themeLen, type Context, type Ev, type ThemeNote } from "./melody.ts";
import { barOf, fmtLen, grid } from "./rhythm.ts";
import { voiceLead, type Range } from "./voicing.ts";
import { drums, type DrumPart } from "./drums.ts";
import { comfort, ROLE_DROP, trim } from "./orchestra.ts";

export interface PartSpec {
  play: "melody" | "counter" | "harmony" | "bass" | "figure" | "double" | "drums";
  bars?: string | [number, number];
  artic?: string;
  register?: string;
  octave?: number;
  dynamics?: string | [number, Level][];
  vel?: number;
  line?: string | string[];
  against?: string;
  below?: boolean;
  rhythm?: string;
  voices?: number;
  notes?: string;
  arp?: "up" | "down" | "updown";
  relative?: "chord" | "key";
  chord?: boolean;
  cycle?: "bar" | "chord" | "on";
  walk?: boolean;
  pedal?: string;
  of?: string;
  groove?: DrumPart["groove"];
  cymbal?: string;
  fill?: number | boolean;
  crash?: boolean;
  ghosts?: number;
}

export interface PlanSection {
  name: string;
  bars: number;
  key?: string;
  tempo?: number | [number, number];
  meter?: [number, number];
  chords: string;
  dynamics?: string | [number, Level][];
  parts: Record<string, PartSpec>;
}

export interface Plan {
  title: string;
  key: string;
  tempo: number;
  meter?: [number, number];
  seed?: number;
  /** Each track; `register` ("A2-A3") is where its parts play unless one says otherwise. */
  ensemble: Record<string, Omit<TrackDef, "id" | "phrases"> & { register?: string }>;
  themes?: Record<string, string>;
  sections: PlanSection[];
}

interface ChordAt { at: number; len: number; chord: Chord }

const EPS = 1e-6;

/** `p<ff`, `f>p<mf`, `mf` or keyframes, as keyframes over 0–1. */
export function dynamicsOf(d: string | [number, Level][] | undefined): [number, number][] {
  if (d === undefined) return [[0, MARKS.mf]];
  if (Array.isArray(d)) return d.map(([x, v]) => [x, typeof v === "string" ? MARKS[v] : v]);
  const marks = d.split(/[<>]/).map((s) => s.trim());
  for (const m of marks) if (!(m in MARKS)) throw new Error(`dynamics "${d}": "${m}" isn't one of ${Object.keys(MARKS).join(" ")}`);
  return marks.map((m, i) => [marks.length > 1 ? i / (marks.length - 1) : 0, MARKS[m]]);
}

const levelAt = (kf: [number, number][], x: number): number => {
  if (x <= kf[0][0]) return kf[0][1];
  for (let k = 1; k < kf.length; k++) if (x <= kf[k][0]) return kf[k - 1][1] + ((kf[k][1] - kf[k - 1][1]) * (x - kf[k - 1][0])) / Math.max(EPS, kf[k][0] - kf[k - 1][0]);
  return kf[kf.length - 1][1];
};

/** The section's chords laid out from `at0`, the progression cycled over `bars`. */
export function progression(src: string, key: Key, at0: number, bars: number, barBeats: number): ChordAt[] {
  const groups = src.split("|").map((g) => g.trim()).filter(Boolean);
  const one: { sym: string; len: number }[] = [];
  let prevBar: { sym: string; len: number }[] = [];
  for (const g of groups) {
    if (g === "%") { one.push(...prevBar); continue; }
    const toks = g.split(/\s+/).map((t) => { const m = t.match(/^(.+?)(?::([\d./]+))?$/)!; return { sym: m[1], len: m[2] ? (m[2].includes("/") ? Number(m[2].split("/")[0]) / Number(m[2].split("/")[1]) : Number(m[2])) : NaN }; });
    const given = toks.filter((t) => !Number.isNaN(t.len)).reduce((a, t) => a + t.len, 0);
    const free = toks.filter((t) => Number.isNaN(t.len));
    const share = free.length ? (barBeats - given) / free.length : 0;
    if (free.length && share <= EPS) throw new Error(`chords "${g}": no room left in the bar`);
    const bar = toks.map((t) => ({ sym: t.sym, len: Number.isNaN(t.len) ? share : t.len }));
    // `-` holds the chord before
    for (const c of bar) {
      if (c.sym === "-" && one.length) one[one.length - 1] = { ...one[one.length - 1], len: one[one.length - 1].len + c.len };
      else one.push(c);
    }
    prevBar = bar.filter((c) => c.sym !== "-");
  }
  const L = one.reduce((a, c) => a + c.len, 0);
  const total = bars * barBeats;
  const out: ChordAt[] = [];
  for (let off = 0; off < total - EPS; off += L) {
    for (const c of one) {
      const at = off + one.slice(0, one.indexOf(c)).reduce((a, x) => a + x.len, 0);
      if (at >= total - EPS) break;
      out.push({ at: at0 + at, len: Math.min(c.len, total - at), chord: parseChord(c.sym, key) });
    }
  }
  return out;
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];

/**
 * A figure's note over a chord, as semitones above its root: `1` the root, `8` an octave up; `3`, `5`, `7` the
 * chord's own; `2`, `4`, `6` the key's scale on from the root; with an accidental, the exact interval (`b2` a half
 * step, `#4` the tritone); `c1`…`c4` the chord's tones in order.
 */
function figureStep(tok: string, c: Chord, key: Key): number {
  const ct = tok.match(/^c(\d)$/);
  if (ct) {
    const k = Number(ct[1]) - 1;
    return c.ints[k % c.ints.length] + 12 * Math.floor(k / c.ints.length);
  }
  const [i, acc] = parseDegree(tok);
  const oct = Math.floor(i / 7) * 12;
  const d = i % 7;
  if (acc !== 0) return oct + MAJOR[d] + acc;
  const own = { 2: [3, 4, 2, 5], 4: [7, 6, 8], 6: [10, 11, 9] }[d];
  const tone = own && c.ints.find((x) => own.includes(x % 12));
  if (tone !== undefined) return oct + (tone % 12);
  const p = c.root + 60;
  let q = p;
  for (let k = 0; k < d; k++) q = step(key, q, 1);
  return oct + (q - p);
}

/** A degree of the key (`5`, `b2`) as semitones over its tonic. */
const keyStep = (tok: string, key: Key): number => degreeSemis(key, ...parseDegree(tok));

const parseRegister = (s: string): [number, number] => {
  const m = s.match(/^([A-G][#b]?-?\d)\s*-\s*([A-G][#b]?-?\d)$/);
  if (!m) throw new Error(`a register is "C3-C5", not "${s}"`);
  return [pitch(m[1]), pitch(m[2])];
};

const barsOf = (b: PartSpec["bars"], total: number): [number, number] => {
  if (b === undefined) return [1, total];
  const [x, y] = Array.isArray(b) ? b : String(b).split("-").map(Number);
  const to = y ?? x;
  if (!(x >= 1 && to >= x && to <= total)) throw new Error(`bars ${JSON.stringify(b)}: the section has ${total}`);
  return [x, to];
};

interface TrackInfo {
  inst: Instrument;
  drums?: string[];
  /** Where every articulation can play. */
  range: [number, number];
  shortArtic?: string;
  longArtic: string;
  dynamics: boolean;
}

function trackInfo(def: Plan["ensemble"][string]): TrackInfo {
  // a kit's drum names come with the kit; its mix can wait for the build
  const { mix: _, ...setup } = def.setup ?? {};
  const inst = configured(instrument(def.instrument), def.setup ? setup : undefined, () => {});
  const longArtic = inst.artics.long ? "long" : inst.default;
  const shortArtic = ["spic", "stac"].find((a) => inst.artics[a]);
  const p = inst.artics[longArtic];
  const drumMap = p.drums;
  const ranges = Object.values(inst.artics).map((a) => a.range ?? [21, 108]);
  return {
    inst,
    drums: drumMap ? Object.keys(drumMap) : undefined,
    range: [Math.max(...ranges.map((r) => r[0])), Math.min(...ranges.map((r) => r[1]))],
    shortArtic,
    longArtic,
    dynamics: "dynamics" in p.controls,
  };
}

const fold = (p: number, [lo, hi]: [number, number]): number => {
  let q = p;
  while (q < lo) q += 12;
  while (q > hi) q -= 12;
  return q < lo ? p : q;
};

export interface Composed {
  score: Score;
  warnings: string[];
  /** Per section, how many melody notes were moved onto the harmony. */
  fitted: number;
}

/** The plan's notes, as a score. */
export function composePlan(plan: Plan, o: { seed?: number } = {}): Composed {
  const seed = o.seed ?? plan.seed ?? 1;
  const meter = plan.meter ?? [4, 4];
  const warnings: string[] = [];
  const themes: Record<string, ThemeNote[]> = {};
  for (const [name, src] of Object.entries(plan.themes ?? {})) {
    try { themes[name] = parseTheme(src); } catch (e) { throw new Error(`theme ${name}: ${(e as Error).message}`); }
  }
  const lay = layout(plan.sections.map((s) => ({ name: s.name, bars: s.bars, meter: s.meter, tempo: s.tempo })), meter, plan.tempo);
  const song = { sections: lay.sections, bars: lay.bars };
  const info = new Map(Object.entries(plan.ensemble).map(([id, d]) => [id, trackInfo(d)]));
  const events = new Map<string, Ev[]>([...info.keys()].map((id) => [id, []]));
  const shape: Rule[] = [];
  const roles: Record<string, Record<string, string>> = {};
  const lastPitch = new Map<string, number>();
  const lastVoices = new Map<string, number[]>();
  let fitted = 0;

  plan.sections.forEach((ps, si) => {
    const sec = lay.sections[si];
    const key = parseKey(ps.key ?? plan.key);
    const m = ps.meter ?? meter;
    const end = sec.at + sec.bars * sec.barBeats;
    const chords = progression(ps.chords, key, sec.at, sec.bars, sec.barBeats);
    const chordAt = (at: number) => (chords.findLast((c) => c.at <= at + EPS) ?? chords[0]).chord;
    const secDyn = dynamicsOf(ps.dynamics);
    const levelOf = (kf: [number, number][]) => (at: number) => levelAt(kf, (at - sec.at) / (end - sec.at));
    const ctxFor = (kf: [number, number][]): Context => ({
      key: () => key,
      chord: chordAt,
      meter: () => m,
      bar: (at) => lay.bars[barAt(song, at)],
      level: levelOf(kf),
    });
    const ctx = ctxFor(secDyn);

    // each track's part, `vc,cb` split
    const parts: [string, PartSpec][] = [];
    for (const [k, p] of Object.entries(ps.parts ?? {})) {
      for (const id of k.split(",").map((s) => s.trim())) {
        if (!info.has(id)) throw new Error(`section ${ps.name}: no track "${id}" in the ensemble (${[...info.keys()].join(", ")})`);
        if (parts.some(([x]) => x === id)) throw new Error(`section ${ps.name}: two parts for ${id}`);
        parts.push([id, p]);
      }
    }
    // a counter-line or a double after the part it follows
    const order = ["melody", "counter", "harmony", "bass", "figure", "drums", "double"];
    parts.sort((a, b) => order.indexOf(a[1].play) - order.indexOf(b[1].play));
    const source = (p: PartSpec) => (p.play === "counter" ? p.against : p.play === "double" ? p.of : undefined);
    for (let i = 0; i < parts.length; i++) {
      const src = source(parts[i][1]);
      const j = src ? parts.findIndex(([id]) => id === src) : -1;
      if (j > i) {
        if (source(parts[j][1]) === parts[i][0]) throw new Error(`section ${ps.name}: ${parts[i][0]} and ${src} follow each other`);
        parts.splice(j + 1, 0, parts.splice(i, 1)[0]);
        i--;
      }
    }
    const made = new Map<string, Ev[]>();
    const r = (id: string, what: string) => rng(`${seed}|${ps.name}|${id}|${what}`);
    const win = (p: PartSpec): [number, number] => {
      const [b0, b1] = barsOf(p.bars, sec.bars);
      return [sec.at + (b0 - 1) * sec.barBeats, sec.at + b1 * sec.barBeats];
    };
    const rangeOf = (id: string, p: PartSpec): [number, number] => {
      const t = info.get(id)!;
      const reg = p.register ?? plan.ensemble[id].register;
      const base = reg ? parseRegister(reg) : comfort(plan.ensemble[id].instrument, t.range, p.play);
      const sh = p.play === "melody" ? 0 : (p.octave ?? 0) * 12;
      return [Math.max(t.range[0], base[0] + sh), Math.min(t.range[1], base[1] + sh)];
    };

    // the harmony parts voice the chords together, the highest range on top
    const harm = parts.filter(([, p]) => p.play === "harmony");
    let voicing: Map<string, number[][]> | undefined;
    if (harm.length) {
      const slots: { id: string; range: Range }[] = [];
      for (const [id, p] of harm) {
        const [lo, hi] = rangeOf(id, p);
        for (let v = 0; v < (p.voices ?? 1); v++) slots.push({ id, range: { lo, hi } });
      }
      slots.sort((a, b) => b.range.lo + b.range.hi - (a.range.lo + a.range.hi));
      // each voice picks up where it left off in the section before
      const names = slots.map((s, i) => `${s.id}#${slots.slice(0, i).filter((x) => x.id === s.id).length}`);
      const start = names.every((n) => lastVoices.has(n)) ? names.map((n) => lastVoices.get(n)!) : undefined;
      const lead = voiceLead(chords.map((c) => c.chord), slots.map((s) => s.range), start);
      voicing = new Map();
      slots.forEach((s, k) => {
        const per = voicing!.get(s.id) ?? chords.map(() => []);
        lead.forEach((v, ci) => per[ci].push(v[k]));
        voicing!.set(s.id, per);
        lastVoices.set(names[k], lead[lead.length - 1][k]);
      });
    }

    for (const [id, p] of parts) {
      const t = info.get(id)!;
      const [a, b] = win(p);
      // accompaniment a mark or so under the melody, unless the part sets its own
      const drop = ROLE_DROP[p.play] ?? 0;
      const kf = p.dynamics !== undefined ? dynamicsOf(p.dynamics) : secDyn.map(([x, v]) => [x, Math.max(0.05, v - drop)] as [number, number]);
      const c = p.dynamics !== undefined || drop ? ctxFor(kf) : ctx;
      const range = rangeOf(id, p);
      let evs: Ev[] = [];
      const label = `${ps.name} ${id}`;
      try {
        if (p.play === "melody") evs = melodyPart(p, a, b, c, key, range, t.range, themes, lastPitch.get(id), r(id, "melody"), (n) => (fitted += n), warnings, label);
        else if (p.play === "counter") {
          if (!p.against || !made.has(p.against)) throw new Error(`counter wants "against": a track playing in this section`);
          const mel = made.get(p.against)!.filter((e) => typeof e.pitch === "number");
          const mid = (range[0] + range[1]) / 2;
          const melMid = mel.reduce((s, e) => s + (e.pitch as number), 0) / Math.max(1, mel.length);
          const onsets = p.rhythm ? hitsOver(p.rhythm, a, b, lay, song).map((h) => ({ at: h.at, len: h.len, accent: h.accent })) : undefined;
          evs = counter(mel, a, b, { range, below: p.below ?? mid < melMid, onsets, from: lastPitch.get(id) }, c, r(id, "counter"));
        } else if (p.play === "harmony") {
          const per = voicing!.get(id)!;
          evs = struck(chords, per, p, a, b, lay, song);
        } else if (p.play === "bass") evs = bassPart(p, chords, a, b, key, range, lay, song, lastPitch.get(id));
        else if (p.play === "figure") evs = figurePart(p, chords, a, b, key, range, lay, song, lastPitch.get(id));
        else if (p.play === "drums") {
          if (!t.drums) throw new Error(`${plan.ensemble[id].instrument} has no drum map`);
          evs = drums({ groove: p.groove ?? "rock", cymbal: p.cymbal, fill: p.fill, crash: p.crash, ghosts: p.ghosts }, a, b, c, t.drums, r(id, "drums"));
        } else if (p.play === "double") {
          const src = p.of && made.get(p.of);
          if (!src) throw new Error(`double wants "of": a track playing in this section`);
          evs = src.filter((e) => e.at >= a - EPS && e.at < b - EPS).map((e) => ({ ...e, pitch: typeof e.pitch === "number" ? e.pitch + 12 * (p.octave ?? 0) : e.pitch, artic: undefined, vel: undefined }));
        } else throw new Error(`no role "${(p as PartSpec).play}" (${order.join(", ")})`);
      } catch (e) {
        throw new Error(`${label}: ${(e as Error).message}`);
      }
      // articulations, velocities, and every pitch in the instrument's reach
      let folded = 0;
      for (const e of evs) {
        if (p.play !== "drums") {
          const want = e.artic ?? p.artic ?? (p.play === "figure" || p.play === "double" || p.rhythm ? "auto" : t.longArtic);
          const short = seconds(song, e.at + e.len) - seconds(song, e.at) < 0.32;
          const artic = want === "auto" ? (short && t.shortArtic ? t.shortArtic : t.longArtic) : want;
          if (!t.inst.artics[artic]) throw new Error(`${label}: ${t.inst.name} has no articulation "${artic}" (${Object.keys(t.inst.artics).join(", ")})`);
          e.artic = artic;
          e.vel ??= Math.round(34 + 80 * c.level(e.at) + 12 * e.accent);
        }
        if (typeof e.pitch === "number") {
          const q = fold(e.pitch, (e.artic && t.inst.artics[e.artic].range) || t.range);
          if (q !== e.pitch) { folded++; e.pitch = q; }
        }
        e.vel = Math.max(1, Math.min(127, Math.round(e.vel! + (p.vel ?? 0))));
      }
      if (folded) warnings.push(`${label}: ${folded} note${folded > 1 ? "s" : ""} moved by octaves into ${pitchName(t.range[0])}–${pitchName(t.range[1])}`);
      made.set(id, evs);
      events.get(id)!.push(...evs);
      if (evs.length) (roles[ps.name] ??= {})[id] = p.play;
      const lastP = evs.findLast((e) => typeof e.pitch === "number")?.pitch;
      if (typeof lastP === "number") lastPitch.set(id, lastP);

      // the section's dynamics as a curve over what this track plays of it
      if (t.dynamics && evs.length) {
        const s0 = Math.min(...evs.map((e) => e.at));
        const s1 = Math.max(...evs.map((e) => e.at + e.len));
        const x0 = (s0 - sec.at) / (end - sec.at);
        const x1 = Math.min(1, (s1 - sec.at) / (end - sec.at));
        const pts: [number, number][] = [[0, levelAt(kf, x0)]];
        for (const [x, v] of kf) if (x > x0 + EPS && x < x1 - EPS) pts.push([(x - x0) / Math.max(EPS, x1 - x0), v]);
        pts.push([1, levelAt(kf, x1)]);
        const flat = pts.every(([, v]) => Math.abs(v - pts[0][1]) < 1e-3);
        const round = (v: number) => +v.toFixed(3);
        shape.push(flat
          ? { select: `${id} @ ${ps.name}`, set: { dynamics: round(pts[0][1]) } }
          : { select: `${id} @ ${ps.name}`, over: "span", set: { dynamics: pts.map(([x, v]) => [round(x), round(v)]) } });
      }
      if ((p.play === "melody" || p.play === "counter") && t.dynamics && evs.some((e) => e.len >= 2)) {
        shape.push({ select: `${id} @ ${ps.name} [dur>=2]`, set: { expression: [[0, 0.8], [0.45, 1], [1, 0.86]] } });
      }
    }
  });

  const tracks: TrackDef[] = [];
  for (const [id, def] of Object.entries(plan.ensemble)) {
    const evs = events.get(id)!;
    if (!evs.length) { warnings.push(`${id} plays nothing`); continue; }
    const t = info.get(id)!;
    const { register: _, ...desk } = def;
    const vol = +((def.vol ?? 0) + trim(def.instrument)).toFixed(1);
    tracks.push({ id, ...desk, ...(vol ? { vol } : {}), phrases: lay.sections.flatMap((s) => phrases(evs.filter((e) => e.at >= s.at - EPS && e.at < s.at + s.bars * s.barBeats - EPS), s, lay, t.drums ? undefined : t.inst.default)) });
  }
  const drumIds = [...info.entries()].filter(([, t]) => t.drums).map(([id]) => id).filter((id) => tracks.some((t) => t.id === id));
  shape.unshift(
    { select: "*", set: { humanize: { timing: 7, vel: 4 } } },
    ...drumIds.map((id) => ({ select: id, set: { humanize: { timing: 3, vel: 3 } } })),
  );
  const score: Score = {
    title: plan.title,
    tempo: plan.tempo,
    meter,
    seed,
    sections: plan.sections.map((s) => ({ name: s.name, bars: s.bars, ...(s.meter ? { meter: s.meter } : {}), ...(s.tempo !== undefined ? { tempo: s.tempo } : {}) })),
    tracks,
    shape,
    roles,
  };
  return { score, warnings, fitted };
}

type Lay = ReturnType<typeof layout>;
type SongLike = { sections: Section[]; bars: number[] };

/** A rhythm's hits over `a`–`b`, bar by bar. */
function hitsOver(src: string, a: number, b: number, lay: Lay, song: SongLike) {
  const out: { at: number; len: number; accent: number; roll: boolean; bar: number }[] = [];
  for (let k = barAt(song, a); k < lay.bars.length && lay.bars[k] < b - EPS; k++) {
    const t0 = lay.bars[k];
    const B = (lay.bars[k + 1] ?? lay.beats) - t0;
    const bars = grid(src, B);
    for (const h of barOf(bars, k - barAt(song, a))) if (t0 + h.at >= a - EPS && t0 + h.at < b - EPS) out.push({ ...h, at: t0 + h.at, len: Math.min(h.len, b - t0 - h.at), bar: k });
  }
  return out;
}

/** The chords' voices for one track, held through each chord (tied where it repeats) or struck on a rhythm. */
function struck(chords: ChordAt[], per: number[][], p: PartSpec, a: number, b: number, lay: Lay, song: SongLike): Ev[] {
  const out: Ev[] = [];
  if (p.rhythm) {
    for (const h of hitsOver(p.rhythm, a, b, lay, song)) {
      const ci = chords.findLastIndex((c) => c.at <= h.at + EPS);
      for (const q of per[ci]) out.push({ pitch: q, at: h.at, len: h.len, accent: h.accent });
    }
    return out;
  }
  let held: { v: number[]; at: number; len: number } | undefined;
  const flush = () => { if (held) for (const q of held.v) out.push({ pitch: q, at: held.at, len: held.len, accent: 0 }); };
  chords.forEach((c, ci) => {
    const s = Math.max(a, c.at);
    const e = Math.min(b, c.at + c.len);
    if (e - s < EPS) return;
    const v = per[ci];
    if (held && Math.abs(held.at + held.len - s) < EPS && held.v.join() === v.join()) held.len += e - s;
    else { flush(); held = { v, at: s, len: e - s }; }
  });
  flush();
  return out;
}

/** The pitch of `pc` nearest `near` within `range`, or the range's middle. */
const place = (pcOf: number, near: number | undefined, range: [number, number]): number => nearest(pcOf, near ?? (range[0] + range[1]) / 2, range[0], range[1]);

function bassPart(p: PartSpec, chords: ChordAt[], a: number, b: number, key: Key, range: [number, number], lay: Lay, song: SongLike, last?: number): Ev[] {
  const out: Ev[] = [];
  // low in its range, moving to the nearest octave of the next note
  const low = range[0] + (range[1] - range[0]) * 0.3;
  const root = (pcOf: number, prev: number | undefined) => {
    const near = prev === undefined ? low : prev * 0.65 + low * 0.35;
    return place(pcOf, near, range);
  };
  let prev = last;
  const pedal = p.pedal !== undefined ? key.tonic + keyStep(p.pedal, key) : undefined;
  if (p.rhythm) {
    const notes = (p.notes ?? "1").split(/\s+/).filter(Boolean);
    let k = 0;
    let lastBar = -1;
    let lastChord = -1;
    for (const h of hitsOver(p.rhythm, a, b, lay, song)) {
      const ci = chords.findLastIndex((c) => c.at <= h.at + EPS);
      const c = chords[ci].chord;
      if ((p.cycle ?? "bar") === "bar" && h.bar !== lastBar) k = 0;
      if (p.cycle === "chord" && ci !== lastChord) k = 0;
      lastBar = h.bar;
      if (ci !== lastChord || prev === undefined) prev = root(pedal ?? c.bass, prev);
      lastChord = ci;
      const tok = notes[k++ % notes.length];
      const q = tok === "1" ? prev : prev - (((prev - c.root) % 12) + 12) % 12 + figureStep(tok, c, key);
      out.push({ pitch: q, at: h.at, len: h.len, accent: h.accent });
    }
    return out;
  }
  for (let ci = 0; ci < chords.length; ci++) {
    const ch = chords[ci];
    const s = Math.max(a, ch.at);
    const e = Math.min(b, ch.at + ch.len);
    if (e - s < EPS) continue;
    const q = root(pedal ?? ch.chord.bass, prev);
    if (p.walk && e - s >= 2 - EPS) {
      // quarters: the root, chord tones, then a step into the next chord's root
      const next = chords[ci + 1]?.chord;
      const target = next ? root(pedal ?? next.bass, q) : q;
      const n = Math.round(e - s);
      let w = q;
      for (let k = 0; k < n; k++) {
        let pq = w;
        if (k === n - 1 && next) pq = target + (target > w ? -1 : 1);
        else if (k > 0) {
          const tones = chordTones(ch.chord, range[0], range[1]).filter((x) => Math.abs(x - w) <= 5 && x !== w);
          pq = tones.sort((x, y) => Math.abs(x - target) - Math.abs(y - target))[0] ?? step(key, w, target > w ? 1 : -1);
        }
        out.push({ pitch: pq, at: s + k, len: 1, accent: k === 0 ? 1 : 0 });
        w = pq;
      }
      prev = q;
      continue;
    }
    if (out.length && out[out.length - 1].pitch === q && Math.abs((out[out.length - 1].at + out[out.length - 1].len) - s) < EPS && pedal !== undefined) out[out.length - 1].len += e - s;
    else out.push({ pitch: q, at: s, len: e - s, accent: 0 });
    prev = q;
  }
  return out;
}

function figurePart(p: PartSpec, chords: ChordAt[], a: number, b: number, key: Key, range: [number, number], lay: Lay, song: SongLike, last?: number): Ev[] {
  if (!p.rhythm) throw new Error(`a figure wants a rhythm`);
  const out: Ev[] = [];
  const hits = hitsOver(p.rhythm, a, b, lay, song);
  const toks = p.arp ? undefined : (p.notes ?? "1").split(/\s+/).filter(Boolean);
  if (!p.arp && !toks?.length) throw new Error(`a figure wants notes or arp`);
  let k = 0;
  let lastBar = -1;
  let lastChord = -1;
  let base: number | undefined;
  let voiced: number[] | undefined;
  for (const h of hits) {
    const ci = chords.findLastIndex((c) => c.at <= h.at + EPS);
    const c = chords[ci].chord;
    const cyc = p.cycle ?? "bar";
    if ((cyc === "bar" && h.bar !== lastBar) || (cyc === "chord" && ci !== lastChord)) k = 0;
    lastBar = h.bar;
    if (ci !== lastChord || base === undefined) {
      // the figure's root where its notes fit the range, near where it was
      const rel = p.relative === "key" ? key.tonic : c.root;
      const steps = p.arp ? [0, ...c.ints.slice(1), 12] : toks!.map((t) => (p.relative === "key" ? keyStep(t, key) : figureStep(t, c, key)));
      const lo = Math.min(...steps);
      const hi = Math.max(...steps);
      // the figure's middle stays near where it was: the last chord's, the section before's, or the range's middle
      const mid = base !== undefined ? base + (lo + hi) / 2 : last ?? (range[0] + range[1]) / 2;
      let best: number | undefined;
      for (let r0 = range[0] - 24; r0 <= range[1]; r0++) {
        if ((((r0 - rel) % 12) + 12) % 12 !== 0) continue;
        if (r0 + lo < range[0] || r0 + hi > range[1]) continue;
        if (best === undefined || Math.abs(r0 + (lo + hi) / 2 - mid) < Math.abs(best + (lo + hi) / 2 - mid)) best = r0;
      }
      base = best ?? place(rel, mid, range);
      if (p.chord) voiced = voiceLead([c], [range, range, range].slice(0, p.voices ?? 3).map(([lo2, hi2]) => ({ lo: lo2, hi: hi2 })), voiced)[0];
    }
    lastChord = ci;
    if (p.chord) {
      for (const q of voiced!) out.push({ pitch: q, at: h.at, len: h.len, accent: h.accent });
      continue;
    }
    let q: number;
    if (p.arp) {
      const tones = [0, ...c.ints.slice(1).map((x) => x % 12)].sort((x, y) => x - y);
      const seq = p.arp === "down" ? [...tones, 12].reverse() : p.arp === "updown" ? [...tones, 12, ...tones.slice(1).reverse()] : [...tones, 12];
      q = base + seq[k % seq.length];
    } else {
      const t = toks![k % toks!.length];
      q = base + (p.relative === "key" ? keyStep(t, key) : figureStep(t, c, key));
    }
    k++;
    out.push({ pitch: q, at: h.at, len: h.len, accent: h.accent });
  }
  return out;
}

function melodyPart(
  p: PartSpec, a: number, b: number, ctx: Context, key: Key, range: [number, number], reach: [number, number],
  themes: Record<string, ThemeNote[]>, last: number | undefined, r: () => number, onFit: (n: number) => void, warnings: string[], label: string,
): Ev[] {
  const lines = Array.isArray(p.line) ? p.line : p.line ? [p.line] : [];
  if (!lines.length) throw new Error(`a melody wants a line`);
  const barBeats = (ctx.meter(a)[0] * 4) / ctx.meter(a)[1];
  type St = { kind: "theme"; notes: ThemeNote[]; fit: boolean; src: string } | { kind: "gen"; bars: number; contour: string; from?: string; end?: number; src: string } | { kind: "rest"; beats: number; src: string };
  let lastTheme: ThemeNote[] | undefined;
  const sts: St[] = lines.map((src) => {
    const w = src.trim().split(/\s+/);
    if (w[0] === "gen") {
      const bars = Number(w[1]);
      if (!(bars > 0)) throw new Error(`"${src}": gen <bars> …`);
      let contour = "arch";
      let from: string | undefined;
      let end: number | undefined;
      for (const x of w.slice(2)) {
        if (CONTOUR_NAMES.includes(x)) contour = x;
        else if (x.startsWith("from=")) from = x.slice(5);
        else if (x.startsWith("end=")) end = parseDegree(x.slice(4))[0];
        else throw new Error(`"${src}": can't read "${x}" (${CONTOUR_NAMES.join("|")}, from=<theme>, end=<degree>)`);
      }
      return { kind: "gen", bars, contour, from, end, src };
    }
    if (w[0] === "rest") return { kind: "rest", beats: Number(w[1]) * barBeats, src };
    if (src.includes(":")) return { kind: "theme", notes: parseTheme(src), fit: true, src };
    const t = themes[w[0]];
    if (!t) throw new Error(`"${src}": no theme "${w[0]}" (${Object.keys(themes).join(", ")})`);
    const d = develop(t, w.slice(1), r);
    return { kind: "theme", ...d, src };
  });
  // one octave for the whole line: its written notes as near the middle of the range as they fit
  const written = sts.flatMap((s) => (s.kind === "theme" ? s.notes.filter((n) => n.deg !== null).map((n) => degreeSemis(key, n.deg!, n.acc) + n.shift) : []));
  let tonic: number;
  if (p.octave !== undefined) tonic = 12 * (p.octave + 1) + key.tonic;
  else {
    const mid = (range[0] + range[1]) / 2;
    let best = 12 * 5 + key.tonic;
    let bestCost = Infinity;
    for (let o = 1; o <= 8; o++) {
      const tn = 12 * o + key.tonic;
      const ps = written.length ? written.map((x) => tn + x) : [tn];
      const out = ps.filter((x) => x < reach[0] || x > reach[1]).length * 10 + ps.filter((x) => x < range[0] || x > range[1]).length;
      const mean = ps.reduce((s, x) => s + x, 0) / ps.length;
      const cost = out + Math.abs(mean - mid) * 0.1 + (last !== undefined ? Math.abs(mean - last) * 0.03 : 0);
      if (cost < bestCost) { bestCost = cost; best = tn; }
    }
    tonic = best;
  }
  const out: Ev[] = [];
  let at = a;
  for (const s of sts) {
    if (at >= b - EPS) { warnings.push(`${label}: "${s.src}" starts after the part ends; dropped`); continue; }
    if (s.kind === "rest") { at += s.beats; continue; }
    if (s.kind === "theme") {
      const { evs, kept } = realize(s.notes, key, tonic, at);
      if (s.fit) onFit(fit(evs, kept, ctx));
      out.push(...evs);
      lastTheme = s.notes;
      at += themeLen(s.notes);
    } else {
      const rhythm = s.from ? themes[s.from] : lastTheme ?? Object.values(themes)[0];
      if (!rhythm) throw new Error(`"${s.src}": no theme to take a rhythm from`);
      const from = (out.findLast((e) => typeof e.pitch === "number")?.pitch as number | undefined) ?? last ?? Math.round((range[0] + range[1]) / 2);
      out.push(...generate(at, { rhythm, bars: s.bars, barBeats, contour: s.contour, from, range, end: s.end }, ctx, r));
      at += s.bars * barBeats;
    }
  }
  const kept = out.filter((e) => e.at < b - EPS);
  if (kept.length < out.length) warnings.push(`${label}: the line runs ${fmtLen(at - b)} beats past the part; cut`);
  for (const e of kept) if (e.at + e.len > b + EPS) e.len = b - e.at;
  return kept;
}

/**
 * A track's notes in one section, as score phrases: one per voice (one per drum, for a kit, which has no `def`ault
 * articulation), bar lines where they fall.
 */
export function phrases(evs: Ev[], sec: Section, lay: Lay, def: string | undefined): string[] {
  if (!evs.length) return [];
  const drum = def === undefined;
  type Tok = { at: number; len: number; pitches: (number | string)[]; vel: number; artic: string };
  const toks: Tok[] = [];
  const sorted = [...evs].sort((x, y) => x.at - y.at || (typeof x.pitch === "number" && typeof y.pitch === "number" ? x.pitch - y.pitch : String(x.pitch).localeCompare(String(y.pitch))));
  for (const e of sorted) {
    const artic = e.artic ?? def ?? "";
    const same = drum ? undefined : toks.find((t) => Math.abs(t.at - e.at) < EPS && Math.abs(t.len - e.len) < EPS && t.vel === e.vel && t.artic === artic);
    if (same) { if (!same.pitches.includes(e.pitch)) same.pitches.push(e.pitch); }
    else toks.push({ at: e.at, len: e.len, pitches: [e.pitch], vel: e.vel!, artic });
  }
  const voices: { key: string; end: number; toks: Tok[] }[] = [];
  for (const t of toks) {
    const key = drum ? String(t.pitches[0]) : "";
    const v = voices.find((x) => x.key === key && x.end <= t.at + EPS);
    if (v) { v.toks.push(t); v.end = t.at + t.len; }
    else voices.push({ key, end: t.at + t.len, toks: [t] });
  }
  const song = { sections: [sec], bars: lay.bars };
  const isBar = (x: number) => Math.abs(lay.bars[barAt(song, x)] - x) < EPS;
  const nextBar = (x: number) => lay.bars.find((y) => y > x + EPS) ?? Infinity;
  const name = (q: number | string) => (typeof q === "number" ? pitchName(q) : q);
  const common = <T>(xs: T[]): T => {
    const n = new Map<T, number>();
    for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  return voices.map((v) => {
    const vel = common(v.toks.map((t) => t.vel));
    const artic = common(v.toks.map((t) => t.artic));
    const startBar = barAt(song, v.toks[0].at);
    let cur = lay.bars[startBar];
    const head = `${sec.name} m${startBar - barAt(song, sec.at) + 1}${vel !== 80 ? ` vel=${vel}` : ""}${artic && artic !== def ? ` artic=${artic}` : ""}`;
    const out: string[] = [`${head} |`];
    const bar = () => { if (isBar(cur) && !out[out.length - 1].endsWith("|")) out.push("|"); };
    for (const t of v.toks) {
      while (t.at - cur > EPS) {
        const stop = Math.min(t.at, nextBar(cur));
        out.push(`r:${fmtLen(stop - cur)}`);
        cur = stop;
        bar();
      }
      const tail = `${t.vel !== vel ? `@${t.vel}` : ""}${t.artic !== artic ? `!${t.artic}` : ""}`;
      out.push(`${t.pitches.map(name).join("+")}:${fmtLen(t.len)}${tail}`);
      cur = t.at + t.len;
      bar();
    }
    return out.join(" ");
  });
}
