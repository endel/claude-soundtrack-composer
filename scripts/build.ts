/**
 * Builds a song folder (`score.yaml`, `overrides.yaml`) into `out/<song>/<song>.rpp`; `--render` has REAPER render
 * it, mixes it and prints the report. `--audition` builds only what a selector picks (build.ts).
 *
 *   node scripts/build.ts songs/demo [--render] [--audition="vln1 @ theme m3-4"]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { build, renderBuild } from "../src/build.ts";
import { readBalance } from "../src/mix/balance.ts";
import { ROOT } from "../src/reaper/reaper.ts";
import { writeRpp } from "../src/reaper/rpp.ts";
import { barAt, loadSongDir } from "../src/score/song.ts";

const dir = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!dir) throw new Error("usage: build.ts <song folder> [--render] [--audition=<selector>]");
const audition = process.argv.find((a) => a.startsWith("--audition="))?.slice(11);
const name = basename(resolve(dir)) + (audition ? "-audition" : "");
const out = join(ROOT, "out", name);
mkdirSync(out, { recursive: true });

const { score, rules } = loadSongDir(dir);
const b = build(score, rules, { out: join(out, "stems"), audition, balance: readBalance(dir) });
console.log(`${score.title}: ${b.notes.length} notes on ${b.played.length} REAPER tracks, ${b.rpp.seconds.toFixed(1)}s${b.window ? ` (bars ${barAt(b.song, b.window[0]) + 1}–${barAt(b.song, b.window[1] - 1e-6) + 1})` : ""}`);
for (const w of b.warnings) console.log(`  warning: ${w}`);

if (!process.argv.includes("--render")) {
  writeFileSync(join(out, `${name}.rpp`), writeRpp(b.rpp));
  console.log(`wrote ${join(out, `${name}.rpp`)}`);
} else {
  const r = renderBuild(b, out, name);
  for (const t of r.tracks) console.log(`  ${t.name.padEnd(22)} ${String(t.notes).padStart(3)} notes  ${t.level.toFixed(1).padStart(6)} dB playing  peak ${t.peak.toFixed(1)}${t.silent.length ? `  SILENT: ${t.silent.join(", ")}` : ""}`);
  console.log(`  mastered ${r.master.from} → ${r.master.lufs} LUFS, limiting ${r.master.limited} dB at most`);
  console.log(`wrote ${r.files.mp3}`);
  if (r.tracks.some((t) => t.silent.length)) process.exitCode = 1;
}
