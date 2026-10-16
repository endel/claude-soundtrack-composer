import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { instrument, VOICE_FX, type Instrument, type Patch } from "../src/patches.ts";
import { perform } from "../src/perform.ts";
import * as ezd from "../src/plugins/ezd.ts";
import { templateChain } from "../src/plugins/template.ts";
import { ROOT } from "../src/reaper/reaper.ts";
import { writeRpp } from "../src/reaper/rpp.ts";
import { cascade } from "../src/score/cascade.ts";
import { compose, type Score } from "../src/score/song.ts";

const fx = { name: "VSTi: Test", file: "t.vst", id: 1, tag: "<00>", outs: 2, chunk: Buffer.from("state") };
const patch: Patch = {
  id: "p", fx, lag: 0, always: [], native: { dynamics: { cc: 1, rest: 0.5 } },
  controls: { dynamics: { cc: 1, rest: 0.5 }, vibrato: { voice: 0, rest: 0 }, volume: { voice: 4, rest: 1 } },
};
const INST: Instrument = { id: "p", name: "P", default: "default", inert: [], artics: { default: patch } };
const SCORE: Score = {
  title: "T", tempo: 60, meter: [4, 4], sections: [{ name: "a", bars: 1 }],
  tracks: [{ id: "x", instrument: "p", phrases: ["m1 | C4:4"] }, { id: "y", instrument: "p", phrases: ["m1 | C4:4"] }],
};
const offer = { controls: () => Object.keys(patch.controls), artics: () => ["default"], inert: () => [] };

test("voice: a track that moves a voice control gets the voice after its instrument, its envelopes on it", () => {
  const s = compose(SCORE);
  const { notes } = cascade(s, [{ select: "x", set: { vibrato: { from: 0, to: 1 }, dynamics: "f" } }, { select: "y", set: { dynamics: "p" } }], offer);
  const { played } = perform(s, notes, () => INST);
  const [x, y] = played.map((p) => p.rpp);
  assert.deepEqual(x.post, [{ path: VOICE_FX, sliders: [0, 0.5, 0.5, 0.5, 1, 0.5] }]);
  assert.equal(y.post, undefined); // only CCs: no voice
  const vib = x.envs!.find((e) => e.fx === 1)!;
  assert.equal(vib.param, 0);
  assert.ok(vib.points.at(-1)![1] > 0.9);
  const lines = writeRpp({ bpm: 60, num: 4, den: 4, seconds: 5, out: "/tmp/o", tracks: [x] }).split("\n").map((l) => l.trim());
  const js = lines.findIndex((l) => l.startsWith(`<JS ${VOICE_FX}`));
  assert.ok(js > lines.indexOf("WAK 0 0"), "after the instrument's block");
  assert.equal(lines[js + 1].split(" ").length, 64);
  assert.ok(lines.indexOf("<PARMENV 0 0 1 0") > js && lines.lastIndexOf("WAK 0 0") > js);
});

test("voice: BBC Discover's vibrato, which it ignores, is the voice's; what it responds to stays its own", () => {
  const vc = instrument("bbc/vc");
  const c = vc.artics.long.controls;
  assert.ok("voice" in c.vibrato && "voice" in c.spread && "voice" in c.tone);
  assert.ok("cc" in c.dynamics && "cc" in c.pan && "param" in c.tune);
  assert.ok("cc" in vc.artics.long.native.vibrato);
  assert.ok(!vc.inert.includes("vibrato") && vc.inert.includes("tightness"));
});

const installed = existsSync(ezd.EZX_DIR) && existsSync(join(ROOT, "patches/ezd3.RTrackTemplate"));

test("ezdrummer: its state reads and writes back byte for byte; the mix moves channels by dB", { skip: !installed }, () => {
  const chain = templateChain(join(ROOT, "patches/ezd3.RTrackTemplate"));
  const text = ezd.readState(chain);
  assert.equal(ezd.writeState(chain, text), chain);
  const warned: string[] = [];
  const mixed = ezd.mix(text, { hats: 6, toms: -6, nope: 3 }, (m) => warned.push(m));
  const vol = (t: string[], ch: string) => Number(t[t.indexOf(`${ch} {`, t.indexOf("mixer {")) + 2].split(" ")[1]);
  assert.ok(Math.abs(vol(mixed, "Hats") / vol(text, "Hats") - 10 ** (6 / 20)) < 1e-4);
  assert.ok(Math.abs(vol(mixed, "Tom3") / vol(text, "Tom3") - 10 ** (-6 / 20)) < 1e-4);
  assert.match(warned[0], /"nope": no such channel/);
  const back = ezd.readState(ezd.writeState(chain, mixed));
  assert.deepEqual(back, mixed);
});

test("ezdrummer: presets and drum maps come from the kit", { skip: !installed }, () => {
  assert.equal(ezd.roomOf("tight room"), "EZX3_EZdrummer3_TightRoom");
  assert.ok(ezd.presets("EZX3_EZdrummer3_MainRoom").some((p) => p.name === "Studio Basic"));
  const block = ezd.sampler("EZX3_EZdrummer3_TightRoom", "classic pop basic");
  assert.equal(block[2], 'soundlib "EZX3_EZdrummer3_TightRoom"');
  assert.ok(block.includes("instbox 0 {") && !block.some((l) => l.trim() === "kit {"));
  const main = ezd.drumMap("EZX3_EZdrummer3_MainRoom");
  assert.deepEqual([main.kick, main.snare, main.hat, main.tom1, main.tom5, main.crash, main["crash-50"]], [36, 38, 42, 48, 41, 49, 50]);
  const tight = ezd.drumMap("EZX3_EZdrummer3_TightRoom");
  assert.equal(tight.china, undefined); // 52 is its ride crash
  assert.equal(tight["ride-crash-52"], 52);
  const kit = instrument("ezd3");
  const set = kit.setup!({ kit: "TightRoom" }, () => {});
  assert.equal(set.artics.default.drums!.china, undefined);
  assert.equal(set.artics.default.sounding, undefined); // probed on MainRoom only
  assert.throws(() => kit.setup!({ kit: "MetalMachine/Some Preset" }, () => {}), /no presets/);
  assert.throws(() => kit.setup!({ kits: "x" }, () => {}), /takes kit and mix/);
});
