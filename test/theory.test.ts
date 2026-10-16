import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { cascade } from "../src/score/cascade.ts";
import { BBC_DIR } from "../src/plugins/bbc.ts";
import { beatAt, compose, excerpt, layout, place, seconds, where, type Score } from "../src/score/song.ts";
import { degreeSemis, parseChord, parseKey, step } from "../src/theory/harmony.ts";
import { counter, develop, fit, generate, parseTheme, realize, rng, type Context, type Ev } from "../src/theory/melody.ts";
import { composePlan, dynamicsOf, phrases, progression, type Plan } from "../src/theory/plan.ts";
import { fmtLen, grid, weight } from "../src/theory/rhythm.ts";
import { voiceLead } from "../src/theory/voicing.ts";

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const pcs = (sym: string, key = "C# minor") => parseChord(sym, parseKey(key)).pcs.map((p) => NAMES[p]).join(" ");

test("sections keep their own meter and tempo, steady or changing", () => {
  const l = layout([{ name: "a", bars: 1 }, { name: "b", bars: 2, meter: [3, 4], tempo: 120 }, { name: "c", bars: 1, tempo: [120, 60] }], [4, 4], 60);
  assert.deepEqual(l.bars, [0, 4, 7, 10]);
  assert.equal(l.beats, 14);
  const song = { sections: l.sections, bars: l.bars };
  assert.equal(seconds(song, 4), 4);
  assert.equal(seconds(song, 10), 7);
  // 120 → 60 by the beat over 4 beats: two beats in, 4·ln(4/3) s
  assert.ok(Math.abs(seconds(song, 12) - (7 + 4 * Math.log(4 / 3))) < 1e-9);
  for (const b of [0.5, 5.25, 9, 11.3, 13.9]) assert.ok(Math.abs(beatAt(song, seconds(song, b)) - b) < 1e-9);
  assert.equal(place(song, "b m2 b3"), 9);
  assert.equal(place(song, "m3 b2"), 8);
  assert.equal(where(song, 9), "b m2 b3");
  const cut = excerpt({ score: { title: "", tempo: 60, meter: [4, 4], sections: [], tracks: [] }, ...l, notes: [] }, 7, 14);
  assert.deepEqual(cut.sections.map((s) => [s.name, s.bars, s.bpm]), [["b", 1, [120, 120]], ["c", 1, [120, 60]]]);
});

test("a phrase's bar lines follow each section's meter", () => {
  const score: Score = { title: "t", tempo: 60, meter: [4, 4], sections: [{ name: "a", bars: 1 }, { name: "b", bars: 1, meter: [3, 4] }], tracks: [{ id: "x", instrument: "i", phrases: ["a m1 | C4:4 | D4:3 |"] }] };
  assert.equal(compose(score).notes.length, 2);
  assert.throws(() => compose({ ...score, tracks: [{ id: "x", instrument: "i", phrases: ["a m1 | C4:4 | D4:2 | E4:1"] }] }), /bar line/);
});

test("numerals count the key's degrees; an accidental the mode has changes nothing", () => {
  assert.equal(pcs("i"), "C# E G#");
  assert.equal(pcs("VI"), "A C# E");
  assert.equal(pcs("bVI"), "A C# E");
  assert.equal(pcs("bII"), "D F# A");
  assert.equal(pcs("N"), "D F# A");
  assert.equal(pcs("V7"), "G# C D# F#");
  assert.equal(pcs("vii°7"), "C D# F# A"); // on the leading tone
  assert.equal(pcs("V/V"), "D# G A#");
  assert.equal(pcs("Ger"), "A C# E G");
  assert.equal(pcs("II", "A lydian"), "B D# F#");
  assert.equal(pcs("Bbmaj7"), "A# D F A");
  assert.equal(parseChord("i/3", parseKey("C# minor")).bass, 4);
  const k = parseKey("E minor");
  assert.equal(degreeSemis(k, 2, -1), degreeSemis(k, 2)); // b3 in minor is its own third
  assert.equal(degreeSemis(k, 6, 1), 11); // #7 the leading tone
  assert.equal(degreeSemis(k, 1, -1), 1); // b2 a half step over the tonic
  assert.equal(step(k, 64, 2), 67);
});

test("voice leading moves little, never crosses, keeps the third", () => {
  const key = parseKey("C major");
  const chords = ["I", "IV", "V7", "I"].map((c) => parseChord(c, key));
  const v = voiceLead(chords, [{ lo: 60, hi: 79 }, { lo: 55, hi: 74 }, { lo: 48, hi: 67 }]);
  for (const x of v) assert.ok(x[0] > x[1] && x[1] > x[2]);
  for (let i = 1; i < v.length; i++) for (let k = 0; k < 3; k++) assert.ok(Math.abs(v[i][k] - v[i - 1][k]) <= 5, `voice ${k} leaps at chord ${i}`);
  chords.forEach((c, i) => assert.ok(v[i].some((p) => p % 12 === c.pcs[1]), `${c.symbol} lacks its third`));
});

test("rhythms read as steps of a bar", () => {
  const [bar] = grid("X.x-~...", 4);
  assert.deepEqual(bar.map((h) => [h.at, h.len, h.accent, h.roll]), [[0, 0.5, 1, false], [1, 1, 0, false], [2, 0.125, 0, true], [2.125, 0.125, 0, true], [2.25, 0.125, 0, true], [2.375, 0.125, 0, true]]);
  assert.equal(weight(2, [4, 4]), 1);
  assert.equal(weight(1, [3, 4]), 0);
  assert.equal(weight(1.5, [6, 8]), 1);
  assert.equal(fmtLen(0.75), "3/4");
  assert.equal(fmtLen(1 / 3), "1/3");
});

const ctxOf = (chords: string, key = "C major"): Context => {
  const k = parseKey(key);
  const prog = progression(chords, k, 0, 2, 4);
  return { key: () => k, chord: (at) => prog.findLast((c) => c.at <= at + 1e-6)!.chord, meter: () => [4, 4], bar: (at) => Math.floor(at / 4) * 4, level: () => 0.6 };
};

test("themes develop: sequence, inversion, retrograde, augmentation, a slice, an ending", () => {
  const t = parseTheme("1:1 2:1 3:2 | 5':4");
  assert.deepEqual(t.map((n) => n.deg), [0, 1, 2, 11]);
  const r = rng("x");
  assert.deepEqual(develop(t, ["+2"], r).notes.map((n) => n.deg), [2, 3, 4, 13]);
  assert.deepEqual(develop(t, ["inv"], r).notes.map((n) => n.deg), [0, -1, -2, -11]);
  assert.deepEqual(develop(t, ["rev"], r).notes.map((n) => [n.deg, n.at]), [[11, 0], [2, 4], [1, 6], [0, 7]]);
  assert.deepEqual(develop(t, ["x2"], r).notes.map((n) => n.len), [2, 2, 4, 8]);
  assert.deepEqual(develop(t, ["[1-4]"], r).notes.map((n) => [n.deg, n.at, n.len]), [[1, 0, 1], [2, 1, 2]]);
  assert.equal(develop(t, ["end=1"], r).notes.at(-1)!.deg, 14);
  // the same seed ornaments the same way
  const a = develop(parseTheme("1:2 3:2 3:2 5:2"), ["vary=1"], rng("s")).notes;
  const b = develop(parseTheme("1:2 3:2 3:2 5:2"), ["vary=1"], rng("s")).notes;
  assert.deepEqual(a, b);
  assert.ok(a.length > 4);
});

test("fitting puts strong beats on chord tones and keeps what's written chromatic", () => {
  const ctx = ctxOf("I | V");
  const k = parseKey("C major");
  // D on beat 1 over C, F# (written #4) on beat 3
  const { evs, kept } = realize(parseTheme("2:2 #4:2 | 2:1 3:1 2:2"), k, 60, 0);
  const moved = fit(evs, kept, ctx);
  assert.deepEqual(evs.map((e) => e.pitch), [64, 66, 62, 64, 62]);
  assert.equal(moved, 1);
});

test("a generated phrase stays in range and the key, and ends where asked", () => {
  const ctx = ctxOf("I | IV V");
  const rhythm = parseTheme("1:1 1:1 1:1 1:1");
  const g = generate(0, { rhythm, bars: 2, barBeats: 4, contour: "arch", from: 64, range: [57, 79], end: 0 }, ctx, rng("g"));
  assert.equal(g.length, 8);
  for (const e of g) assert.ok((e.pitch as number) >= 57 && (e.pitch as number) <= 79);
  for (const e of g) assert.ok([0, 2, 4, 5, 7, 9, 11].includes((e.pitch as number) % 12));
  assert.equal((g.at(-1)!.pitch as number) % 12, 0);
  assert.deepEqual(g, generate(0, { rhythm, bars: 2, barBeats: 4, contour: "arch", from: 64, range: [57, 79], end: 0 }, ctx, rng("g")));
});

test("a counter-line sits under the melody in consonances, without parallel fifths or octaves", () => {
  const ctx = ctxOf("I | V");
  const mel: Ev[] = [72, 74, 76, 79, 77, 76, 74, 71].map((p, i) => ({ pitch: p, at: i, len: 1, accent: 0 }));
  const c = counter(mel, 0, 8, { range: [48, 67], below: true, onsets: mel.map((m) => ({ at: m.at, len: 1, accent: 0 })) }, ctx, rng("c"));
  for (let i = 0; i < 8; i++) {
    const gap = (mel[i].pitch as number) - (c[i].pitch as number);
    assert.ok(gap >= 3, `beat ${i} not under`);
    if (i) {
      const was = ((mel[i - 1].pitch as number) - (c[i - 1].pitch as number)) % 12;
      const same = Math.sign((mel[i].pitch as number) - (mel[i - 1].pitch as number)) === Math.sign((c[i].pitch as number) - (c[i - 1].pitch as number));
      assert.ok(!(same && was === gap % 12 && (was === 0 || was === 7)), `parallel at ${i}`);
    }
  }
});

test("dynamics marks become keyframes", () => {
  assert.deepEqual(dynamicsOf("p<f>mp").map(([x]) => x), [0, 0.5, 1]);
  assert.throws(() => dynamicsOf("p<loud"));
});

test("phrases write a voice per line and read back as the same notes", () => {
  const l = layout([{ name: "a", bars: 2 }], [4, 4], 100);
  const evs: Ev[] = [
    { pitch: 60, at: 0, len: 2, vel: 80, accent: 0 }, { pitch: 64, at: 0, len: 2, vel: 80, accent: 0 },
    { pitch: 67, at: 0, len: 6, vel: 90, accent: 0, artic: "spic" }, { pitch: 62, at: 3, len: 1, vel: 70, accent: 0 },
  ];
  const ph = phrases(evs, l.sections[0], l, "long");
  const song = compose({ title: "t", tempo: 100, meter: [4, 4], sections: [{ name: "a", bars: 2 }], tracks: [{ id: "x", instrument: "i", phrases: ph }] });
  const key = (n: { pitch: number; at: number; len: number; vel: number; artic?: string }) => `${n.pitch}@${n.at}+${n.len}v${n.vel}${n.artic && n.artic !== "long" ? n.artic : ""}`;
  assert.deepEqual(song.notes.map(key).sort(), evs.map((e) => key(e as { pitch: number; at: number; len: number; vel: number; artic?: string })).sort());
});

test("overrides outweigh the score's own rules, however specific", () => {
  const score: Score = { title: "t", tempo: 60, meter: [4, 4], sections: [{ name: "a", bars: 1 }], tracks: [{ id: "x", instrument: "i", phrases: ["a m1 | C4:4"] }] };
  const song = compose(score);
  const offer = { controls: () => ["dynamics"], artics: () => ["long"], inert: () => [] };
  const { notes } = cascade(song, [{ select: "*", set: { dynamics: "pp" } }], offer, [{ select: "x @ a m1 [first]", set: { dynamics: "ff" } }]);
  assert.equal(notes[0].controls.dynamics[0][1], 0.2);
});

const bbc = existsSync(BBC_DIR);
test("a plan composes the same score for the same seed, its notes reading back whole", { skip: !bbc && "BBC SO isn't installed" }, () => {
  const plan: Plan = {
    title: "T", key: "D minor", tempo: 120, seed: 3,
    ensemble: { vln: { instrument: "bbc/vln1", group: "strings" }, vla: { instrument: "bbc/vla" }, vc: { instrument: "bbc/vc" } },
    themes: { a: "1:1 3:1 5:2 | 4:1 3:1 2:2" },
    sections: [
      { name: "x", bars: 4, chords: "i | iv V | i | V", dynamics: "p<f", parts: { vln: { play: "melody", line: ["a", "gen 2 fall end=1"] }, vla: { play: "harmony", voices: 2 }, vc: { play: "bass", walk: true } } },
      { name: "y", bars: 2, meter: [3, 4], tempo: [120, 90], chords: "VI | V", parts: { vln: { play: "figure", rhythm: "x.x.xx", arp: "up" }, vla: { play: "counter", against: "vln" }, vc: { play: "bass" } } },
    ],
  };
  const one = composePlan(plan);
  assert.deepEqual(composePlan(plan).score, one.score);
  assert.notDeepEqual(composePlan(plan, { seed: 4 }).score.tracks[0].phrases, one.score.tracks[0].phrases);
  const song = compose(one.score);
  assert.ok(song.notes.length > 30);
  assert.ok(one.score.shape!.some((r) => r.select === "vln @ x" && r.over === "span"));
  assert.ok(one.score.tracks.every((t) => typeof t.vol === "number" || t.vol === undefined));
});
