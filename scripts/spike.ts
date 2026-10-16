/**
 * The first test: four bars of strings on BBC SO Discover (i–VI–iv–V in D minor), built as a REAPER project with no
 * hand-made template and rendered by REAPER. Every note is shaped: its own velocity, a dynamics curve (CC1) over the
 * phrase, and on the violins' last note a vibrato (CC21) that blooms. Each track's resting vibrato and release are
 * set in the plug-in's saved state instead.
 *
 * Then the checks: every note sounds, and a control set only in the state (expression at 1.0 vs 0.4, no CC11 sent)
 * really changes the level. Writes out/spike/spike.mp3.
 *
 *   node scripts/spike.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dB, peak, rms, writeWav, SR, type Stereo } from "../src/audio/wav.ts";
import { bbc, ccOf, type ControlName } from "../src/plugins/bbc.ts";
import { ROOT, render } from "../src/reaper/reaper.ts";
import type { MidiEvent, RppTrack } from "../src/reaper/rpp.ts";

const OUT = join(ROOT, "out/spike");
const BPM = 72;
const PRE = 1; // s before beat 0, so a part played early for its attack still fits
const TAIL = 3;
const probed: Record<string, { lo: number; hi: number; lag: number }> = JSON.parse(readFileSync(join(ROOT, "data/bbc-probed.json"), "utf8"));

/** [beat, value] */
type Point = [number, number];

interface Note {
  m: number;
  /** Beats. */
  at: number;
  len: number;
  vel: number;
  /** The vibrato over the note: [fraction of the note, 0–127]. */
  vib?: Point[];
}

const sec = (beat: number): number => PRE + (beat * 60) / BPM;

const STEPS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function pitch(s: string): number {
  const m = s.match(/^([A-G])(#|b)?(-?\d)$/);
  if (!m) throw new Error(`not a pitch: ${s}`);
  return STEPS[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (Number(m[3]) + 1) * 12;
}

/** "A4:4 D5:2" laid end to end from beat 0, with a velocity each. */
function line(text: string, vels: number[]): Note[] {
  let at = 0;
  return text.split(/\s+/).map((w, i) => {
    const [p, d] = w.split(":");
    const n = { m: pitch(p), at, len: Number(d), vel: vels[i] ?? vels.at(-1)! };
    at += n.len;
    return n;
  });
}

/** A controller curve as CC events every eighth of a beat, straight between its points. */
function ccCurve(cc: number, pts: Point[], step = 0.125): MidiEvent[] {
  const out: MidiEvent[] = [];
  let last = -1;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [b0, v0] = pts[k];
    const [b1, v1] = pts[k + 1];
    for (let b = b0; b < b1 || (k + 2 === pts.length && b <= b1); b += step) {
      const v = Math.round(v0 + ((v1 - v0) * (b - b0)) / (b1 - b0 || 1));
      if (v !== last) out.push({ t: sec(Math.min(b, b1)), msg: [0xb0, cc, v] });
      last = v;
    }
  }
  return out;
}

const noteEvents = (n: Note): MidiEvent[] => [
  { t: sec(n.at), msg: [0x90, n.m, n.vel] },
  { t: sec(n.at + n.len) - 0.02, msg: [0x80, n.m, 0] }, // a breath short, so the next note re-attacks
];

interface Part { name: string; preset: string; patch: string; notes: Note[]; rest: Partial<Record<ControlName, number>> }

const DYN: Point[] = [[0, 45], [4, 70], [9, 98], [12, 90], [14, 72], [16, 40]];
const REST = { vibrato: 0.35, release: 0.6 };

const parts: Part[] = [
  {
    name: "Violins 1", preset: "Strings_Violins_1", patch: "vln1-long", rest: REST,
    notes: line("A4:4 D5:2 C5:2 Bb4:4 A4:4", [70, 82, 70, 76, 84]),
  },
  { name: "Violins 2", preset: "Strings_Violins_2", patch: "vln2-long", rest: REST, notes: line("F4:4 F4:4 G4:4 E4:4", [64]) },
  { name: "Violas", preset: "Strings_Violas", patch: "vla-long", rest: REST, notes: line("D4:4 D4:4 D4:4 C#4:4", [64]) },
  { name: "Celli", preset: "Strings_Celli", patch: "vc-long", rest: REST, notes: line("D3:4 Bb2:4 G2:4 A2:4", [70]) },
];
// the violins' last note: the vibrato held back, then blooming and easing as it fades
parts[0].notes.at(-1)!.vib = [[0, 10], [0.2, 10], [0.7, 118], [1, 80]];

const tracks: RppTrack[] = parts.map((p) => {
  const events: MidiEvent[] = [{ t: 0, msg: [0xb0, ccOf(p.preset, "expression"), 118] }, ...ccCurve(ccOf(p.preset, "dynamics"), DYN)];
  for (const n of p.notes) {
    events.push(...noteEvents(n));
    if (n.vib) {
      const cc = ccOf(p.preset, "vibrato");
      events.push(...ccCurve(cc, n.vib.map(([f, v]) => [n.at + f * n.len, v])), { t: sec(n.at + n.len), msg: [0xb0, cc, Math.round(REST.vibrato * 127)] });
    }
  }
  const lo = probed[p.patch].lo;
  const hi = probed[p.patch].hi;
  for (const n of p.notes) if (n.m < lo || n.m > hi) throw new Error(`${p.name}: ${n.m} is outside ${lo}–${hi}`);
  return { name: p.name, fx: bbc(p.preset, "Long", p.rest), events, offset: -probed[p.patch].lag };
});

// the state-only check: the same cello note, expression resting at 1.0 and at 0.4, no CC11
const testNote = (vel: number): MidiEvent[] => [{ t: 0, msg: [0xb0, 1, 90] }, { t: 1, msg: [0x90, 50, vel] }, { t: 4, msg: [0x80, 50, 0] }];
const TESTS: [string, number][] = [["test expression 1.0", 1], ["test expression 0.4", 0.4]];
for (const [name, v] of TESTS) tracks.push({ name, fx: bbc("Strings_Celli", "Long", { expression: v }), events: testNote(80) });

mkdirSync(OUT, { recursive: true });
const seconds = sec(16) + TAIL;
const t0 = Date.now();
const stems = render({ bpm: BPM, num: 4, den: 4, seconds, out: join(OUT, "stems"), tracks }, join(OUT, "spike.rpp"));
console.log(`rendered ${tracks.length} tracks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// every note sounds: its level against the loudest note of its track
let silent = 0;
for (const p of parts) {
  const s = stems.get(p.name)!;
  const lv = p.notes.map((n) => dB(rms(s, sec(n.at) + 0.1, sec(n.at + n.len))));
  const top = Math.max(...lv);
  const quiet = p.notes.filter((_, i) => lv[i] < top - 30);
  silent += quiet.length;
  console.log(`  ${p.name.padEnd(10)} peak ${dB(peak(s)).toFixed(1)} dBFS, notes ${lv.map((v) => v.toFixed(0)).join(" / ")} dB${quiet.length ? `  SILENT: ${quiet.map((n) => n.m).join(", ")}` : ""}`);
}

const [hi, lo] = TESTS.map(([name]) => dB(rms(stems.get(name)!, 1.5, 3.5)));
console.log(`state-only expression: 1.0 → ${hi.toFixed(1)} dB, 0.4 → ${lo.toFixed(1)} dB (${(lo - hi).toFixed(1)} dB)${hi - lo < 3 ? "  NO EFFECT" : ""}`);

// the mix: the parts summed, peak at −1 dBFS
const n = Math.round(seconds * SR);
const mix: Stereo = { l: new Float32Array(n), r: new Float32Array(n) };
for (const p of parts) {
  const s = stems.get(p.name)!;
  for (let i = 0; i < Math.min(n, s.l.length); i++) { mix.l[i] += s.l[i]; mix.r[i] += s.r[i]; }
}
const g = 10 ** (-1 / 20) / Math.max(1e-9, peak(mix));
for (let i = 0; i < n; i++) { mix.l[i] *= g; mix.r[i] *= g; }
writeWav(join(OUT, "spike.wav"), mix);
const enc = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(OUT, "spike.wav"), "-q:a", "2", join(OUT, "spike.mp3")], { encoding: "utf8" });
if (enc.status !== 0) throw new Error(`ffmpeg: ${enc.stderr}`);
console.log(`wrote ${join(OUT, "spike.mp3")} (and spike.rpp beside it, to open in REAPER)`);
if (silent) process.exitCode = 1;
