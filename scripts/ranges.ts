/**
 * Probes each BBC SO articulation's lowest and highest key and writes them into data/bbc-probed.json (its attack lags
 * kept). The low edge is played upward and the high edge downward, so a key is never judged while the key before it
 * is still ringing: a probe played one way round finds one edge a key too far, hearing the release of its neighbour.
 *
 *   node scripts/ranges.ts [vln1 hn …]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dB, rms } from "../src/audio/wav.ts";
import { build, renderBuild } from "../src/build.ts";
import { ROOT } from "../src/reaper/reaper.ts";
import { pitchName, type Score } from "../src/score/song.ts";

const file = join(ROOT, "data/bbc-probed.json");
const probed = JSON.parse(readFileSync(file, "utf8")) as Record<string, { lo: number; hi: number; lag: number }>;
const only = process.argv.slice(2);
const keys = Object.keys(probed).filter((k) => !only.length || only.includes(k.split("-")[0]));
const W = 8;
const tok = (ps: number[]) => ps.filter((p) => p >= 12 && p <= 120).map((p) => `${pitchName(p)}:1`).join(" ");
const tracks: Score["tracks"] = keys.flatMap((k) => {
  const [inst, artic] = k.split("-");
  const head = (bar: number) => `a m${bar} vel=100${artic ? ` artic=${artic}` : ""} |`;
  const { lo, hi } = probed[k];
  return [
    { id: `${k}_lo`.replace("-", "_"), instrument: `bbc/${inst}`, phrases: [`${head(1)} ${tok(Array.from({ length: 2 * W + 1 }, (_, i) => lo - W + i))}`] },
    { id: `${k}_hi`.replace("-", "_"), instrument: `bbc/${inst}`, phrases: [`${head(1)} ${tok(Array.from({ length: 2 * W + 1 }, (_, i) => hi + W - i))}`] },
  ];
});
const score: Score = { title: "ranges", tempo: 60, meter: [4, 4], seed: 1, sections: [{ name: "a", bars: 5 }], tracks };
const out = join(ROOT, "out/ranges");
const b = build(score, [{ select: "*", set: { dynamics: "f" } }], { out: join(out, "stems") });
const r = renderBuild(b, out, "ranges");
const heard = (id: string): number[] => {
  const p = b.played.find((x) => x.track.id === id)!;
  const s = r.stems.get(p.rpp.name)!;
  return p.notes.filter((x) => dB(rms(s, x.on + 0.01, x.on + 0.12)) > -70).map((x) => x.n.pitch);
};
for (const k of keys) {
  const id = k.replace("-", "_");
  const lo = Math.min(...heard(`${id}_lo`));
  const hi = Math.max(...heard(`${id}_hi`));
  const edge = (x: number, at: number) => (Math.abs(x - at) >= W ? " (at the window's edge: widen it)" : "");
  console.log(`${k.padEnd(12)} ${probed[k].lo}–${probed[k].hi} → ${lo}–${hi}${edge(lo, probed[k].lo)}${edge(hi, probed[k].hi)}`);
  if (Number.isFinite(lo) && Number.isFinite(hi)) probed[k] = { ...probed[k], lo, hi };
}
writeFileSync(file, JSON.stringify(probed, null, 1) + "\n");
