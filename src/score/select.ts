/**
 * Selectors pick notes for an override, the way CSS selectors pick elements:
 *
 *   <tracks> [@] [<section>] [m<bar>[-<bar>]] [b<beat>[-<beat>]] [<filter>]…
 *
 * - tracks: `*`, a track id, a group, or several by commas (`vln1,vln2`);
 * - bars count from 1 within the section named, or within the song when none is;
 * - `b3` picks notes starting in beat 3 (from 3 up to 4), `b3.5` exactly there, `b2-3` from 2 up to 4;
 * - filters: `[pitch>=A5]`, `[dur>=2]` (beats), `[vel<60]`, `[artic=pizz]`, `[first]`, `[last]`, `[n=3]` (the third
 *   note picked, per track), `[downbeat]`.
 *
 * Specificity orders the overrides: track ids outweigh a group, a group outweighs `*`; then each of section, bars and
 * beats counts, then each filter.
 */
import { barAt, pitch, type Note, type Song } from "./song.ts";

type Op = "=" | "!=" | "<" | "<=" | ">" | ">=";
type Filter = { key: "pitch" | "dur" | "vel" | "artic" | "n"; op: Op; value: number | string } | { flag: "first" | "last" | "downbeat" };

export interface Selector {
  src: string;
  tracks: "*" | string[];
  section?: string;
  bars?: [number, number];
  beats?: { from: number; to: number; exact: boolean };
  filters: Filter[];
}

const KEYS = ["pitch", "dur", "vel", "artic", "n"] as const;
const FLAGS = ["first", "last", "downbeat"] as const;

function parseFilter(f: string, src: string): Filter {
  const t = f.trim();
  if ((FLAGS as readonly string[]).includes(t)) return { flag: t as (typeof FLAGS)[number] };
  const m = t.match(/^(\w+)\s*(!=|<=|>=|=|<|>)\s*(.+)$/);
  if (!m || !(KEYS as readonly string[]).includes(m[1])) throw new Error(`"${src}": can't read the filter [${f}] (${[...KEYS, ...FLAGS].join(", ")})`);
  const key = m[1] as (typeof KEYS)[number];
  const raw = m[3].trim();
  const value = key === "artic" ? raw : key === "pitch" ? pitch(/^-?\d+$/.test(raw) ? Number(raw) : raw) : Number(raw);
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`"${src}": [${f}] wants a number`);
  return { key, op: m[2] as Op, value };
}

export function parseSelector(src: string): Selector {
  const filters: Filter[] = [];
  const rest = src.replace(/\[([^\]]*)\]/g, (_, f: string) => { filters.push(parseFilter(f, src)); return " "; });
  const [targets, ...words] = rest.replace("@", " ").trim().split(/\s+/);
  if (!targets) throw new Error(`"${src}": no tracks`);
  const sel: Selector = { src, tracks: targets === "*" ? "*" : targets.split(",").filter(Boolean), filters };
  for (const w of words) {
    let m: RegExpMatchArray | null;
    if ((m = w.match(/^m(\d+)(?:-(\d+))?$/))) sel.bars = [Number(m[1]), Number(m[2] ?? m[1])];
    else if ((m = w.match(/^b(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/))) {
      const from = Number(m[1]);
      const exact = !m[2] && m[1].includes(".");
      sel.beats = { from, to: m[2] ? Number(m[2]) : from, exact };
    } else if (!sel.section) sel.section = w;
    else throw new Error(`"${src}": "${w}" is a second section`);
  }
  return sel;
}

/** How much a selector outweighs another. Unknown tracks and sections are errors: a typo shouldn't pass for a miss. */
export function specificity(sel: Selector, song: Song): number {
  const ids = new Set(song.score.tracks.map((t) => t.id));
  const groups = new Set(song.score.tracks.flatMap((t) => t.group ?? []));
  let who = 0;
  if (sel.tracks !== "*") {
    for (const t of sel.tracks) if (!ids.has(t) && !groups.has(t)) throw new Error(`"${sel.src}": no track or group "${t}" (${[...ids, ...groups].join(", ")})`);
    who = sel.tracks.every((t) => ids.has(t)) ? 2 : 1;
  }
  if (sel.section && !song.sections.some((s) => s.name === sel.section)) {
    throw new Error(`"${sel.src}": no section "${sel.section}" (${song.sections.map((s) => s.name).join(", ")})`);
  }
  const where = (sel.section ? 1 : 0) + (sel.bars ? 1 : 0) + (sel.beats ? 1 : 0);
  return who * 100 + where * 10 + sel.filters.length;
}

const EPS = 1e-6;

function compare(a: number | string | undefined, op: Op, b: number | string): boolean {
  if (op === "=") return a === b;
  if (op === "!=") return a !== b;
  if (typeof a !== "number" || typeof b !== "number") return false;
  return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
}

/** The notes a selector picks, in time order. */
export function select(sel: Selector, song: Song): Note[] {
  const groupOf = new Map(song.score.tracks.map((t) => [t.id, t.group]));
  const sec = sel.section ? song.sections.find((s) => s.name === sel.section)! : undefined;
  const base = sec?.at ?? 0;
  const end = sec ? sec.at + sec.bars * sec.barBeats : song.beats;
  const picked = song.notes.filter((n) => {
    if (sel.tracks !== "*" && !sel.tracks.some((t) => t === n.track || t === groupOf.get(n.track))) return false;
    if (n.at < base - EPS || n.at >= end - EPS) return false;
    // bars count within the section named, or from the song's start
    const bar = sec ? Math.floor((n.at - base) / sec.barBeats + EPS) + 1 : barAt(song, n.at) + 1;
    if (sel.bars && (bar < sel.bars[0] || bar > sel.bars[1])) return false;
    const beat = n.at - (sec ? base + (bar - 1) * sec.barBeats : song.bars[bar - 1]) + 1;
    if (sel.beats) {
      const { from, to, exact } = sel.beats;
      if (exact ? Math.abs(beat - from) > EPS : beat < from - EPS || beat >= to + 1 - EPS) return false;
    }
    for (const f of sel.filters) {
      if ("flag" in f) { if (f.flag === "downbeat" && Math.abs(beat - 1) > EPS) return false; continue; }
      if (f.key === "n") continue;
      const v = f.key === "pitch" ? n.pitch : f.key === "dur" ? n.len : f.key === "vel" ? n.vel : n.artic;
      if (!compare(v, f.op, f.value)) return false;
    }
    return true;
  });
  // first, last and n count within each track's picks
  const order = sel.filters.filter((f) => ("flag" in f && f.flag !== "downbeat") || ("key" in f && f.key === "n"));
  if (!order.length) return picked;
  const byTrack = new Map<string, Note[]>();
  for (const n of picked) byTrack.set(n.track, [...(byTrack.get(n.track) ?? []), n]);
  const keep = new Set<Note>();
  for (const notes of byTrack.values()) {
    const starts = [...new Set(notes.map((n) => n.at))];
    notes.forEach((n) => {
      const k = starts.indexOf(n.at) + 1; // a chord counts once
      const ok = order.every((f) => ("flag" in f ? (f.flag === "first" ? k === 1 : k === starts.length) : compare(k, (f as { op: Op }).op, (f as { value: number }).value)));
      if (ok) keep.add(n);
    });
  }
  return picked.filter((n) => keep.has(n));
}
