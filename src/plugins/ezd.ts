/**
 * EZdrummer 3 set up without its window. Its saved state is text: a `SAMPLER { … }` block holding the kit's drums
 * (`instbox`es), mics and mixer, inside JUCE's VST2-compatible wrapper. So a track can:
 * - play any preset of any installed EZX room (`/Library/Application Support/EZDrummer/<EZX>/ezd3presetconf`, each
 *   preset a kit and a mix: its `instbox`es, `mixer` and `macros` are what the state holds);
 * - set any mixer channel's level, in dB on what the preset has;
 * and its note map comes from the kit itself (`instrumentgroups`: which notes play a kick, a closed hat, a tom…).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EZX_DIR = "/Library/Application Support/EZDrummer";

/** The installed rooms (EZXs: `EZX3_EZdrummer3_MainRoom`, `EZX_MetalMachine`, …). */
export function rooms(): string[] {
  if (!existsSync(EZX_DIR)) return [];
  return readdirSync(EZX_DIR).filter((d) => existsSync(join(EZX_DIR, d, "uberconf"))).sort();
}

export const hasPresets = (room: string): boolean => existsSync(join(EZX_DIR, room, "ezd3presetconf"));

/** `TightRoom`, `tight room`, `EZX3_EZdrummer3_TightRoom` → the room's folder name. */
export function roomOf(name: string): string {
  const key = (s: string) => s.toLowerCase().replace(/^ezx\w?_(ezdrummer\d_)?/, "").replace(/[^a-z0-9]/g, "");
  const r = rooms().find((d) => key(d) === key(name));
  if (!r) throw new Error(`no EZdrummer room "${name}" (${rooms().map((d) => key(d)).join(", ")})`);
  return r;
}

/** The line that closes the block opened on `lines[start]`. */
function close(lines: string[], start: number): number {
  let d = 0;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 400) continue; // base64 effect chunks
    for (const ch of l) d += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    if (d === 0) return i;
  }
  throw new Error(`block "${lines[start]}" never closes`);
}

export interface Preset {
  /** Its full name, as EZdrummer lists it ("Studio Basic"). */
  name: string;
  body: string[];
}

const presetCache = new Map<string, Preset[]>();

export function presets(room: string): Preset[] {
  let out = presetCache.get(room);
  if (out) return out;
  if (!hasPresets(room)) return [];
  const lines = readFileSync(join(EZX_DIR, room, "ezd3presetconf"), "utf8").split(/\r?\n/);
  out = [];
  let header = "";
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^"([^"]*)" HEADER \{$/);
    if (h) header = h[1];
    // `"Basic" "Classic Pop Basic" {`, or under a header only `"Classic" {`
    const m = lines.slice(i + 1, i + 4).some((l) => l.trim() === "EZD3fp") && lines[i].match(/^"([^"]*)"(?: "([^"]*)")? \{$/);
    if (!m) continue;
    const end = close(lines, i);
    out.push({ name: m[2] ?? `${header} ${m[1]}`, body: lines.slice(i + 1, end) });
    i = end;
  }
  presetCache.set(room, out);
  return out;
}

/** A preset as the plug-in's `SAMPLER` block. */
export function sampler(room: string, preset?: string): string[] {
  const all = presets(room);
  const p = preset ? all.find((x) => x.name.toLowerCase() === preset.toLowerCase()) : all[0];
  if (!p) throw new Error(`${room} has no preset "${preset}" (${all.map((x) => x.name).join(", ")})`);
  const out = ["SAMPLER {", "HQ {", `soundlib "${room}"`, "mastervol 1", "mastervol2 1", "}"];
  for (let i = 0; i < p.body.length; i++) {
    const l = p.body[i];
    const t = l.trim();
    if (t === "EZD3fp" || /^version \d+$/.test(t) || t.startsWith("EZX ")) continue;
    if (t === "kit {") { i = close(p.body, i); continue; } // the browser's summary of the kit; the state doesn't keep it
    out.push(l.replace(/^(instbox \d+) "[^"]*" \{$/, "$1 {"));
  }
  out.push("}");
  return out;
}

/**
 * The mixer's channels a song can name, each a group of EZdrummer's own (which can be named too: `Tom1`, `KickSub`).
 */
export const CHANNELS: Record<string, string[]> = {
  kick: ["Kick", "KickExt", "KickSub"],
  snare: ["SnareTop", "SnareBottom"],
  hats: ["Hats"],
  toms: ["Tom1", "Tom2", "Tom3", "Tom4", "Tom5"],
  ride: ["Ride"],
  overheads: ["Oh", "OhR", "OhMono", "Kit", "KitR"],
  room: ["Amb", "AmbR", "AmbMono"],
  crunch: ["Trash"],
  percussion: ["PercM-1", "PercS-1", "PercS-1R", "PercM-2", "PercS-2", "PercS-2R", "PercM-3", "PercS-3", "PercS-3R"],
};

/** The state with mixer channels moved by dB (`{ hats: 6, room: -3 }`); warns of a name the mixer hasn't. */
export function mix(text: string[], levels: Record<string, number>, warn: (m: string) => void): string[] {
  const lines = [...text];
  const m = lines.findIndex((l) => l === "mixer {");
  if (m < 0) throw new Error("EZdrummer's state has no mixer");
  const end = close(lines, m);
  const channels = new Map<string, number>();
  for (let i = m + 1; i < end; i++) {
    const c = lines[i].match(/^(\S+) \{$/);
    if (c && lines[i].length < 400) { channels.set(c[1], i); i = close(lines, i); }
  }
  for (const [name, db] of Object.entries(levels)) {
    if (!Number.isFinite(db)) throw new Error(`kit mix "${name}": a level in dB, not ${db}`);
    const names = (CHANNELS[name] ?? [name]).filter((c) => channels.has(c));
    if (!names.length) { warn(`kit mix "${name}": no such channel in this kit (${[...Object.keys(CHANNELS), ...channels.keys()].join(", ")})`); continue; }
    for (const c of names) {
      const at = channels.get(c)!;
      const v = lines.slice(at, close(lines, at)).findIndex((l) => l.startsWith("volume "));
      if (v < 0) continue;
      lines[at + v] = `volume ${+(Number(lines[at + v].slice(7)) * 10 ** (db / 20)).toPrecision(6)}`;
    }
  }
  return lines;
}

/** The state with its `SAMPLER` block replaced (another kit and mix), the rest (editor, grooves) kept. */
export function withSampler(text: string[], block: string[]): string[] {
  const s = text.findIndex((l) => l === "SAMPLER {");
  if (s < 0) throw new Error("EZdrummer's state has no SAMPLER block");
  return [...text.slice(0, s), ...block, ...text.slice(close(text, s) + 1)];
}

/** The room a state plays (`soundlib`). */
export function roomIn(text: string[]): string | undefined {
  return text.find((l) => l.startsWith("soundlib "))?.match(/"(.*)"/)?.[1];
}

/** A state naming only the room: EZdrummer loads the room's own default kit and mix (any EZX, presets or not). */
export const bare = (room: string): string[] => ["SAMPLER {", "HQ {", `soundlib "${room}"`, "mastervol 1", "mastervol2 1", "}", "}"];

/** Each note the kit plays, by its instrument group (`Kick`, `Hi-Hat/Hi-Hat Closed`, `Toms`…). */
export function groups(room: string): Map<number, string> {
  const out = new Map<number, string>();
  const f = join(EZX_DIR, room, "instrumentgroups");
  if (!existsSync(f)) return out;
  const stack: string[] = [];
  let pending = "";
  for (const raw of readFileSync(f, "utf8").split(/\r?\n/)) {
    const l = raw.trim();
    const m = l.match(/^(?:name|subname)\s+"(.*)"/);
    if (m) pending = m[1];
    else if (l === "{") stack.push(pending);
    else if (l === "}") stack.pop();
    else if (/^note\s+\d+/.test(l) && stack[0] !== "(nomatch)") out.set(Number(l.split(/\s+/)[1]), stack.join("/"));
  }
  return out;
}

const SLUG: Record<string, string> = {
  Kick: "kick", Snare: "snare", Sidestick: "sidestick", "Hi-Hat Closed": "hat", "Hi-Hat Open": "hat-open",
  "Hi-Hat Pedal": "hat-pedal", Toms: "tom", Ride: "ride", "Ride Crash": "ride-crash", Crash: "crash", China: "china",
  Splash: "splash",
};
const slug = (group: string): string => {
  const leaf = group.split("/").pop()!;
  return SLUG[leaf] ?? leaf.toLowerCase().replace(/[^a-z0-9]+/g, "-");
};

/**
 * GM's keys for the drums songs name most: [name, the kit's drum, key]. Each is kept only where the kit files the key
 * under that drum. The toms run from the highest (`tom1`, 48) to the lowest (`tom5`, 41), as their pitches measure in
 * every room installed (a kit with fewer toms plays the nearest).
 */
const NAMED: [string, string, number][] = [
  ["kick", "kick", 36], ["kick2", "kick", 35], ["sidestick", "sidestick", 37], ["snare", "snare", 38],
  ["hat", "hat", 42], ["hat-pedal", "hat-pedal", 44], ["hat-open", "hat-open", 46],
  ["tom1", "tom", 48], ["tom2", "tom", 47], ["tom3", "tom", 45], ["tom4", "tom", 43], ["tom5", "tom", 41],
  ["crash", "crash", 49], ["crash2", "crash", 57], ["ride", "ride", 51], ["ride-bell", "ride", 53],
  ["ride-crash", "ride-crash", 59], ["china", "china", 52], ["splash", "splash", 55],
];

/** The kit's drum map: the GM names it agrees with, and every key it plays as `<drum>-<key>` (`crash-50`, `snare-40`). */
export function drumMap(room: string): Record<string, number> {
  const g = groups(room);
  const out: Record<string, number> = {};
  for (const [name, drum, key] of NAMED) if (g.has(key) && slug(g.get(key)!) === drum) out[name] = key;
  for (const [key, group] of [...g].sort((a, b) => a[0] - b[0])) out[`${slug(group)}-${key}`] = key;
  return out;
}

// --- the state inside a REAPER FX chain

/** REAPER's VST block: a header (pins, then the chunk's size), the chunk, then the program name. */
interface VstBlock {
  start: number;
  end: number;
  open: string;
  header: Buffer;
  chunk: Buffer;
  rest: Buffer;
}

function vstIn(chain: string[]): VstBlock {
  const start = chain.findIndex((l) => l.startsWith("<VST "));
  if (start < 0) throw new Error("no VST in the chain");
  const end = chain.indexOf(">", start);
  const bytes = Buffer.concat(chain.slice(start + 1, end).map((l) => Buffer.from(l, "base64")));
  const pins = bytes.readUInt32LE(8) + bytes.readUInt32LE(12);
  const h = 16 + pins * 8 + 12;
  const header = bytes.subarray(0, h);
  const size = header.readUInt32LE(h - 12);
  return { start, end, open: chain[start], header, chunk: bytes.subarray(h, h + size), rest: bytes.subarray(h + size) };
}

// JUCE's VST2-compatible wrapper: [LE size][…]"VstW"…"CcnK"[BE size]"FBCh"…[BE size at 180] then the plug-in's data
const TEXT_AT = 184;

/** The plug-in's state as lines of text. */
export function readState(chain: string): string[] {
  const { chunk } = vstIn(chain.split("\n"));
  if (chunk.toString("latin1", 24, 28) !== "CcnK") throw new Error("EZdrummer's state isn't in the wrapper this reads");
  return chunk.toString("utf8", TEXT_AT, chunk.indexOf(0, TEXT_AT)).split("\n");
}

/** The chain with the plug-in's state replaced, every size along the way moved to match. */
export function writeState(chain: string, text: string[]): string {
  const lines = chain.split("\n");
  const v = vstIn(lines);
  const end = v.chunk.indexOf(0, TEXT_AT);
  const body = Buffer.from(text.join("\n"), "utf8");
  const d = body.length - (end - TEXT_AT);
  const chunk = Buffer.concat([v.chunk.subarray(0, TEXT_AT), body, v.chunk.subarray(end)]);
  chunk.writeUInt32LE(chunk.readUInt32LE(0) + d, 0);
  chunk.writeUInt32BE(chunk.readUInt32BE(28) + d, 28);
  chunk.writeUInt32BE(chunk.readUInt32BE(180) + d, 180);
  const header = Buffer.from(v.header);
  header.writeUInt32LE(chunk.length, header.length - 12);
  const width = Math.max(...lines.slice(v.start + 1, v.end).map((l) => l.length)); // REAPER wraps VST3 state at 280
  const b64 = (b: Buffer) => b.toString("base64").match(new RegExp(`.{1,${width}}`, "g")) ?? [];
  return [...lines.slice(0, v.start + 1), ...b64(header), ...b64(chunk), ...b64(v.rest), ...lines.slice(v.end)].join("\n");
}
