/**
 * Where each instrument sounds its best (sounding pitch), as an orchestrator places it: a melody in the upper part of
 * it, a bass in the lower, harmony and figures in the middle. A part's `register`, or its track's, overrides it; an
 * instrument not listed uses its whole range.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../reaper/reaper.ts";
import { pitch } from "../score/song.ts";

const SWEET: Record<string, [string, string]> = {
  "bbc/vln1": ["D4", "A6"], "bbc/vln2": ["D4", "A6"], "bbc/vla": ["G3", "C6"], "bbc/vc": ["C2", "E5"], "bbc/cb": ["C1", "G2"],
  "bbc/hn": ["F3", "F5"], "bbc/tpt": ["C4", "C6"], "bbc/tbn": ["A2", "F4"], "bbc/btb": ["Bb1", "F4"], "bbc/tba": ["D1", "Bb3"],
  "bbc/fl": ["G4", "G6"], "bbc/picc": ["D5", "C8"], "bbc/ob": ["D4", "D6"], "bbc/cl": ["G3", "G6"], "bbc/bsn": ["D2", "D4"],
  "bbc/harp": ["C2", "C7"], "bbc/celeste": ["C4", "C7"], "bbc/timpani": ["C3", "A3"], "bbc/bells": ["C#4", "G5"],
  "bbc/glock": ["G5", "C8"], "bbc/marimba": ["C2", "C7"], "bbc/xylo": ["F4", "C8"], "bbc/piano": ["C2", "C7"],
};

/** Each role's share of the sweet range, from its bottom (0) to its top (1). */
const SHARE: Record<string, [number, number]> = {
  melody: [0.3, 1], counter: [0.15, 0.75], harmony: [0.15, 0.8], figure: [0.1, 0.8], bass: [0, 0.55], drums: [0, 1], double: [0, 1],
};

/** Where a part of `role` plays on `instrument`, within what it can play. */
export function comfort(instrument: string, playable: [number, number], role: string): [number, number] {
  const sweet = SWEET[instrument];
  const [a, b] = sweet ? [pitch(sweet[0]), pitch(sweet[1])] : playable;
  const [x, y] = SHARE[role] ?? [0, 1];
  let lo = Math.max(playable[0], Math.round(a + x * (b - a)));
  let hi = Math.min(playable[1], Math.round(a + y * (b - a)));
  // an octave at least, so every pitch class has a place
  if (hi - lo < 12) hi = Math.min(playable[1], lo + 12);
  if (hi - lo < 12) lo = Math.max(playable[0], hi - 12);
  return [lo, hi];
}

/** How much quieter than the melody each role plays: a dynamic mark is about 0.13. */
export const ROLE_DROP: Record<string, number> = { melody: 0, double: 0, counter: 0.06, bass: 0.06, figure: 0.12, harmony: 0.14, drums: 0 };

const REF = -30;

/**
 * The fader (dB) that brings an instrument to the others' loudness: scripts/audit.ts measured each playing one note
 * at the same dynamics (catalog/effect), and horns came out 9 dB over violins, a harp 13 under them.
 */
export function trim(instrument: string): number {
  const f = join(ROOT, "catalog/effect", `${instrument.replace("/", "-")}.json`);
  if (!existsSync(f)) return 0;
  const { level } = JSON.parse(readFileSync(f, "utf8")) as { level?: number };
  return typeof level === "number" ? Math.max(-12, Math.min(12, Math.round(REF - level))) : 0;
}
