/**
 * A rendered song's loudness per track and section: the stems of one track (one per articulation) summed, then
 * K-weighted (audio/loudness.ts), section by section in the song's own time.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { kWeight, loudness } from "../audio/loudness.ts";
import { readWav, type Stereo } from "../audio/wav.ts";
import { LEAD } from "../perform.ts";
import { layout, type Score } from "../score/song.ts";
import type { Levels } from "./balance.ts";

export function measure(score: Score, stems: string): Levels {
  if (!existsSync(stems)) throw new Error(`no stems in ${stems}: render the song first`);
  const files = readdirSync(stems).filter((f) => f.endsWith(".wav"));
  const lay = layout(score.sections, score.meter, score.tempo);
  const levels: Levels = new Map();
  for (const t of score.tracks) {
    const name = t.name ?? t.id;
    const mine = files.filter((f) => f === `${name}.wav` || (f.startsWith(`${name} (`) && f.endsWith(").wav")));
    if (!mine.length) continue;
    let sum: Stereo | undefined;
    for (const f of mine) {
      const w = readWav(join(stems, f));
      if (!sum) sum = { l: Float32Array.from(w.l), r: Float32Array.from(w.r) };
      else for (let i = 0; i < Math.min(sum.l.length, w.l.length); i++) { sum.l[i] += w.l[i]; sum.r[i] += w.r[i]; }
    }
    const k = { l: kWeight(sum!.l), r: kWeight(sum!.r) };
    const by = new Map<string, { lufs: number; seconds: number }>();
    lay.sections.forEach((s, i) => {
      const end = lay.sections[i + 1]?.sec ?? s.sec + 1e6;
      by.set(s.name, loudness(sum!, k, LEAD + s.sec, LEAD + end));
    });
    levels.set(t.id, by);
  }
  return levels;
}
