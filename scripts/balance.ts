/**
 * Balances a rendered song's mix (src/mix/balance.ts): measures each track in each section of the last render (heard
 * through the balance it was rendered with, from its report), sets it where its role puts it under the melody, and
 * writes `balance.yaml`. `--render` renders again with it and
 * measures what's left; `--passes=<n>` repeats that.
 *
 *   node scripts/balance.ts songs/black-feather [--render] [--passes=2]
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { build, renderBuild, type Report } from "../src/build.ts";
import { readBalance, rebalance, writeBalance, type Balance, type Move } from "../src/mix/balance.ts";
import { measure } from "../src/mix/measure.ts";
import { ROOT } from "../src/reaper/reaper.ts";
import { loadSongDir } from "../src/score/song.ts";

const dir = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!dir) throw new Error("usage: balance.ts <song folder> [--render] [--passes=<n>]");
const name = basename(resolve(dir));
const out = join(ROOT, "out", name);
const passes = Number(process.argv.find((a) => a.startsWith("--passes="))?.slice(9) ?? 1);
const { score, rules } = loadSongDir(dir);
if (!score.roles) throw new Error(`${dir}/score.yaml names no roles: balancing wants a score composed from a plan`);

const off = (moves: Move[]) => Math.max(0, ...moves.map((m) => Math.abs(m.want)));
// what the last render was mixed with: its levels are heard through it
const used = (): Balance | undefined => {
  const f = join(out, "report.json");
  return existsSync(f) ? ((JSON.parse(readFileSync(f, "utf8")) as Report).balance ?? undefined) : undefined;
};
for (let k = 0; k < passes; k++) {
  const { balance, moves } = rebalance(score.roles, measure(score, join(out, "stems")), used());
  writeBalance(dir, balance);
  const worst = [...moves].sort((a, b) => Math.abs(b.want) - Math.abs(a.want)).slice(0, 6);
  console.log(`pass ${k + 1}: the furthest off was ${off(moves).toFixed(1)} dB (${worst.map((m) => `${m.track} @ ${m.section} ${m.want > 0 ? "+" : ""}${m.want}`).join(", ")}); wrote ${join(dir, "balance.yaml")}`);
  if (!process.argv.includes("--render")) break;
  const r = renderBuild(build(score, rules, { out: join(out, "stems"), balance: readBalance(dir) }), out, name);
  console.log(`  rendered ${r.files.mp3}`);
  const left = rebalance(score.roles, measure(score, join(out, "stems")), used()).moves;
  console.log(`  now the furthest off is ${off(left).toFixed(1)} dB`);
}
