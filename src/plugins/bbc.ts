/**
 * BBC Symphony Orchestra Discover. Its NKS presets carry the plug-in's whole state as XML (JUCE's `VC2!` chunk): the
 * instrument, its articulations, and every control with its resting value and the CC it listens to. So a track's
 * instrument, articulation and any control's resting value are set by editing that XML, with no GUI.
 */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Vst2 } from "../reaper/rpp.ts";

export const BBC_DIR = process.env.BBCSO_DIR ?? join(homedir(), "Spitfire/Spitfire Audio - BBC Symphony Orchestra");

/** The controls a song names, and BBC's ids for them. */
export const CONTROLS = {
  dynamics: "i_dynamics",
  expression: "i_expression",
  vibrato: "i_vibrato",
  release: "i_release",
  tightness: "i_tight",
  reverb: "i_reverb",
  variation: "i_variation",
  gain: "g_gain",
  pan: "g_pan",
} as const;
export type ControlName = keyof typeof CONTROLS;

export interface Control {
  id: string;
  /** Its resting value, 0–1. */
  value: number;
  /** The CC that moves it, if any. */
  cc: number | null;
}

/** The presets installed (`Strings_Violins_1`, `Brass_Horns_a4`, …). */
export function presets(): string[] {
  return readdirSync(join(BBC_DIR, "NKS"))
    .flatMap((f) => f.match(/^BBCSO_Discover_(.+)\.nksf$/)?.[1] ?? [])
    .sort();
}

/** The XML state in a preset's NKS file. */
export function nksXml(preset: string): string {
  const b = readFileSync(join(BBC_DIR, "NKS", `BBCSO_Discover_${preset}.nksf`));
  for (let i = 12; i < b.length;) {
    const id = b.toString("latin1", i, i + 4);
    const n = b.readUInt32LE(i + 4);
    if (id === "PCHK") {
      const c = b.subarray(i + 8 + 4, i + 8 + n); // past the NKS chunk's own version
      if (c.toString("latin1", 0, 4) !== "VC2!") throw new Error(`${preset}: not a JUCE XML state`);
      return c.toString("utf8", 8).replace(/\0+$/, "");
    }
    i += 8 + n + (n & 1);
  }
  throw new Error(`${preset}: no plugin state in its NKS preset`);
}

/** The articulations a preset offers, in order ("b - Violins 1 - Long", "b - Violins 1 - Short Spiccato", …). */
export function articsOf(preset: string, xml = nksXml(preset)): string[] {
  return [...xml.matchAll(/<SETTING id="a_name" value="([^"]+)"\/>/g)].map((m) => m[1]);
}

/** Every control the preset has, from its `<PARAMETERS>`. */
export function controlsOf(preset: string, xml = nksXml(preset)): Control[] {
  const params = xml.match(/<PARAMETERS>[\s\S]*?<\/PARAMETERS>/)?.[0] ?? "";
  return [...params.matchAll(/<PARAM id="([^"]+)" value="([^"]+)" cc="(-?\d+)"/g)].map((m) => ({
    id: m[1],
    value: Number(m[2]),
    cc: Number(m[3]) < 0 ? null : Number(m[3]),
  }));
}

/** The CC a named control listens to in this preset. */
export function ccOf(preset: string, name: ControlName): number {
  const c = controlsOf(preset).find((c) => c.id === CONTROLS[name]);
  if (c?.cc == null) throw new Error(`${preset}: ${name} has no CC`);
  return c.cc;
}

const num = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/**
 * The plug-in's state with one articulation (named, or ending in, `artic`: "Long", "Short Pizzicato") playing, and
 * each control in `rest` resting at its value (0–1) until a CC moves it.
 */
export function bbcChunk(preset: string, artic: string, rest: Partial<Record<ControlName, number>> = {}): Buffer {
  let xml = nksXml(preset);
  const names = articsOf(preset, xml);
  const hits = names.flatMap((n, i) => (n === artic || n.endsWith(` - ${artic}`) ? [i] : []));
  if (hits.length !== 1) throw new Error(`${preset}: ${hits.length} articulations end in "${artic}" (${names.join(", ")})`);
  const k = hits[0];
  let i = 0;
  xml = xml
    .replace(/<ARTIC>[\s\S]*?<\/ARTIC>/g, (a) => a.replace(/(<SETTING id="a_active" value=")\d+/, `$1${i++ === k ? 2 : 0}`))
    .replace(/(<SETTING id="p_lastSelectedPrimaryArtic" value=")\d+/, `$1${k}`);
  for (const [name, v] of Object.entries(rest) as [ControlName, number][]) {
    const id = CONTROLS[name];
    if (!(v >= 0 && v <= 1)) throw new Error(`${preset}: ${name} rests at ${v}, outside 0–1`);
    // both the global control and each articulation's mix copy of it
    xml = xml
      .replace(new RegExp(`(<PARAM id="${id}" value=")[^"]*`), `$1${num(v)}`)
      .replace(new RegExp(`(<SETTING id="${id}" value=")[^"]*`, "g"), `$1${num(v)}`);
  }
  const body = Buffer.from(xml, "utf8");
  const head = Buffer.alloc(8);
  head.write("VC2!", 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, Buffer.from([0])]);
}

/** BBC SO's VST2 build in a REAPER project, playing `preset`'s `artic`. */
export function bbc(preset: string, artic: string, rest: Partial<Record<ControlName, number>> = {}): Vst2 {
  return {
    name: "VSTi: BBC Symphony Orchestra (Spitfire Audio) (32 out)",
    file: "BBC Symphony Orchestra.vst",
    id: 1398894196,
    tag: "<56535453616E746262632073796D7068>",
    outs: 32,
    chunk: bbcChunk(preset, artic, rest),
  };
}
