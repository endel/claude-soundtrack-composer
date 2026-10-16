/**
 * Each track's loudness in each section of a rendered song (LUFS while it sounds, its articulations together:
 * src/mix/measure.ts), with the role it plays there when the score names one (m melody, d double, c counter,
 * h harmony, b bass, f figure, k drums).
 *
 *   node scripts/levels.ts songs/black-feather
 */
import { basename, join, resolve } from "node:path";
import { measure } from "../src/mix/measure.ts";
import { ROOT } from "../src/reaper/reaper.ts";
import { loadSongDir } from "../src/score/song.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: levels.ts <song folder>");
const { score } = loadSongDir(dir);
const levels = measure(score, join(ROOT, "out", basename(resolve(dir)), "stems"));
const names = score.sections.map((s) => s.name);
const MARK: Record<string, string> = { melody: "m", double: "d", counter: "c", harmony: "h", bass: "b", figure: "f", drums: "k" };
console.log("".padEnd(8) + names.map((s) => s.slice(0, 9).padStart(10)).join(""));
for (const [t, by] of levels) {
  const cell = (s: string) => {
    const x = by.get(s)!;
    const role = score.roles?.[s]?.[t];
    return x.seconds >= 0.4 ? `${x.lufs.toFixed(1)}${role ? MARK[role] ?? "?" : ""}` : "·";
  };
  console.log(t.padEnd(8) + names.map((s) => cell(s).padStart(10)).join(""));
}
