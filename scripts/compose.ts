/**
 * Composes a song folder's plan (`plan.yaml`, src/theory/plan.ts) into its score (`score.yaml`): the same notes for
 * the same plan and seed. `--seed=<n>` rolls it again under another; `--render` renders it, balances the mix from
 * what it measures (balance.ts) and renders it again.
 *
 *   node scripts/compose.ts songs/black-feather [--seed=7] [--render]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { composePlan, type Plan } from "../src/theory/plan.ts";
import { seconds, layout } from "../src/score/song.ts";

const dir = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!dir) throw new Error("usage: compose.ts <song folder> [--seed=<n>] [--render]");
const seedArg = process.argv.find((a) => a.startsWith("--seed="));
const plan = parse(readFileSync(join(dir, "plan.yaml"), "utf8")) as Plan;
const { score, warnings, fitted } = composePlan(plan, { seed: seedArg ? Number(seedArg.slice(7)) : undefined });

const head = `# Composed from plan.yaml by scripts/compose.ts (seed ${score.seed}). Compose again rather than edit it:\n# overrides.yaml is where hand changes go, and they apply over this.\n`;
writeFileSync(join(dir, "score.yaml"), head + stringify(score, { lineWidth: 0, flowLevel: 3 }));

const lay = layout(score.sections, score.meter, score.tempo);
const song = { sections: lay.sections };
const notes = score.tracks.map((t) => [t.id, t.phrases.join(" ").split(/\s+/).filter((w) => /:/.test(w) && !w.startsWith("r:")).length] as const);
console.log(`${score.title}: ${lay.sections.length} sections, ${lay.bars.length} bars, ${seconds(song, lay.beats).toFixed(1)}s; ${fitted} melody notes fitted to the chords`);
for (const s of lay.sections) console.log(`  ${s.name.padEnd(10)} ${String(s.bars).padStart(3)} bars  ${(s.meter ?? score.meter).join("/")}  ${s.bpm[0] === s.bpm[1] ? s.bpm[0] : `${s.bpm[0]}→${s.bpm[1]}`} bpm  at ${s.sec.toFixed(1)}s`);
console.log(`  ${notes.map(([id, n]) => `${id} ${n}`).join(", ")} tokens`);
for (const w of warnings) console.log(`  warning: ${w}`);
console.log(`wrote ${join(dir, "score.yaml")}`);

// rendered, then balanced from what the render measures and rendered again
if (process.argv.includes("--render")) {
  const run = (script: string, ...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, script), dir, ...args], { stdio: "inherit" }).status ?? 1;
  process.exitCode = run("build.ts", "--render") || run("balance.ts", "--render");
}
