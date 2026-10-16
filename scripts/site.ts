/**
 * The demo page's data (docs/peaks.json): each mp3 in docs/audio/ as a waveform's peaks, so the page draws it
 * before anything downloads, and for a song of songs/ the second each section starts, so the page can mark them.
 *
 *   node scripts/site.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LEAD } from "../src/perform.ts";
import { ROOT } from "../src/reaper/reaper.ts";
import { layout, loadSongDir } from "../src/score/song.ts";

const AUDIO = join(ROOT, "docs/audio");
const BARS = 320;
const RATE = 8000;

const out: Record<string, { seconds: number; peaks: number[]; sections?: { name: string; at: number }[] }> = {};
for (const f of readdirSync(AUDIO).filter((f) => f.endsWith(".mp3")).sort()) {
  const id = f.slice(0, -4);
  const dec = spawnSync("ffmpeg", ["-v", "error", "-i", join(AUDIO, f), "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  if (dec.status !== 0) throw new Error(`ffmpeg: ${dec.stderr}`);
  const pcm = new Float32Array(dec.stdout.buffer, dec.stdout.byteOffset, dec.stdout.byteLength / 4);
  const per = Math.max(1, Math.floor(pcm.length / BARS));
  const rms = Array.from({ length: BARS }, (_, k) => {
    let e = 0;
    for (let i = k * per; i < Math.min(pcm.length, (k + 1) * per); i++) e += pcm[i] * pcm[i];
    return Math.sqrt(e / per);
  });
  const top = Math.max(...rms, 1e-9);
  // a little compression, so quiet passages still show
  const peaks = rms.map((v) => +Math.sqrt(v / top).toFixed(3));
  const song = join(ROOT, "songs", id);
  let sections: { name: string; at: number }[] | undefined;
  if (existsSync(join(song, "score.yaml"))) {
    const { score } = loadSongDir(song);
    sections = layout(score.sections, score.meter, score.tempo).sections.map((s) => ({ name: s.name, at: +(s.sec + LEAD).toFixed(2) }));
  }
  out[id] = { seconds: +(pcm.length / RATE).toFixed(2), peaks, ...(sections ? { sections } : {}) };
  console.log(`${id}: ${out[id].seconds}s${sections ? `, ${sections.length} sections` : ""}`);
}
writeFileSync(join(ROOT, "docs/peaks.json"), JSON.stringify(out) + "\n");
