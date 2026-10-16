/**
 * A song's score (`score.yaml`): its tempo, meter, sections and tracks, each track's notes written as phrases. It's
 * what the engine generates, or a person writes; `overrides.yaml` reshapes it without touching it (cascade.ts).
 *
 * Time is in beats (quarter notes) from the song's start. Bars and beats a person reads are counted from 1. A section may
 * set its own meter, and its own tempo: steady, or `[from, to]`, changing steadily (by the beat) across it.
 *
 * A phrase is `<where> [vel=<n>] [artic=<name>] | <tokens>`:
 * - where: `<section> m<bar> [b<beat>]`, the bar counted within the section, or `m<bar> [b<beat>]` from the song's
 *   start;
 * - tokens are laid end to end: `A4:2`, `Bb3:1/2`, a chord `D3+A3:4`, a rest `r:1`, a drum by its name in the
 *   instrument's drum map `kick:1`. `@<vel>` and `!<artic>` after a token set that note's own (`C5:1@90!spic`);
 * - `|` marks a bar line, and is checked: one that doesn't fall on a bar is an error.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Rule } from "./cascade.ts";

export interface SectionDef {
  name: string;
  bars: number;
  /** Its meter, if not the score's. */
  meter?: [number, number];
  /** Quarter notes a minute, if not the score's; `[from, to]` changes steadily across the section. */
  tempo?: number | [number, number];
}

export interface TrackDef {
  id: string;
  name?: string;
  /** An instrument (patches.ts): `bbc/vln1`, `ezd3`. */
  instrument: string;
  /** How the instrument is set up, if it takes any: `{ kit: "TightRoom", mix: { hats: 6 } }` for EZdrummer. */
  setup?: Record<string, unknown>;
  /** A name overrides can pick several tracks by ("strings"). */
  group?: string;
  /** The fader (dB). */
  vol?: number;
  /** −1 (left) … 1 (right). */
  pan?: number;
  phrases: string[];
}

export interface Score {
  title: string;
  tempo: number;
  meter: [number, number];
  /** Seeds every choice left to chance (humanizing), so a build repeats exactly. */
  seed?: number;
  sections: SectionDef[];
  tracks: TrackDef[];
  /** Overrides that came with the score (a plan's dynamics, its humanizing): `overrides.yaml` applies over them. */
  shape?: Rule[];
  /** Each section's tracks and the role each plays there (a plan's `play`), for balancing the mix (mix/balance.ts). */
  roles?: Record<string, Record<string, string>>;
}

export interface Section extends SectionDef {
  /** Its first beat. */
  at: number;
  /** Beats in its bar. */
  barBeats: number;
  /** Its tempo where it starts and where it ends. */
  bpm: [number, number];
  /** Seconds from the song's start to its first beat. */
  sec: number;
}

export interface Note {
  track: string;
  pitch: number;
  /** Beats. */
  at: number;
  len: number;
  vel: number;
  artic?: string;
}

export interface Song {
  score: Score;
  sections: Section[];
  /** Each bar's first beat, in order. */
  bars: number[];
  beats: number;
  /** In time order. */
  notes: Note[];
}

const STEPS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

/** A pitch's MIDI number: `A4` 69, `Bb3` 58, `C#5` 73; a number passes through. */
export function pitch(s: string | number): number {
  if (typeof s === "number") return s;
  const m = s.match(/^([A-G])(#|b)?(-?\d)$/);
  if (!m) throw new Error(`not a pitch: "${s}"`);
  return STEPS[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (Number(m[3]) + 1) * 12;
}

export const pitchName = (m: number): string => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

const fraction = (s: string): number => {
  const m = s.match(/^(\d+(?:\.\d+)?)(?:\/(\d+))?$/);
  if (!m) throw new Error(`not a length: "${s}"`);
  return Number(m[1]) / (m[2] ? Number(m[2]) : 1);
};

const EPS = 1e-6;

/** The section a beat falls in. */
export function sectionAt(song: Pick<Song, "sections">, beat: number): Section {
  return song.sections.findLast((s) => s.at <= beat + EPS) ?? song.sections[0];
}

/** The bar a beat falls in, counted from 0 at the song's start. */
export function barAt(song: Pick<Song, "bars">, beat: number): number {
  let lo = 0;
  let hi = song.bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (song.bars[mid] <= beat + EPS) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Where a beat is, as a person reads it: `theme m3 b2.5`. */
export function where(song: Pick<Song, "sections">, beat: number): string {
  const s = sectionAt(song, beat);
  const into = beat - s.at;
  const bar = Math.floor(into / s.barBeats + EPS);
  const b = +(into - bar * s.barBeats + 1).toFixed(3);
  return `${s.name} m${bar + 1} b${b}`;
}

/** A place written `<section> m<bar> [b<beat>]` or `m<bar> [b<beat>]`, as a beat. */
export function place(song: Pick<Song, "sections" | "bars">, text: string): number {
  let sec: Section | undefined;
  let bar = 1;
  let beat = 1;
  for (const tok of text.trim().split(/\s+/).filter(Boolean)) {
    let m: RegExpMatchArray | null;
    if ((m = tok.match(/^m(\d+)$/))) bar = Number(m[1]);
    else if ((m = tok.match(/^b(\d+(?:\.\d+)?)$/))) beat = Number(m[1]);
    else {
      sec = song.sections.find((s) => s.name === tok);
      if (!sec) throw new Error(`"${text}": no section "${tok}" (${song.sections.map((s) => s.name).join(", ")})`);
    }
  }
  if (sec) return sec.at + (bar - 1) * sec.barBeats + (beat - 1);
  if (bar > song.bars.length) throw new Error(`"${text}": the song has ${song.bars.length} bars`);
  return song.bars[bar - 1] + (beat - 1);
}

/** Seconds from the song's first beat to `beat` (past the end, at the last tempo). */
export function seconds(song: Pick<Song, "sections">, beat: number): number {
  const s = sectionAt(song, beat);
  return s.sec + span(s, beat - s.at);
}

/** The beat heard `sec` seconds after the song's first. */
export function beatAt(song: Pick<Song, "sections">, sec: number): number {
  const s = song.sections.findLast((x) => x.sec <= sec + 1e-9) ?? song.sections[0];
  const [a, c] = s.bpm;
  const L = s.bars * s.barBeats;
  const t = sec - s.sec;
  if (Math.abs(c - a) < 1e-9) return s.at + (t * a) / 60;
  const k = (c - a) / L;
  return s.at + (a / k) * (Math.exp((t * k) / 60) - 1);
}

/** Seconds `x` beats into a section; its tempo runs straight from `bpm[0]` to `bpm[1]` by the beat. */
function span(s: Pick<Section, "bpm" | "bars" | "barBeats">, x: number): number {
  const [a, c] = s.bpm;
  if (Math.abs(c - a) < 1e-9) return (x * 60) / a;
  const k = (c - a) / (s.bars * s.barBeats);
  return (60 / k) * Math.log(1 + (k * x) / a);
}

/** The tempo `x` beats into a section. */
export const bpmAt = (s: Section, x: number): number => s.bpm[0] + ((s.bpm[1] - s.bpm[0]) * x) / (s.bars * s.barBeats);

/** Sections placed end to end, each with its meter and tempo, and the bars they make. */
export function layout(defs: SectionDef[], meter: [number, number], tempo: number): { sections: Section[]; bars: number[]; beats: number } {
  let at = 0;
  let sec = 0;
  const bars: number[] = [];
  const sections = defs.map((d) => {
    const m = d.meter ?? meter;
    const t = d.tempo ?? tempo;
    const bpm: [number, number] = Array.isArray(t) ? [t[0], t[1]] : [t, t];
    if (!(bpm[0] > 0 && bpm[1] > 0)) throw new Error(`section "${d.name}": tempo ${JSON.stringify(t)}`);
    if (!(m[0] > 0 && m[1] > 0)) throw new Error(`section "${d.name}": meter ${JSON.stringify(m)}`);
    const s: Section = { ...d, at, barBeats: (m[0] * 4) / m[1], bpm, sec };
    for (let b = 0; b < d.bars; b++) bars.push(at + b * s.barBeats);
    at += d.bars * s.barBeats;
    sec += span(s, d.bars * s.barBeats);
    return s;
  });
  return { sections, bars, beats: at };
}

/** The song cut to beats `w0`–`w1` (both on bar lines), moved to start at 0, with no notes: its sections clipped. */
export function excerpt(song: Song, w0: number, w1: number): Song {
  const defs: SectionDef[] = [];
  for (const s of song.sections) {
    const end = s.at + s.bars * s.barBeats;
    const a = Math.max(s.at, w0);
    const b = Math.min(end, w1);
    if (b - a < EPS) continue;
    const bars = Math.round((b - a) / s.barBeats);
    defs.push({ name: s.name, bars, meter: s.meter ?? song.score.meter, tempo: [bpmAt(s, a - s.at), bpmAt(s, b - s.at)] });
  }
  const l = layout(defs, song.score.meter, song.score.tempo);
  return { ...song, ...l, notes: [] };
}

/** The score laid out: sections placed, phrases read into notes. `drumsOf` gives a track's drum map, if it has one. */
export function compose(score: Score, drumsOf: (t: TrackDef) => Record<string, number> | undefined = () => undefined): Song {
  const song: Song = { score, ...layout(score.sections, score.meter, score.tempo), notes: [] };
  const ids = new Set<string>();
  for (const t of score.tracks) {
    if (ids.has(t.id)) throw new Error(`two tracks are called "${t.id}"`);
    ids.add(t.id);
    const drums = drumsOf(t);
    for (const ph of t.phrases ?? []) song.notes.push(...phrase(song, t.id, ph, drums));
  }
  song.notes.sort((a, b) => a.at - b.at || a.pitch - b.pitch);
  return song;
}

function phrase(song: Song, track: string, text: string, drums?: Record<string, number>): Note[] {
  const bar = text.indexOf("|");
  if (bar < 0) throw new Error(`${track}: "${text}" has no "|" after where it starts`);
  const head = text.slice(0, bar).trim().split(/\s+/);
  const opts: Record<string, string> = {};
  const at = head.filter((w) => { const m = w.match(/^(\w+)=(.+)$/); if (m) opts[m[1]] = m[2]; return !m; }).join(" ");
  let t = place(song, at);
  const vel0 = Number(opts.vel ?? 80);
  const out: Note[] = [];
  const err = (msg: string) => new Error(`${track} "${text}": ${msg}`);
  for (const tok of text.slice(bar + 1).trim().split(/\s+/).filter(Boolean)) {
    if (tok === "|") {
      if (Math.abs(song.bars[barAt(song, t)] - t) > EPS && Math.abs(t - song.beats) > EPS) throw err(`a bar line at ${where(song, t)}, not on a bar`);
      continue;
    }
    const m = tok.match(/^([^:]+):([\d./]+)(?:@(\d+))?(?:!([\w-]+))?$/);
    if (!m) throw err(`can't read "${tok}"`);
    const len = fraction(m[2]);
    if (m[1] !== "r") {
      for (const p of m[1].split("+")) {
        const isDrum = /^[a-z]/.test(p);
        if (isDrum && !drums) throw err(`"${p}" is a drum name, and this instrument has no drum map`);
        if (isDrum && drums![p] === undefined) throw err(`no drum "${p}" (${Object.keys(drums!).join(", ")})`);
        out.push({ track, pitch: isDrum ? drums![p] : pitch(p), at: t, len, vel: m[3] ? Number(m[3]) : vel0, artic: m[4] ?? opts.artic });
      }
    }
    t += len;
  }
  if (t > song.beats + EPS) throw err(`runs past the song's end (${where(song, song.beats - EPS)})`);
  return out;
}

/** A song folder's score and overrides. */
export function loadSongDir(dir: string): { score: Score; rules: unknown[] } {
  const score = parse(readFileSync(join(dir, "score.yaml"), "utf8")) as Score;
  const ov = join(dir, "overrides.yaml");
  const rules = existsSync(ov) ? (parse(readFileSync(ov, "utf8")) ?? []) : [];
  if (!Array.isArray(rules)) throw new Error(`${ov}: a list of overrides`);
  return { score, rules };
}
