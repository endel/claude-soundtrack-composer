/**
 * Which of an instrument's controls change its sound. Each is rendered low (0.1) and high (0.9) on the same
 * phrase (a held note, a gap, a short note: attack, sustain and release all heard), and the two compared sample by
 * sample, against a pair rendered alike, which shows how far two renders differ anyway. Not 0 and 1: BBC takes CC1 = 0
 * for 127, so the extremes can sound alike. Writes
 * `catalog/effect/<instrument>.json`; patches.ts then marks a control that changes nothing, and a song that moves one
 * is warned.
 *
 *   node scripts/audit.ts bbc/vc [more instruments…]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dB, rms, type Stereo } from "../src/audio/wav.ts";
import { instrument } from "../src/patches.ts";
import { ROOT, render } from "../src/reaper/reaper.ts";
import type { Envelope, MidiEvent, RppTrack } from "../src/reaper/rpp.ts";

const SECONDS = 7;
const diff = (a: Stereo, b: Stereo): number => {
  let e = 0;
  let s = 0;
  for (let i = 0; i < Math.min(a.l.length, b.l.length); i++) {
    const x = a.l[i] - b.l[i];
    const y = a.r[i] - b.r[i];
    e += x * x + y * y;
    s += Math.max(a.l[i] * a.l[i] + a.r[i] * a.r[i], b.l[i] * b.l[i] + b.r[i] * b.r[i]);
  }
  return dB(Math.sqrt(e / Math.max(s, 1e-30)));
};

mkdirSync(join(ROOT, "catalog/effect"), { recursive: true });
for (const id of process.argv.slice(2)) {
  const inst = instrument(id);
  const patch = inst.artics[inst.default];
  const m = patch.range ? Math.round((patch.range[0] + patch.range[1]) / 2) : 60;
  const tracks: RppTrack[] = [];
  const track = (name: string, c?: string, v?: number): RppTrack => {
    const ctl = c ? patch.native[c] : undefined;
    const events: MidiEvent[] = [];
    const envs: Envelope[] = [];
    // half a second in: controllers on the render's first sample are dropped
    for (const [cc, val] of [[1, 90], [11, 110]] as const) if (!(ctl && "cc" in ctl && ctl.cc === cc)) events.push({ t: 0.5, msg: [0xb0, cc, val] });
    if (ctl && "cc" in ctl) events.push({ t: 0.5, msg: [0xb0, ctl.cc, Math.round(v! * 127)] });
    if (ctl && "param" in ctl) envs.push({ param: ctl.param, points: [[0, v!]] });
    events.push({ t: 1, msg: [0x90, m, 90] }, { t: 3.5, msg: [0x80, m, 0] }, { t: 5, msg: [0x90, m, 90] }, { t: 5.3, msg: [0x80, m, 0] });
    return { name, fx: patch.fx, events, envs };
  };
  tracks.push(track("same a"), track("same b"));
  const names = Object.keys(patch.native).filter((c) => !process.env.ONLY || process.env.ONLY.split(",").includes(c));
  for (const c of names) tracks.push(track(`${c} lo`, c, 0.1), track(`${c} hi`, c, 0.9));
  const t0 = Date.now();
  const dir = join(ROOT, "out/audit", id.replace("/", "-"));
  const stems = render({ bpm: 60, num: 4, den: 4, seconds: SECONDS, out: join(dir, "stems"), tracks }, join(dir, "audit.rpp"), { warmup: Number(process.env.WARMUP ?? patch.warmup ?? 0) });
  const floor = diff(stems.get("same a")!, stems.get("same b")!);
  const effect: Record<string, { changes: boolean; dB: number }> = {};
  for (const c of names) {
    const d = diff(stems.get(`${c} lo`)!, stems.get(`${c} hi`)!);
    effect[c] = { changes: d > Math.max(floor + 6, -60), dB: +d.toFixed(1) };
  }
  writeFileSync(join(ROOT, "catalog/effect", `${id.replace("/", "-")}.json`), JSON.stringify({ floor: +floor.toFixed(1), level: +dB(rms(stems.get("same a")!, 1, 3.5)).toFixed(1), effect }, null, 1) + "\n");
  const yes = names.filter((c) => effect[c].changes);
  const no = names.filter((c) => !effect[c].changes);
  console.log(`${id} (${tracks.length} tracks, ${((Date.now() - t0) / 1000).toFixed(1)}s; two alike differ by ${floor.toFixed(1)} dB)`);
  console.log(`  changes the sound: ${yes.map((c) => `${c} (${effect[c].dB} dB)`).join(", ")}`);
  console.log(`  changes nothing:   ${no.join(", ") || "-"}`);
}
