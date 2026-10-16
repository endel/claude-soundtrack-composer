/**
 * Probes a template instrument (`patches/<id>`): plays every note from 108 down to 21 (top down, so keyswitches under
 * a range can't switch it mid-probe), and writes into `patches/<id>.json` the notes that sound, the range they span
 * and the attack lag. With `--kit`, it also names the sounding notes by General MIDI as the `drums` map, unless the
 * file has one already or the kit names its own (`"setup": "ezdrummer"`: patches.ts reads EZdrummer's from the kit).
 * GM's names are guesses: check them by ear.
 *
 * A kit's notes are spaced 6 s apart (`--gap`), so a cymbal has died away before the next is judged.
 *
 *   node scripts/probe.ts <id> [--kit] [--gap=<s>]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dB, rms } from "../src/audio/wav.ts";
import { templateChain } from "../src/plugins/template.ts";
import { ROOT, render } from "../src/reaper/reaper.ts";
import type { MidiEvent } from "../src/reaper/rpp.ts";
import { pitchName } from "../src/score/song.ts";

const GM: Record<number, string> = {
  35: "kick2", 36: "kick", 37: "sidestick", 38: "snare", 39: "clap", 40: "snare2", 41: "tom-floor-lo", 42: "hat",
  43: "tom-floor", 44: "hat-pedal", 45: "tom-lo", 46: "hat-open", 47: "tom-lo-mid", 48: "tom-hi-mid", 49: "crash",
  50: "tom-hi", 51: "ride", 52: "china", 53: "ride-bell", 54: "tambourine", 55: "splash", 56: "cowbell", 57: "crash2",
  59: "ride2",
};

const id = process.argv[2];
if (!id) throw new Error("usage: probe.ts <id> [--kit]");
const kit = process.argv.includes("--kit");
const json = join(ROOT, "patches", `${id}.json`);
const chain = templateChain(join(ROOT, "patches", `${id}.RTrackTemplate`));

const START = 1;
const STEP = Number(process.argv.find((a) => a.startsWith("--gap="))?.slice(6) ?? (kit ? 6 : 0.7));
const TOP = 108;
const LOW = 21;
const tOf = (m: number) => START + (TOP - m) * STEP;
const events: MidiEvent[] = [];
for (let m = TOP; m >= LOW; m--) events.push({ t: tOf(m), msg: [0x90, m, 100] }, { t: tOf(m) + 0.15, msg: [0x80, m, 0] });
const seconds = tOf(LOW) + 2;
const t0 = Date.now();
const out = join(ROOT, "out/probe", id);
const warmup = existsSync(json) ? (JSON.parse(readFileSync(json, "utf8")).warmup ?? 12) : 12;
const stems = render({ bpm: 120, num: 4, den: 4, seconds, out, tracks: [{ name: id, fx: { chain }, events }] }, join(ROOT, "out/probe", `${id}.rpp`), { warmup });
const s = stems.get(id)!;
console.log(`${id}: rendered ${(TOP - LOW + 1)} notes in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const lv = new Map<number, { level: number; rise: number }>();
for (let m = TOP; m >= LOW; m--) {
  const t = tOf(m);
  const level = dB(rms(s, t, t + 0.2));
  lv.set(m, { level, rise: level - dB(rms(s, t - 0.12, t - 0.02)) });
}
const top = Math.max(...[...lv.values()].map((v) => v.level));
const sounding = [...lv].filter(([, v]) => v.level > top - 40 && v.rise > 6).map(([m]) => m).sort((a, b) => a - b);
if (!sounding.length) throw new Error(`${id}: no note sounded (loudest ${top.toFixed(1)} dBFS)`);

// lag: note-on to the envelope (5 ms windows) first reaching 12 dB under its peak, the median
const lags = sounding.map((m) => {
  const env = Array.from({ length: 80 }, (_, w) => rms(s, tOf(m) + w * 0.005, tOf(m) + w * 0.005 + 0.005));
  const pk = Math.max(...env);
  return env.findIndex((v) => v >= pk / 4) * 0.005;
}).sort((a, b) => a - b);
const lag = lags[Math.floor(lags.length / 2)];

const f = existsSync(json) ? JSON.parse(readFileSync(json, "utf8")) : {};
f.range = [sounding[0], sounding[sounding.length - 1]];
f.sounding = sounding;
f.lag = lag;
if (kit && !f.drums && !f.setup) f.drums = Object.fromEntries(sounding.map((m) => [GM[m] ?? `n${m}`, m]));
writeFileSync(json, JSON.stringify(f, null, 1) + "\n");
console.log(`  sounding: ${sounding.length} notes, ${pitchName(sounding[0])}–${pitchName(sounding[sounding.length - 1])}; lag ${(lag * 1000).toFixed(0)} ms`);
console.log(`  ${sounding.map((m) => `${m}${GM[m] ? `=${GM[m]}` : ""} ${lv.get(m)!.level.toFixed(0)}dB`).join(", ")}`);
console.log(`wrote ${json}`);
