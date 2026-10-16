/**
 * What each instrument lets a song control, written to catalog/:
 * - `bbc.json`: every BBC SO Discover preset's articulations and controls (each with its resting value and CC), read
 *   from its NKS preset, no REAPER needed;
 * - `host.json`: every parameter each instrument shows its host (BBC SO, Kontakt 8, EZdrummer 3), read in REAPER.
 *
 *   node scripts/plugins.ts [--no-host]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { articsOf, bbc, controlsOf, nksXml, presets } from "../src/plugins/bbc.ts";
import { writeRpp } from "../src/reaper/rpp.ts";
import { ROOT, runLua } from "../src/reaper/reaper.ts";

const CATALOG = join(ROOT, "catalog");
mkdirSync(CATALOG, { recursive: true });

const bbcCat = Object.fromEntries(presets().map((p) => {
  const xml = nksXml(p);
  return [p, { artics: articsOf(p, xml), controls: controlsOf(p, xml) }];
}));
writeFileSync(join(CATALOG, "bbc.json"), JSON.stringify(bbcCat, null, 1) + "\n");
const vln = bbcCat.Strings_Violins_1;
console.log(`bbc.json: ${Object.keys(bbcCat).length} presets`);
console.log(`  Violins 1 articulations: ${vln.artics.join(", ")}`);
console.log(`  controls on a CC: ${vln.controls.filter((c) => c.cc !== null).map((c) => `${c.id}=CC${c.cc}`).join(", ")}`);
console.log(`  controls without one: ${vln.controls.filter((c) => c.cc === null).length} (mic mix, tune, …)`);

if (!process.argv.includes("--no-host")) {
  const project = join(ROOT, ".reaper", "params.rpp");
  mkdirSync(join(ROOT, ".reaper"), { recursive: true });
  writeFileSync(project, writeRpp({
    bpm: 120, num: 4, den: 4, seconds: 1, out: join(ROOT, ".reaper"),
    tracks: [{ name: "BBC SO (Violins 1, Long)", fx: bbc("Strings_Violins_1", "Long"), events: [] }],
  }));
  const res = runLua<{ plugins: { track: string; name: string; missing?: boolean; tried?: string[]; params: { index: number; name: string; now: string; shown: string[] }[] }[] }>(
    "params.lua",
    { project, steps: 10, add: [["VST3:Kontakt 8", "AU:Kontakt 8"], ["VST3:EZdrummer 3", "AU:EZdrummer 3"]] },
  );
  writeFileSync(join(CATALOG, "host.json"), JSON.stringify(res.plugins, null, 1) + "\n");
  console.log(`host.json:`);
  for (const p of res.plugins) {
    if (p.missing) { console.log(`  MISSING: ${p.tried!.join(" / ")}`); continue; }
    // VST3 hosts see every MIDI CC as a parameter; those and numbered slots aren't the instrument's own controls
    const named = p.params.filter((q) => !/^#?\d+\.?\s*$|^(MIDI )?CC ?\d|\((MSB|LSB)\)|Bank Select|Controller|Pitch ?Bend|Aftertouch|Program|^Bypass$|^NIKT/i.test(q.name));
    console.log(`  ${p.name}: ${p.params.length} parameters, ${named.length} of its own`);
    console.log(`    ${named.slice(0, 40).map((q) => `${q.name} [${q.now}]`).join(", ")}${named.length > 40 ? ", …" : ""}`);
  }
}
