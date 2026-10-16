import assert from "node:assert/strict";
import { test } from "node:test";
import { integrated, master } from "../src/audio/master.ts";
import { peak, SR } from "../src/audio/wav.ts";
import { applied, rebalance, TARGET, type Levels } from "../src/mix/balance.ts";
import type { Score } from "../src/score/song.ts";

const tone = (seconds: number, amp: number, hz = 1000) => {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return { l, r: Float32Array.from(l) };
};

test("mastering reaches the loudness asked for, under the ceiling", () => {
  const s = tone(4, 0.01);
  for (let k = 1; k < 4; k++) for (let j = 0; j < 100; j++) { s.l[k * SR + j] += 0.05; s.r[k * SR + j] += 0.05; }
  const m = master(s, -16, -1);
  assert.ok(Math.abs(m.lufs - -16) < 0.5, `${m.lufs} LUFS`);
  assert.ok(20 * Math.log10(peak(s)) <= -0.99);
  assert.ok(Math.abs(integrated(s) - m.lufs) < 0.05);
});

test("mastering won't squash past its limit: a song all peaks comes out quieter", () => {
  const s = tone(3, 0.02);
  for (let i = 0; i < s.l.length; i += 2205) for (let j = 0; j < 40; j++) { s.l[i + j] = 0.9; s.r[i + j] = 0.9; }
  const m = master(s, -10, -1, 6);
  assert.ok(m.limited <= 6.05);
  assert.ok(m.lufs < -10);
});

const lv = (x: Record<string, Record<string, number>>): Levels =>
  new Map(Object.entries(x).map(([t, by]) => [t, new Map(Object.entries(by).map(([s, l]) => [s, { lufs: l, seconds: 5 }]))]));

test("balancing puts each role where it belongs under the melody, the section as loud as it was", () => {
  const roles = { a: { mel: "melody", pad1: "harmony", pad2: "harmony", bass: "bass" } };
  const before = { mel: { a: -30 }, pad1: { a: -34 }, pad2: { a: -42 }, bass: { a: -33 } };
  const { balance } = rebalance(roles, lv(before));
  const after = Object.fromEntries(Object.entries(before).map(([t, by]) => [t, by.a + balance.tracks[t].vol + (balance.tracks[t].sections.a ?? 0)]));
  // two pads share the harmony's level
  assert.ok(Math.abs(after.pad1 - after.mel - (TARGET.harmony - 10 * Math.log10(2))) < 0.2);
  assert.ok(Math.abs(after.pad2 - after.pad1) < 0.2);
  assert.ok(Math.abs(after.bass - after.mel - TARGET.bass) < 0.2);
  const total = (x: Record<string, number>) => 10 * Math.log10(Object.values(x).reduce((a, v) => a + 10 ** (v / 10), 0));
  assert.ok(Math.abs(total(after) - total(Object.fromEntries(Object.entries(before).map(([t, by]) => [t, by.a])))) < 0.2);
});

test("a track's fader takes its loudest section; the others are cuts, and the whole desk stays under the top", () => {
  const roles = { a: { x: "melody", y: "harmony" }, b: { x: "harmony", y: "melody" } };
  const { balance } = rebalance(roles, lv({ x: { a: -30, b: -30 }, y: { a: -30, b: -30 } }));
  for (const t of ["x", "y"]) assert.ok(Object.values(balance.tracks[t].sections).every((g) => g < 0));
  const score: Score = { title: "t", tempo: 60, meter: [4, 4], sections: [{ name: "a", bars: 1 }, { name: "b", bars: 1 }], tracks: [{ id: "x", instrument: "i", vol: 9, phrases: [] }, { id: "y", instrument: "i", phrases: [] }] };
  const { score: s2, rules } = applied(score, { tracks: { x: { vol: 6, sections: { b: -12 } } } });
  assert.deepEqual(s2.tracks.map((t) => t.vol), [10, -5]);
  assert.deepEqual(rules, [{ select: "x @ b", set: { volume: 0.5012 } }]);
});
