/**
 * Composer's own REAPER: a separate instance (`-newinst`) on its own resource folder (`.reaper/`: the user's plug-in
 * caches and licence copied in, the stock JSFX linked, and composer's own as `composer/`), so the user's settings
 * and any other REAPER running are never touched. Each call starts it, does one thing and lets it quit; its windows
 * show while it works.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWav, type Stereo } from "../audio/wav.ts";
import { templateChain } from "../plugins/template.ts";
import { writeRpp, type Rpp } from "./rpp.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "../..");
const RES = join(ROOT, ".reaper");
const JOBS = join(RES, "jobs");
const EMPTY = join(RES, "empty.rpp");
const INI = join(RES, "reaper.ini");
export const REAPER_BIN = process.env.REAPER_BIN ?? "/Applications/REAPER.app/Contents/MacOS/REAPER";
export const USER_RES = join(homedir(), "Library/Application Support/REAPER");
const CACHES = ["reaper-vstplugins_arm64.ini", "reaper-auplugins_arm64.ini", "reaper-auplugins_arm64-bc.ini", "reaper-fxtags.ini", "reaper-reginfo2.ini"];
const ARGS = ["-newinst", "-nosplash", "-ignoreerrors", "-cfgfile", INI];

/** The resource folder, its plug-in caches refreshed from the user's every time. */
function setup(): void {
  mkdirSync(JOBS, { recursive: true });
  for (const f of CACHES) if (existsSync(join(USER_RES, f))) copyFileSync(join(USER_RES, f), join(RES, f));
  const fx = join(RES, "Effects");
  mkdirSync(fx, { recursive: true });
  for (const d of readdirSync(join(USER_RES, "Effects"))) {
    const link = join(fx, d);
    if (!existsSync(link)) symlinkSync(join(USER_RES, "Effects", d), link);
  }
  if (!existsSync(join(fx, "composer"))) symlinkSync(join(HERE, "jsfx"), join(fx, "composer"));
  const user = existsSync(join(USER_RES, "reaper.ini")) ? readFileSync(join(USER_RES, "reaper.ini"), "utf8") : "";
  const keep = (k: string) => user.match(new RegExp(`^${k}=.*$`, "m"))?.[0];
  writeFileSync(INI, [
    "[reaper]",
    ...["nag", "coreaudioindevnew", "coreaudiooutdevnew", "coreaudiobs"].flatMap((k) => keep(k) ?? []),
    "coreaudiosrate=44100",
    "coreaudiosrateuse=1",
    "renderclosewhendone=20",
    "loadlastproj=0",
    "projecttabs=0",
    "mixwnd_vis=0",
    "errnowarn=12",
    "",
    "[verchk]",
    `lastt=${Math.floor(Date.now() / 1000)}`,
    "",
  ].join("\n"));
  writeFileSync(EMPTY, `<REAPER_PROJECT 0.1 "7.48/macOS-arm64" 0\n  SAMPLERATE 44100 1 0\n>\n`);
}

/** A value as a Lua literal. */
function lua(v: unknown): string {
  if (v === null || v === undefined) return "nil";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`a job can't carry ${v}`);
    return Number.isInteger(v) ? String(v) : v.toPrecision(12);
  }
  if (typeof v === "string") return JSON.stringify(v).replace(/\\u([0-9a-fA-F]{4})/g, "\\u{$1}");
  if (Array.isArray(v)) return `{${v.map(lua).join(",")}}`;
  return `{${Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).map(([k, x]) => `[${JSON.stringify(k)}]=${lua(x)}`).join(",")}}`;
}

/**
 * Runs one of `lua/`'s scripts in a fresh REAPER and returns what it answered. The script reads its job from
 * `COMPOSER_JOB` (a Lua file returning the job, with `out` and `empty` added), writes `{ ok, … }` to `out`, and quits.
 */
export function runLua<T = Record<string, unknown>>(script: string, job: Record<string, unknown>, timeoutS = 300): T {
  setup();
  const id = `${Date.now()}-${process.pid}`;
  const jobPath = join(JOBS, `${id}.job.lua`);
  const out = join(JOBS, `${id}.out.json`);
  writeFileSync(jobPath, `return ${lua({ ...job, out, empty: EMPTY })}\n`);
  const r = spawnSync(REAPER_BIN, [...ARGS, join(HERE, "lua", script)], {
    timeout: timeoutS * 1000, encoding: "utf8", env: { ...process.env, COMPOSER_JOB: jobPath },
  });
  rmSync(jobPath, { force: true });
  if (!existsSync(out)) throw new Error(`${script}: REAPER gave no answer (${r.error?.message ?? `exit ${r.status}`}); a dialog may be open in it`);
  const res = JSON.parse(readFileSync(out, "utf8"));
  rmSync(out);
  if (!res.ok) throw new Error(`${script}: ${res.error}`);
  return res;
}

/**
 * Writes the project to `rppPath`, has REAPER render it, and returns each track's stem by name. `warmup` (s) is how
 * long the project stays open before the render starts: a plug-in that loads its samples in the background (EZdrummer)
 * plays silence in a render that starts at once.
 */
export function render(proj: Rpp, rppPath: string, o: { warmup?: number; timeoutS?: number } = {}): Map<string, Stereo> {
  const p = { ...proj, out: resolve(proj.out) };
  rmSync(p.out, { recursive: true, force: true });
  mkdirSync(p.out, { recursive: true });
  writeFileSync(rppPath, writeRpp(p));
  const t0 = Date.now();
  const job = { project: resolve(rppPath), wait: o.warmup ?? 0 };
  try {
    runLua("render.lua", job, (o.warmup ?? 0) + (o.timeoutS ?? 600));
  } catch (e) {
    // EZdrummer has once taken REAPER down while several kits loaded at once; the same project rendered on a retry
    if (!/gave no answer/.test((e as Error).message)) throw e;
    console.error(`${(e as Error).message}; rendering again`);
    runLua("render.lua", job, (o.warmup ?? 0) + (o.timeoutS ?? 600));
  }
  const stems = new Map<string, Stereo>();
  for (const t of p.tracks) {
    const f = join(p.out, `${t.name}.wav`);
    if (!existsSync(f)) throw new Error(`no ${f} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    stems.set(t.name, readWav(f));
  }
  return stems;
}

/**
 * An FX chain as its plug-in saves it after `wait` seconds loaded: a state that names only a kit, once EZdrummer has
 * filled the kit and its mixer in. Kept in `.reaper/cache/` by the chain it started from.
 */
export function settle(chain: string, wait: number): string {
  const key = createHash("sha1").update(chain).digest("hex").slice(0, 16);
  const file = join(RES, "cache", `${key}.RTrackTemplate`);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    const proj = join(RES, "cache", `${key}.rpp`);
    writeFileSync(proj, writeRpp({ bpm: 120, num: 4, den: 4, seconds: 1, out: join(RES, "cache", key), tracks: [{ name: "settle", fx: { chain }, events: [] }] }));
    runLua("capture.lua", { project: proj, wait, file }, wait + 300);
    rmSync(proj, { force: true });
  }
  return templateChain(file);
}
