/**
 * Saves a plug-in with its default state as a track template in patches/, for a patch map (`patches/<id>.json`) to
 * play. For a plug-in that needs choosing inside its own window (a Kontakt instrument, another kit), set it up in
 * REAPER instead and save the track there with "Save tracks as track template…" into this folder.
 *
 *   node scripts/capture.ts <id> <plug-in name>[,<another name to try>] [--wait=<s>]
 *   node scripts/capture.ts ezd3 "VST3:EZdrummer 3,AU:EZdrummer 3" --wait=20
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, runLua } from "../src/reaper/reaper.ts";

const [id, names] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!id || !names) throw new Error("usage: capture.ts <id> <plug-in name>[,<name>] [--wait=<s>]");
const wait = Number(process.argv.find((a) => a.startsWith("--wait="))?.slice(7) ?? 10);
mkdirSync(join(ROOT, "patches"), { recursive: true });
const file = join(ROOT, "patches", `${id}.RTrackTemplate`);
const res = runLua<{ fx: string; bytes: number }>("capture.lua", { name: id, add: names.split(","), wait, file }, wait + 300);
console.log(`${file}: ${res.fx}, ${res.bytes} bytes of track state`);
