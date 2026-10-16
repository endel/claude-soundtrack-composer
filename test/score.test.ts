import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build, crop } from "../src/build.ts";
import type { Instrument, Patch } from "../src/patches.ts";
import { perform } from "../src/perform.ts";
import { templateChain } from "../src/plugins/template.ts";
import { writeRpp } from "../src/reaper/rpp.ts";
import { cascade } from "../src/score/cascade.ts";
import { parseSelector, select, specificity } from "../src/score/select.ts";
import { compose, pitch, place, where, type Score } from "../src/score/song.ts";
import { level, MARKS, resolve, valueAt } from "../src/score/values.ts";

const fx = { name: "VSTi: Test", file: "t.vst", id: 1, tag: "<00>", outs: 2, chunk: Buffer.from("state") };
const patch = (id: string, o: Partial<Patch> = {}): Patch => ({
  id, fx, lag: 0.1, range: [40, 90], always: ["dynamics"], native: {},
  controls: { dynamics: { cc: 1, rest: 0.5 }, vibrato: { cc: 21, rest: 0.3 }, tune: { param: 11, rest: 0.5 } }, ...o,
});
const INST: Record<string, Instrument> = {
  strings: { id: "strings", name: "Strings", default: "long", inert: [], artics: { long: patch("s/long"), pizz: patch("s/pizz", { lag: 0 }) } },
  kit: { id: "kit", name: "Kit", default: "default", inert: [], artics: { default: patch("kit", { lag: 0, range: undefined, drums: { kick: 36, snare: 38, hat: 42 }, always: [] }) } },
};
const inst = (id: string) => INST[id];
const drumsOf = (t: { instrument: string }) => inst(t.instrument).artics[inst(t.instrument).default].drums;
const offer = { controls: (t: string) => (t === "drums" ? [] : ["dynamics", "vibrato", "tune"]), artics: (t: string) => (t === "drums" ? ["default"] : ["long", "pizz"]), inert: (t: string) => (t === "vc" ? ["tune"] : []) };

const SCORE: Score = {
  title: "Test", tempo: 60, meter: [4, 4], seed: 1,
  sections: [{ name: "intro", bars: 2 }, { name: "theme", bars: 2 }],
  tracks: [
    { id: "vln", instrument: "strings", group: "strings", phrases: ["intro m1 | A4:4 | D5:2 C5:1 Bb4:1", "theme m1 vel=90 | D4+A4:4 | G4:2@100 F4:1!pizz r:1"] },
    { id: "vc", instrument: "strings", group: "strings", phrases: ["m1 | D3:8 | G2:4 A2:4"] },
    { id: "drums", instrument: "kit", phrases: ["theme m1 | kick+hat:1 hat:1 snare+hat:1 hat:1"] },
  ],
};
const song = () => compose(SCORE, drumsOf);
const at = (track: string, beat: number, p?: number) => song().notes.find((n) => n.track === track && n.at === beat && (p === undefined || n.pitch === p))!;

test("pitches", () => {
  assert.equal(pitch("A4"), 69);
  assert.equal(pitch("Bb3"), 58);
  assert.equal(pitch("C#5"), 73);
  assert.equal(pitch("C-1"), 0);
  assert.throws(() => pitch("H2"));
});

test("phrases lay notes end to end, with chords, rests, drums, velocities and articulations", () => {
  const s = song();
  assert.equal(s.beats, 16);
  const vln = s.notes.filter((n) => n.track === "vln");
  assert.deepEqual(vln.map((n) => [n.pitch, n.at, n.len]), [[69, 0, 4], [74, 4, 2], [72, 6, 1], [70, 7, 1], [62, 8, 4], [69, 8, 4], [67, 12, 2], [65, 14, 1]]);
  assert.equal(vln.find((n) => n.at === 12)!.vel, 100);
  assert.equal(vln.find((n) => n.at === 8)!.vel, 90);
  assert.equal(vln.find((n) => n.at === 14)!.artic, "pizz");
  assert.deepEqual(s.notes.filter((n) => n.track === "drums").map((n) => n.pitch), [36, 42, 42, 38, 42, 42]);
});

test("phrases catch misplaced bar lines, overruns and unknown names", () => {
  const bad = (phrase: string) => compose({ ...SCORE, tracks: [{ id: "x", instrument: "strings", phrases: [phrase] }] }, drumsOf);
  assert.throws(() => bad("m1 | A4:3 | B4:1"), /bar line/);
  assert.throws(() => bad("theme m2 | A4:8"), /past the song's end/);
  assert.throws(() => bad("verse m1 | A4:1"), /no section "verse"/);
  assert.throws(() => bad("m1 | kick:1"), /no drum map/);
});

test("places and where agree", () => {
  const s = song();
  assert.equal(place(s, "theme m2 b3"), 14);
  assert.equal(where(s, 14), "theme m2 b3");
  assert.equal(where(s, 6.5), "intro m2 b3.5");
});

test("selectors pick by track, group, section, bar, beat and filters", () => {
  const s = song();
  const pick = (src: string) => select(parseSelector(src), s).map((n) => `${n.track}@${n.at}:${n.pitch}`);
  assert.deepEqual(pick("vln @ theme m2"), ["vln@12:67", "vln@14:65"]);
  assert.deepEqual(pick("strings m2 b3"), ["vln@6:72"]); // beat 3 of the song's bar 2; the cello's G2 starts on beat 1
  assert.deepEqual(pick("vln @ intro m2 b3-4"), ["vln@6:72", "vln@7:70"]);
  assert.deepEqual(pick("vln b3.5"), []);
  assert.deepEqual(pick("vln [pitch>=A4][dur<=2]"), ["vln@4:74", "vln@6:72", "vln@7:70"]);
  assert.deepEqual(pick("vln @ theme [first]"), ["vln@8:62", "vln@8:69"]); // a chord counts once
  assert.deepEqual(pick("vln @ theme [last]"), ["vln@14:65"]);
  assert.deepEqual(pick("vln [n=2]"), ["vln@4:74"]);
  assert.deepEqual(pick("vln [artic=pizz]"), ["vln@14:65"]);
  assert.deepEqual(pick("strings [downbeat] [vel>80]"), ["vln@8:62", "vln@8:69", "vln@12:67"]);
  assert.equal(pick("*").length, s.notes.length);
});

test("specificity: ids over groups over *, then where, then filters; typos are errors", () => {
  const s = song();
  const w = (src: string) => specificity(parseSelector(src), s);
  assert.ok(w("vln") > w("strings"));
  assert.ok(w("strings") > w("* @ theme m1 b1 [first]"));
  assert.ok(w("vln @ theme") > w("vln"));
  assert.ok(w("vln @ theme m1") > w("vln @ theme"));
  assert.ok(w("vln @ theme [first]") > w("vln @ theme"));
  assert.throws(() => w("violins"), /no track or group "violins"/);
  assert.throws(() => w("vln @ chorus"), /no section "chorus"/);
});

test("values: levels, marks, keyframes and shapes", () => {
  assert.equal(level("mf"), MARKS.mf);
  assert.throws(() => level(1.5));
  assert.throws(() => level("loud"));
  assert.deepEqual(resolve(0.4, 2, 6), [[2, 0.4]]);
  assert.deepEqual(resolve([[0, "pp"], [0.5, 1], [1, 0]], 2, 6), [[2, MARKS.pp], [4, 1], [6, 0]]);
  assert.throws(() => resolve([[0.5, 0], [0.2, 1]], 0, 1));
  const v = resolve({ from: 0, to: 1, delay: 0.5 }, 0, 4);
  assert.equal(valueAt(v, 1), 0);
  assert.equal(valueAt(v, 2), 0);
  assert.equal(valueAt(v, 3), 0.5);
  assert.equal(valueAt(v, 9), 1);
  const eased = resolve({ from: 0, to: 1, ease: "in" }, 0, 1);
  assert.ok(valueAt(eased, 0.5) < 0.3);
});

test("cascade: specific beats general whatever the order, equal ones go by order", () => {
  const { notes } = cascade(song(), [
    { select: "vln @ theme m1", set: { vel: 30 } },
    { select: "vln", set: { vel: 50 } },
    { select: "vln", set: { vel: "+5" } },
    { select: "*", set: { vel: 10, timing: 20 } },
  ], offer);
  const vel = (beat: number) => notes.find((n) => n.track === "vln" && n.at === beat)!.vel;
  assert.equal(vel(8), 30);
  assert.equal(vel(0), 55);
  assert.equal(notes.find((n) => n.track === "vc")!.vel, 10);
  assert.equal(notes.find((n) => n.track === "vc")!.timing, 20);
});

test("cascade: a span curve runs across the notes picked, a note curve over each note", () => {
  const s = song();
  const { notes } = cascade(s, [
    { select: "vln @ intro", over: "span", set: { dynamics: [[0, 0], [1, 1]] } },
    { select: "vc", set: { vibrato: { from: 0, to: 1 } } },
  ], offer);
  const d = (beat: number) => notes.find((n) => n.track === "vln" && n.at === beat)!.controls.dynamics;
  assert.equal(valueAt(d(0), 0), 0);
  assert.equal(valueAt(d(4), 4), 0.5); // halfway through the intro's eight beats
  assert.equal(valueAt(d(7), 8), 1);
  const vib = notes.find((n) => n.track === "vc" && n.at === 8)!.controls.vibrato;
  assert.equal(valueAt(vib, 8), 0);
  assert.equal(valueAt(vib, 10), 0.5);
});

test("cascade: misses, unknown controls and articulations are reported", () => {
  const { warnings } = cascade(song(), [
    { select: "vln [pitch>C7]", set: { vel: 1 } },
    { select: "vc", set: { vibrto: 0.5 } },
    { select: "vc", set: { artic: "col legno" } },
    { select: "strings", set: { tune: 0.6 } },
    { select: "*", set: { vibrato: 0.4 } }, // the drums have no vibrato: a default skips them quietly
  ], offer);
  assert.ok(warnings.some((w) => /picks no note/.test(w)));
  assert.ok(warnings.some((w) => /no track it picks has a control "vibrto"/.test(w)));
  assert.ok(warnings.some((w) => /no articulation "col legno"/.test(w)));
  assert.ok(warnings.some((w) => /"strings": vc doesn't respond to "tune"/.test(w)));
  assert.equal(warnings.length, 4);
  assert.throws(() => cascade(song(), [{ select: "vc", set: { vibrato: 2 } }], offer), /0–1/);
});

test("perform: articulations become tracks, lag plays early, rests and curves become CCs and envelopes", () => {
  const s = song();
  const { notes } = cascade(s, [
    { select: "vc", over: "span", set: { dynamics: [[0, 0], [1, 1]] } },
    { select: "vln @ theme m1", set: { tune: 0.75, timing: 100 } },
  ], offer);
  const { played, warnings } = perform(s, notes, (t) => inst(t.instrument));
  assert.deepEqual(played.map((p) => p.rpp.name), ["vln", "vln (pizz)", "vc", "drums"]);
  assert.equal(played[0].rpp.offset, -0.1);
  assert.equal(played[1].rpp.offset, undefined);
  // the cello's crescendo: CC1 rising, from its rest at 0
  const cc1 = played[2].rpp.events.filter((e) => e.msg[0] === 0xb0 && e.msg[1] === 1);
  assert.deepEqual(cc1[0], { t: 0.5, msg: [0xb0, 1, 64] });
  for (let k = 2; k < cc1.length; k++) assert.ok(cc1[k].msg[2] >= cc1[k - 1].msg[2] && cc1[k].t > cc1[k - 1].t);
  assert.equal(cc1.at(-1)!.msg[2], 127);
  // timing moves the note-on; the tune parameter is automated, at its rest outside the chord
  const on = played[0].rpp.events.find((e) => e.msg[0] === 0x90 && e.msg[1] === 62)!;
  assert.ok(Math.abs(on.t - (1 + 8 + 0.1)) < 1e-9);
  const env = played[0].rpp.envs!.find((e) => e.param === 11)!;
  assert.deepEqual(env.points.map(([, v]) => v).filter((v, i, a) => i === 0 || v !== a[i - 1]), [0.5, 0.75, 0.5]);
  // each value held up to its change: a step between neighbours, not a ramp across the gap
  env.points.forEach(([t, v], i) => { if (i && v !== env.points[i - 1][1]) assert.ok(t - env.points[i - 1][0] < 0.005, `a ramp before ${t}s`); });
  // played 100 ms late, the chord now overlaps the next note, which rests its tune
  assert.deepEqual(warnings, ["vln theme m2 b1: overlapping notes want different tune; the channel follows the latest"]);
});

test("perform: overlapping notes that disagree are reported, notes outside the range too", () => {
  const s = song();
  const { notes } = cascade(s, [{ select: "vln @ theme m1 [pitch=A4]", set: { vibrato: 1 } }], offer);
  const low = { ...SCORE, tracks: [{ id: "x", instrument: "strings", phrases: ["m1 | C2:1"] }] };
  const { warnings } = perform(s, notes, (t) => inst(t.instrument));
  assert.ok(warnings.some((w) => /overlapping notes want different vibrato/.test(w)));
  const s2 = compose(low, drumsOf);
  assert.ok(perform(s2, cascade(s2, [], offer).notes, (t) => inst(t.instrument)).warnings.some((w) => /C2 is outside E2–F#6/.test(w)));
});

test("perform: humanizing is seeded, the same on every build and different with another seed", () => {
  const rules = [{ select: "*", set: { humanize: { timing: 30, vel: 20 } } }];
  const ons = (seed: number) => {
    const s = compose({ ...SCORE, seed }, drumsOf);
    return perform(s, cascade(s, rules, offer).notes, (t) => inst(t.instrument)).played.flatMap((p) => p.notes.map((n) => [n.on, n.vel]));
  };
  assert.deepEqual(ons(1), ons(1));
  assert.notDeepEqual(ons(1), ons(2));
});

test("auditions keep the tracks picked, from a bar before to the end of the bar, moved to 0", () => {
  const s = song();
  const { notes } = cascade(s, [{ select: "vln @ theme", over: "span", set: { dynamics: [[0, 0], [1, 1]] } }], offer);
  const a = crop(s, notes, "vln @ theme m2 b1");
  assert.deepEqual(a.window, [8, 16]);
  assert.deepEqual(a.song.score.tracks.map((t) => t.id), ["vln"]);
  assert.deepEqual(a.notes.map((n) => n.at), [0, 0, 4, 6]);
  assert.equal(valueAt(a.notes[2].controls.dynamics, 4), valueAt(notes.find((n) => n.track === "vln" && n.at === 12)!.controls.dynamics, 12));
  const b = build(SCORE, [], { out: "/tmp/x", audition: "drums @ theme m1", instrumentOf: inst });
  assert.deepEqual(b.played.map((p) => p.rpp.name), ["drums"]);
});

test("projects: envelopes after the plug-in, templates' FX chains spliced in without their ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "composer-"));
  const tpl = join(dir, "t.RTrackTemplate");
  writeFileSync(tpl, ["<TRACK", "NAME x", "<FXCHAIN", "SHOW 0", "<VST \"VST3i: Kit\" kit.vst3 0 \"\" 1{AB} \"\"", "AAAA", ">", "PRESETNAME Basic", "FXID {X}", "WAK 0 0", ">", ">"].join("\n"));
  const chain = templateChain(tpl);
  assert.ok(!chain.includes("FXID"));
  const text = writeRpp({
    bpm: 60, num: 4, den: 4, seconds: 4, out: "/tmp/o",
    tracks: [
      { name: "a", fx, events: [], envs: [{ param: 3, points: [[0, 0.5], [1, 0.75]] }] },
      { name: "b", fx: { chain }, events: [], envs: [{ param: 7, points: [[0, 0.1]] }] },
    ],
  });
  const lines = text.split("\n").map((l) => l.trim());
  const env = lines.indexOf("<PARMENV 3 0 1 0.5");
  assert.ok(env > lines.indexOf("FLOATPOS 0 0 0 0") && env < lines.indexOf("WAK 0 0"));
  assert.ok(lines.includes("PT 1.000000 0.750000 0"));
  const env2 = lines.indexOf("<PARMENV 7 0 1 0.1");
  assert.ok(env2 > lines.indexOf("PRESETNAME Basic") && env2 < lines.lastIndexOf("WAK 0 0"));
});
