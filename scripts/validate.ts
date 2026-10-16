/**
 * Checks, by rendering in REAPER and measuring the audio, that every kind of control reaches the sound:
 * - vibrato: one held note with vibrato 0 and with 1, its pitch wobble, and the wobble's rate at vibrato.rate 0 and 1
 *   (BBC SO Discover ignores its own vibrato, so REAPER's voice plays it: patches.ts VOICE);
 * - the voice at rest changes nothing (against the same note without it, sample by sample), spread 0 is mono, tone
 *   tilts the spectrum, volume 0.5 is −12 dB;
 * - tune (a plug-in parameter, automated): +2 semitones, its pitch;
 * - expression set on one bar: that bar against its neighbours;
 * - a crescendo drawn over a span of notes: each note louder than the last (BBC's dynamics are mostly tone colour:
 *   pp → ff is only about 6 dB of level);
 * - an articulation set on one note: it moves to its own track (pizz) and sounds there, and only there;
 * - timing: a note set 120 ms late lands 120 ms later; sections with their own tempo, meter and a slowing tempo put
 *   each note where the tempo map says;
 * - the drum kit through its track template: every named drum sounds; the toms tom1–tom5 fall in pitch; the mix
 *   raises the hats; another room's preset, and a room without presets (with a mix, so EZdrummer fills its mixer in
 *   first), play every hit; volume drawn over the kit (the voice after a template's chain) fades it;
 * - an audition: only the bars asked for, and they sound;
 * - repeatability: two builds write the same project; two renders' stems are compared.
 *
 *   node scripts/validate.ts
 */
import { join } from "node:path";
import { f0Track, median, wobble } from "../src/audio/pitch.ts";
import { dB, peak, rms, type Stereo } from "../src/audio/wav.ts";
import { build, renderBuild } from "../src/build.ts";
import { instrument } from "../src/patches.ts";
import { SR } from "../src/audio/wav.ts";
import { bandLevels } from "../src/audio/spectrum.ts";
import { LEAD } from "../src/perform.ts";
import { ROOT } from "../src/reaper/reaper.ts";
import { writeRpp } from "../src/reaper/rpp.ts";
import type { Score } from "../src/score/song.ts";

const OUT = join(ROOT, "out/validate");
const drums = Object.keys(instrument("ezd3").artics.default.drums!).filter((d) => !/-\d+$/.test(d));
const GROOVE = "a m1 | kick:1 hat:1 snare:1 hat:1 | kick:1 hat:1 snare:1 hat:1";

const score: Score = {
  title: "Validation", tempo: 60, meter: [4, 4], seed: 7,
  sections: [{ name: "a", bars: 4 }],
  tracks: [
    { id: "vibOff", instrument: "bbc/vc", phrases: ["a m1 | D3:4"] },
    { id: "vibOn", instrument: "bbc/vc", phrases: ["a m1 | D3:4"] },
    { id: "vibSlow", instrument: "bbc/vc", phrases: ["a m1 | D3:4"] },
    { id: "vibFast", instrument: "bbc/vc", phrases: ["a m1 | D3:4"] },
    { id: "plain", instrument: "bbc/vc", phrases: ["a m1 | D3:4"] },
    { id: "mono", instrument: "bbc/vc", phrases: ["a m1 | D3:4"] },
    { id: "dark", instrument: "bbc/vc", phrases: ["a m1 | D3:4"] },
    { id: "bright", instrument: "bbc/vc", phrases: ["a m1 | D3:4"] },
    { id: "half", instrument: "bbc/vc", phrases: ["a m1 | D3:4"] },
    { id: "tune", instrument: "bbc/vc", phrases: ["a m1 | D3:4"] },
    { id: "expr", instrument: "bbc/vc", phrases: ["a m1 | D3:4 | D3:4 | D3:4 | D3:4"] },
    { id: "cresc", instrument: "bbc/vla", phrases: ["a m1 | A3:4 | A3:4 | A3:4 | A3:4"] },
    { id: "artic", instrument: "bbc/vln1", phrases: ["a m1 | A4:1 A4:1 A4:1 A4:1"] },
    { id: "onTime", instrument: "bbc/vc", phrases: ["a m2 artic=spic | D3:1"] },
    { id: "late", instrument: "bbc/vc", phrases: ["a m2 artic=spic | D3:1"] },
    { id: "kit", instrument: "ezd3", phrases: [`a m1 | ${drums.map((d) => `${d}:1/2`).join(" ")}${drums.length % 8 ? ` r:${(8 - (drums.length % 8)) / 2}` : ""}`] },
    { id: "groove", instrument: "ezd3", phrases: [GROOVE] },
    { id: "hats", instrument: "ezd3", setup: { mix: { hats: 12 } }, phrases: [GROOVE] },
    { id: "tight", instrument: "ezd3", setup: { kit: "TightRoom/Classic Pop Basic" }, phrases: [GROOVE] },
    { id: "metal0", instrument: "ezd3", setup: { kit: "MetalMachine" }, phrases: [GROOVE] },
    { id: "metal", instrument: "ezd3", setup: { kit: "MetalMachine", mix: { hats: 12 } }, phrases: [GROOVE] },
    { id: "fade", instrument: "ezd3", phrases: [GROOVE] },
  ],
};
const TUNE_ST = 2;
const rules = [
  { select: "vibOff,vibOn,vibSlow,vibFast,plain,mono,dark,bright,half,tune", set: { dynamics: "mf" } },
  { select: "vibOff", set: { vibrato: 0 } },
  { select: "vibOn", set: { vibrato: 1 } },
  { select: "vibSlow", set: { vibrato: 1, "vibrato.rate": 0 } },
  { select: "vibFast", set: { vibrato: 1, "vibrato.rate": 1 } },
  { select: "mono", set: { spread: 0 } },
  { select: "dark", set: { tone: 0 } },
  { select: "bright", set: { tone: 1 } },
  { select: "half", set: { volume: 0.5 } },
  { select: "fade", over: "span", set: { volume: [[0, 1], [1, 0.25]] } },
  { select: "tune", set: { vibrato: 0, tune: 0.5 + TUNE_ST / 72 } }, // Global Tune spans ±36 semitones
  { select: "expr", set: { dynamics: "mf", expression: 0.9 } },
  { select: "expr @ a m3", set: { expression: 0.3 } },
  { select: "cresc", over: "span", set: { dynamics: [[0, "pp"], [1, "ff"]] } },
  { select: "artic @ a m1 b3", set: { artic: "pizz" } },
  { select: "late", set: { timing: 120 } },
];

const results: { check: string; want: string; got: string; ok: boolean | null }[] = [];
const check = (name: string, want: string, got: string, ok: boolean | null) => results.push({ check: name, want, got, ok });

const b = build(score, rules, { out: join(OUT, "stems") });
for (const w of b.warnings) console.log(`warning: ${w}`);
const r = renderBuild(b, OUT, "validate");
const stem = (name: string): Stereo => { const s = r.stems.get(name); if (!s) throw new Error(`no stem "${name}"`); return s; };
const playedOf = (name: string) => b.played.find((p) => p.rpp.name === name)!;
const noteLevels = (name: string) => playedOf(name).notes.map((x) => dB(rms(stem(name), x.on + 0.15, x.off)));

// vibrato
const sus = (name: string) => f0Track(stem(name), LEAD + 1, LEAD + 3.6, 100, 300);
const [off, on] = [wobble(sus("vibOff")), wobble(sus("vibOn"))];
const vib = instrument("bbc/vc").artics.long.controls.vibrato;
check(`vibrato 0 → 1 (${"voice" in vib ? "REAPER's voice" : "the instrument's"})`, "wobble ×3 and > 15 cents", `${off.toFixed(1)} → ${on.toFixed(1)} cents`, on > 3 * off && on > 15);
// the wobble's rate: crossings of the track's median, two a cycle
const rateOf = (f0: number[]): number => {
  const m = median(f0);
  const v = f0.filter(Number.isFinite).map((f) => f - m);
  let n = 0;
  for (let i = 1; i < v.length; i++) if (Math.sign(v[i]) !== Math.sign(v[i - 1])) n++;
  return n / 2 / ((v.length * 512) / SR);
};
const [slow, fast] = [rateOf(sus("vibSlow")), rateOf(sus("vibFast"))];
check("vibrato.rate 0 → 1", "about 3 Hz → 8 Hz", `${slow.toFixed(1)} → ${fast.toFixed(1)} Hz`, slow > 2 && slow < 4.5 && fast > 6.5 && fast < 10);

// the voice at rest, and its other controls
const nm = (id: string) => b.played.find((p) => p.track.id === id)!.rpp.name;
const span = (s: Stereo) => ({ a: Math.round((LEAD + 0.5) * SR), b: Math.round((LEAD + 3.5) * SR), s });
const ratio = (num: (i: number) => number, den: (i: number) => number, a: number, z: number) => {
  let x = 0;
  let y = 0;
  for (let i = a; i < z; i++) { x += num(i) ** 2; y += den(i) ** 2; }
  return 10 * Math.log10(x / Math.max(y, 1e-30));
};
{
  const p = span(stem(nm("plain")));
  const v = stem(nm("vibOff"));
  const d = ratio((i) => p.s.l[i] - v.l[i], (i) => p.s.l[i], p.a, p.b);
  check("voice at rest", "the same as without it (≤ −60 dB apart)", `${d.toFixed(1)} dB apart`, d <= -60);
  const m = span(stem(nm("mono")));
  const side = ratio((i) => m.s.l[i] - m.s.r[i], (i) => m.s.l[i] + m.s.r[i], m.a, m.b);
  const side0 = ratio((i) => p.s.l[i] - p.s.r[i], (i) => p.s.l[i] + p.s.r[i], p.a, p.b);
  check("spread 0", "mono: L − R ≥ 60 dB under L + R", `${side0.toFixed(1)} dB → ${side.toFixed(1)} dB`, side <= -60);
  // the spectrum's tilt: 3–12 kHz against below 300 Hz
  const tilt = (s: Stereo) => { const [lo, , hi] = bandLevels(s, LEAD + 0.5, [20, 300, 3000, 12000]); return hi - lo; };
  const [dk, br] = [tilt(stem(nm("dark"))), tilt(stem(nm("bright")))];
  check("tone 0 → 1", "highs over lows ≥ 12 dB up", `${dk.toFixed(1)} → ${br.toFixed(1)} dB`, br - dk >= 12);
  const h = dB(rms(stem(nm("half")), LEAD + 0.5, LEAD + 3.5)) - dB(rms(p.s, LEAD + 0.5, LEAD + 3.5));
  check("volume 0.5", "−12 ± 0.5 dB", `${h.toFixed(2)} dB`, Math.abs(h + 12) <= 0.5);
}

// tune
const shift = 1200 * Math.log2(median(sus("tune")) / median(sus("vibOff")));
check("tune parameter +2 st", "+200 ± 25 cents", `${shift >= 0 ? "+" : ""}${shift.toFixed(0)} cents`, Math.abs(shift - 100 * TUNE_ST) <= 25);

// expression on one bar
const exprName = b.played.find((p) => p.track.id === "expr")!.rpp.name;
const el = noteLevels(exprName);
check("expression 0.3 on bar 3", "bar 3 ≥ 6 dB under bars 2 and 4", el.map((v) => v.toFixed(1)).join(" / ") + " dB", el[2] < el[1] - 6 && el[2] < el[3] - 6);

// crescendo
const crName = b.played.find((p) => p.track.id === "cresc")!.rpp.name;
const cl = noteLevels(crName);
check("crescendo pp → ff over a span", "each bar louder, ≥ 3 dB overall", cl.map((v) => v.toFixed(1)).join(" < ") + " dB", cl.every((v, i) => i === 0 || v > cl[i - 1]) && cl[3] - cl[0] >= 3);

// articulation
const longP = b.played.find((p) => p.track.id === "artic" && p.artic === "long")!;
const pizzP = b.played.find((p) => p.track.id === "artic" && p.artic === "pizz");
if (!pizzP) check("artic pizz on one note", "its own track", "none", false);
else {
  const win = (s: Stereo, beat: number) => dB(rms(s, LEAD + beat + 0.02, LEAD + beat + 0.5));
  const pz = [0, 1, 2, 3].map((k) => win(stem(pizzP.rpp.name), k));
  const lg = [0, 1, 2, 3].map((k) => win(stem(longP.rpp.name), k));
  check("artic pizz on one note", "track \"(pizz)\" with 1 note, heard on beat 3 only", `${pizzP.rpp.name}: ${pizzP.notes.length} note; pizz ${pz.map((v) => v.toFixed(0)).join("/")} dB, long ${lg.map((v) => v.toFixed(0)).join("/")} dB`,
    pizzP.notes.length === 1 && longP.notes.length === 3 && pz[2] > pz[0] + 12 && pz[2] > pz[1] + 12);
}

// timing
const onset = (s: Stereo, from: number): number => {
  const env = Array.from({ length: 160 }, (_, w) => rms(s, from + w * 0.005, from + w * 0.005 + 0.005));
  const pk = Math.max(...env);
  return from + env.findIndex((v) => v >= pk / 4) * 0.005;
};
const nameOf = (id: string) => b.played.find((p) => p.track.id === id)!.rpp.name;
const dt = (onset(stem(nameOf("late")), LEAD + 4 - 0.2) - onset(stem(nameOf("onTime")), LEAD + 4 - 0.2)) * 1000;
check("timing +120 ms", "lands 120 ± 15 ms later", `${dt.toFixed(0)} ms`, Math.abs(dt - 120) <= 15);

// tempo and meter by section: clicks at 0 s, 4 s (a 4/4 bar at 60), 7 s (two 3/4 bars at 120), then 120 → 60 over
// a bar: its third beat 4·ln(4/3) s in
const timed: Score = {
  title: "Tempo", tempo: 60, meter: [4, 4], seed: 7,
  sections: [{ name: "slow", bars: 1 }, { name: "waltz", bars: 2, meter: [3, 4], tempo: 120 }, { name: "rit", bars: 1, tempo: [120, 60] }],
  tracks: [{ id: "clicks", instrument: "bbc/vc", phrases: ["slow m1 artic=spic | D3:1 r:3 | D3:1 r:2 | r:3 | D3:1 r:1 D3:1 r:1"] }],
};
const tb = build(timed, [], { out: join(OUT, "tempo/stems") });
const tr = renderBuild(tb, join(OUT, "tempo"), "tempo");
const clicks = tr.stems.get(tb.played[0].rpp.name)!;
const heard = tb.played[0].notes.map((x) => onset(clicks, x.on - 0.2));
const wantAt = [0, 4, 7, 7 + 4 * Math.log(4 / 3)];
const drift = heard.map((t, i) => (t - heard[0] - wantAt[i]) * 1000);
check("tempo and meter by section", "clicks at 0, 4, 7, 8.151 s ± 15 ms", `${heard.map((t) => (t - heard[0]).toFixed(3)).join(", ")} s (worst ${Math.max(...drift.map(Math.abs)).toFixed(0)} ms off)`, drift.every((x) => Math.abs(x) <= 15));

// the kit
const sounds = (id: string) => r.tracks.find((t) => t.name === nameOf(id))!;
const kit = sounds("kit");
check(`EZdrummer: ${kit.notes} named drums`, "every one sounds", kit.silent.length ? `silent: ${kit.silent.join(", ")}` : `all sound, ${kit.level.toFixed(1)} dB playing`, kit.silent.length === 0);
const tomHz = [1, 2, 3, 4, 5].map((k) => drums.indexOf(`tom${k}`) / 2).map((at) => median(f0Track(stem(nameOf("kit")), LEAD + at + 0.03, LEAD + at + 0.45, 50, 400)));
check("tom1 … tom5", "each lower than the last", tomHz.map((f) => f.toFixed(0)).join(" > ") + " Hz", tomHz.every((f, i) => i === 0 || f < tomHz[i - 1]));
const hits = (id: string, beats: number[]) => beats.map((k) => dB(rms(stem(nameOf(id)), LEAD + k, LEAD + k + 0.3)));
const HATS = [1, 3, 5, 7];
const gain = (id: string, base: string, beats: number[]) => { const x = hits(id, beats), y = hits(base, beats); return x.reduce((s, v, i) => s + v - y[i], 0) / x.length; };
const [hatUp, kickUp] = [gain("hats", "groove", HATS), gain("hats", "groove", [0, 4])];
check("kit mix { hats: +12 }", "hats ≥ 5 dB up, the kick within 1 dB", `hats ${hatUp >= 0 ? "+" : ""}${hatUp.toFixed(1)} dB, kick ${kickUp >= 0 ? "+" : ""}${kickUp.toFixed(1)} dB`, hatUp >= 5 && Math.abs(kickUp) <= 1);
for (const [id, what] of [["tight", "kit TightRoom/Classic Pop Basic"], ["metal0", "kit MetalMachine (no presets)"]] as const) {
  const t = sounds(id);
  const apart = ratio((i) => stem(nameOf(id)).l[i] - stem(nameOf("groove")).l[i], (i) => stem(nameOf("groove")).l[i], Math.round(LEAD * SR), Math.round((LEAD + 8) * SR));
  check(`${what}`, "every hit sounds, not the default kit", `${t.silent.length ? `silent: ${t.silent.join(", ")}` : "all sound"}; ${apart.toFixed(1)} dB from MainRoom`, !t.silent.length && apart > -10);
}
const [mHat, mKick] = [gain("metal", "metal0", HATS), gain("metal", "metal0", [0, 4])];
check("MetalMachine mix { hats: +12 }", "hats ≥ 5 dB up, the kick within 1 dB", `hats ${mHat >= 0 ? "+" : ""}${mHat.toFixed(1)} dB, kick ${mKick >= 0 ? "+" : ""}${mKick.toFixed(1)} dB`, mHat >= 5 && Math.abs(mKick) <= 1);
// each hit as much under the same groove without the fade as the curve says there: volume v is v² in gain
const BEATS = [0, 1, 2, 3, 4, 5, 6, 7];
const fade = hits("fade", BEATS).map((v, i) => v - hits("groove", BEATS)[i]);
const want = BEATS.map((k) => 40 * Math.log10(1 - (0.75 * k) / 8));
const worst = Math.max(...fade.map((v, i) => Math.abs(v - want[i])));
check("volume 1 → 0.25 drawn over the kit", "each hit where the curve is, ± 1 dB", `${fade.map((v) => v.toFixed(1)).join(" ")} dB (worst ${worst.toFixed(1)} off)`, worst <= 1);

// audition
const a = build(score, rules, { out: join(OUT, "audition/stems"), audition: "expr @ a m3" });
const ar = renderBuild(a, join(OUT, "audition"), "audition");
check("audition \"expr @ a m3\"", "bars 2–3 of expr only, sounding", `bars ${a.window![0] / 4 + 1}–${a.window![1] / 4}, tracks ${ar.tracks.map((t) => `${t.name} (${t.notes})`).join(", ")}, silent ${ar.tracks.flatMap((t) => t.silent).length}`,
  a.window![0] === 4 && a.window![1] === 12 && ar.tracks.length === 1 && ar.tracks[0].notes === 2 && !ar.tracks[0].silent.length);

// repeatability
const again = build(score, rules, { out: join(OUT, "again/stems") });
const same = writeRpp({ ...again.rpp, out: b.rpp.out }) === writeRpp(b.rpp); // only where the stems go differs
check("two builds", "the same project, byte for byte", same ? "identical" : "different", same);
const r2 = renderBuild(again, join(OUT, "again"), "validate");
const differ: string[] = [];
for (const [name, s] of r.stems) {
  const t = r2.stems.get(name)!;
  let d = 0;
  for (let i = 0; i < Math.min(s.l.length, t.l.length); i++) d = Math.max(d, Math.abs(s.l[i] - t.l[i]), Math.abs(s.r[i] - t.r[i]));
  if (d > 0) differ.push(`${name} ${(dB(d) - dB(peak(s))).toFixed(0)} dB`);
}
check("two renders", "stems compared (informational)", differ.length ? `differ: ${differ.join(", ")}; the rest bit-identical` : "bit-identical", null);

console.log("");
for (const x of results) console.log(`${x.ok === null ? "INFO" : x.ok ? "PASS" : "FAIL"}  ${x.check.padEnd(34)} want ${x.want.padEnd(40)} got ${x.got}`);
if (results.some((x) => x.ok === false)) process.exitCode = 1;
