/**
 * Checks this machine has what composing and rendering need, and says how to get what's missing.
 *
 *   node scripts/doctor.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BBC_DIR, presets } from "../src/plugins/bbc.ts";
import { EZX_DIR, rooms } from "../src/plugins/ezd.ts";
import { REAPER_BIN, ROOT, USER_RES } from "../src/reaper/reaper.ts";

let missing = 0;
const line = (ok: boolean | null, what: string, detail: string) => {
  if (ok === false) missing++;
  console.log(`${ok === null ? "–" : ok ? "✓" : "✗"} ${what.padEnd(34)} ${detail}`);
};

const [maj, min] = process.versions.node.split(".").map(Number);
line(maj > 22 || (maj === 22 && min >= 18), "Node 22.18 or later", `${process.versions.node} (it runs the TypeScript directly)`);
line(process.platform === "darwin", "macOS", process.platform === "darwin" ? "yes" : `${process.platform}: rendering drives REAPER on macOS only`);
line(existsSync(REAPER_BIN), "REAPER", existsSync(REAPER_BIN) ? REAPER_BIN : `not at ${REAPER_BIN}: install it from reaper.fm, or set REAPER_BIN`);
line(existsSync(USER_RES), "REAPER opened once", existsSync(USER_RES) ? USER_RES : "open REAPER once, so it scans your plug-ins");

const cache = join(USER_RES, "reaper-vstplugins_arm64.ini");
const scanned = existsSync(cache) ? readFileSync(cache, "utf8") : "";
const bbc = existsSync(join(BBC_DIR, "NKS")) ? presets().length : 0;
line(bbc > 0, "BBC Symphony Orchestra Discover", bbc ? `${bbc} presets in ${BBC_DIR}` : `none in ${BBC_DIR}: it's free from spitfireaudio.com (or set BBCSO_DIR)`);
line(bbc > 0 && /BBC Symphony Orchestra/.test(scanned), "  …as a VST2 REAPER has scanned", /BBC Symphony Orchestra/.test(scanned) ? "yes" : "rescan plug-ins in REAPER (Preferences › VST)");

const ez = existsSync(EZX_DIR) ? rooms() : [];
line(ez.length ? /EZdrummer 3/.test(scanned) : null, "EZdrummer 3 (optional: drums)", ez.length ? `${ez.length} kits: ${ez.join(", ")}` : "not installed: songs without drums still render");

const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
line(ff.status === 0, "ffmpeg", ff.status === 0 ? ff.stdout.split("\n")[0] : "brew install ffmpeg (it writes the mp3)");

const songs = existsSync(join(ROOT, "songs")) ? readdirSync(join(ROOT, "songs")) : [];
line(null, "songs", songs.join(", ") || "none yet");
console.log(missing ? `\n${missing} thing${missing > 1 ? "s" : ""} missing.` : "\nReady: ask Claude for a song (see README.md).");
process.exitCode = missing ? 1 : 0;
