/**
 * The instruments a track can name. An instrument has articulations, and each articulation a patch: what plays it,
 * the notes it sounds, how late its attack lands, its drum map if it's a kit, and the controls a song can move.
 *
 * - `bbc/<section>`: BBC SO Discover (vln1 vln2 vla vc cb, hn tpt tbn btb tba, fl ob cl bsn picc, harp celeste
 *   timpani bells glock marimba xylo perc piano), a patch per articulation generated from the plug-in's own presets
 *   (plugins/bbc.ts), with measured ranges (scripts/ranges.ts) and attack lags (data/bbc-probed.json).
 * - `<id>`: `patches/<id>.json` playing the track template beside it, `patches/<id>.RTrackTemplate`
 *   (scripts/capture.ts, or saved from REAPER):
 *   `{ "name", "range": [lo, hi], "lag": s, "warmup": s, "drums": { "kick": 36, … }, "controls": { "<name>": { "cc": n, "rest": 0–1 } | { "param": index, "rest": 0–1 } }, "setup": "ezdrummer" }`.
 *   `warmup` defaults to 12 s: EZdrummer needs about 10 to load its kit before a render hears it. `"setup":
 *   "ezdrummer"` reads the drum map from the kit, and lets a track pick its kit and mix (plugins/ezd.ts):
 *   `setup: { kit: "TightRoom/Classic Pop Basic", mix: { hats: 6, room: -3 } }` in score.yaml.
 *
 * A control is a CC, or a plug-in parameter automated on its track. `rest` is where it sits until a song moves it.
 * A control the instrument hasn't, or doesn't respond to (scripts/audit.ts), REAPER plays itself when it can (VOICE):
 * vibrato, its rate, spread, tone, volume and pan.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bbc, controlsOf, nksXml } from "./plugins/bbc.ts";
import * as ezd from "./plugins/ezd.ts";
import { templateChain } from "./plugins/template.ts";
import { ROOT, settle } from "./reaper/reaper.ts";
import type { Vst2 } from "./reaper/rpp.ts";
import { MARKS } from "./score/values.ts";

/** A CC, a parameter of the instrument, or a slider of the voice REAPER adds after it (VOICE). */
export type Control = ({ cc: number } | { param: number } | { voice: number }) & { rest?: number };

/** REAPER's own voice (reaper/jsfx/voice.jsfx), after an instrument that needs it. */
export const VOICE_FX = "composer/voice.jsfx";

/**
 * The controls the voice plays: its slider, and the rest that leaves the sound as it was. Vibrato bends the pitch of
 * everything the track plays at once (a section's chord shares one vibrato, as it shares a CC); it adds to what the
 * samples recorded. 1 is 60 cents deep; its rate runs 3–8 Hz.
 */
export const VOICE: Record<string, { slider: number; rest: number }> = {
  vibrato: { slider: 0, rest: 0 },
  "vibrato.rate": { slider: 1, rest: 0.5 },
  spread: { slider: 2, rest: 0.5 },
  tone: { slider: 3, rest: 0.5 },
  volume: { slider: 4, rest: 1 },
  pan: { slider: 5, rest: 0.5 },
};

/** The instrument's controls with the voice standing in for each it hasn't or doesn't respond to. */
function voiced(native: Record<string, Control>, inert: string[]): { controls: Record<string, Control>; inert: string[] } {
  const controls = { ...native };
  for (const [name, v] of Object.entries(VOICE)) {
    if (native[name] && !inert.includes(name)) continue;
    if (name === "vibrato.rate" && controls.vibrato && !("voice" in controls.vibrato)) continue; // rates only the voice's own
    controls[name] = { voice: v.slider, rest: v.rest };
  }
  return { controls, inert: inert.filter((c) => !("voice" in (controls[c] ?? {}))) };
}

export interface Patch {
  id: string;
  fx: Vst2 | { chain: string };
  range?: [number, number];
  /** Seconds from a note-on to its attack being heard; the performer plays the track that much early. */
  lag: number;
  controls: Record<string, Control>;
  /** The plug-in's own controls, voice aside: what scripts/audit.ts measures. */
  native: Record<string, Control>;
  drums?: Record<string, number>;
  /** The keys that make a sound, as scripts/probe.ts measured them. */
  sounding?: number[];
  /** Controls sent at the start at their rest, whether a song sets them or not. */
  always: string[];
  /** Seconds the project stays open before rendering, for a plug-in that loads its samples in the background. */
  warmup?: number;
}

export interface Instrument {
  id: string;
  name: string;
  artics: Record<string, Patch>;
  default: string;
  /** Controls scripts/audit.ts heard change nothing (catalog/effect/<id>.json), with no voice standing in. */
  inert: string[];
  /** The instrument set up as a track asks (`setup:` in score.yaml). */
  setup?: (o: Record<string, unknown>, warn: (m: string) => void) => Instrument;
}

/** A track's instrument, set up as it asks. */
export function configured(i: Instrument, setup: Record<string, unknown> | undefined, warn: (m: string) => void): Instrument {
  if (!setup || !Object.keys(setup).length) return i;
  if (!i.setup) throw new Error(`${i.id} takes no setup (${Object.keys(setup).join(", ")})`);
  return i.setup(setup, warn);
}

function inertOf(id: string): string[] {
  const f = join(ROOT, "catalog/effect", `${id.replace("/", "-")}.json`);
  if (!existsSync(f)) return [];
  const { effect } = JSON.parse(readFileSync(f, "utf8")) as { effect: Record<string, { changes: boolean }> };
  return Object.entries(effect).filter(([, e]) => !e.changes).map(([c]) => c);
}

const BOWED = { long: "Long", spic: "Short Spiccato", pizz: "Short Pizzicato", trem: "Tremolo" };
const BLOWN = { long: "Long", stac: "Short Staccatissimo" };
const one = (artic: string) => ({ default: artic });

const BBC: Record<string, { name: string; preset: string; artics: Record<string, string> }> = {
  vln1: { name: "Violins 1", preset: "Strings_Violins_1", artics: BOWED },
  vln2: { name: "Violins 2", preset: "Strings_Violins_2", artics: BOWED },
  vla: { name: "Violas", preset: "Strings_Violas", artics: BOWED },
  vc: { name: "Celli", preset: "Strings_Celli", artics: BOWED },
  cb: { name: "Basses", preset: "Strings_Basses", artics: { long: "Long", spic: "Short Spiccato", pizz: "Short Pizzicato" } },
  hn: { name: "Horns", preset: "Brass_Horns_a4", artics: BLOWN },
  tpt: { name: "Trumpets", preset: "Brass_Trumpets_a3", artics: BLOWN },
  tbn: { name: "Trombones", preset: "Brass_Tenor_Trombones_a3", artics: BLOWN },
  btb: { name: "Bass Trombones", preset: "Brass_Bass_Trombones_a2", artics: BLOWN },
  tba: { name: "Tuba", preset: "Brass_Tuba", artics: BLOWN },
  fl: { name: "Flutes", preset: "Woodwinds_Flutes_a3", artics: BLOWN },
  ob: { name: "Oboes", preset: "Woodwinds_Oboes_a3", artics: BLOWN },
  cl: { name: "Clarinets", preset: "Woodwinds_Clarinets_a3", artics: BLOWN },
  bsn: { name: "Bassoons", preset: "Woodwinds_Bassoons_a3", artics: BLOWN },
  picc: { name: "Piccolo", preset: "Woodwinds_Piccolo", artics: BLOWN },
  harp: { name: "Harp", preset: "Percussion_Harp_and_Celeste", artics: one("Harp - Short Sustained Discover") },
  celeste: { name: "Celeste", preset: "Percussion_Harp_and_Celeste", artics: one("Celeste - Short Sustained Discover") },
  timpani: { name: "Timpani", preset: "Percussion_Percussion", artics: one("Timpani - Short Hits Discover") },
  bells: { name: "Tubular Bells", preset: "Percussion_Tuned_Percussion", artics: one("Tubular bells - Short Hits Discover") },
  glock: { name: "Glockenspiel", preset: "Percussion_Tuned_Percussion", artics: one("Glockenspiel - Short Hits Discover") },
  marimba: { name: "Marimba", preset: "Percussion_Tuned_Percussion", artics: one("Marimba - Short Hits Discover") },
  xylo: { name: "Xylophone", preset: "Percussion_Tuned_Percussion", artics: one("Xylophone - Short Hits Discover") },
  perc: { name: "Percussion", preset: "Percussion_Percussion", artics: one("Untuned Percussion - Hits") },
  piano: { name: "Piano", preset: "Piano", artics: one("Piano") },
};

const BBC_CC_NAMES: Record<string, string> = {
  i_dynamics: "dynamics", i_expression: "expression", i_vibrato: "vibrato", i_release: "release", i_tight: "tightness",
  i_reverb: "reverb", i_variation: "variation", i_pedvol: "pedal", g_gain: "gain", g_pan: "pan",
};
/** BBC's controls with no CC, moved as plug-in parameters (by the names catalog/host.json lists). */
const BBC_PARAMS: Record<string, string> = { mix: "Simple Mix", spread: "Stereo Spread", tune: "Global Tune", direction: "Direction" };

let probed: Record<string, { lo: number; hi: number; lag: number }> | null = null;
let bbcParams: Record<string, { index: number; value: number }> | null = null;

function bbcHostParams(): Record<string, { index: number; value: number }> {
  if (bbcParams) return bbcParams;
  bbcParams = {};
  const f = join(ROOT, "catalog/host.json");
  if (!existsSync(f)) return bbcParams;
  const host = JSON.parse(readFileSync(f, "utf8")) as { name: string; params?: { index: number; name: string; value: number }[] }[];
  const b = host.find((p) => p.name?.includes("BBC Symphony Orchestra"));
  for (const p of b?.params ?? []) bbcParams[p.name] = { index: p.index, value: p.value };
  return bbcParams;
}

function bbcInstrument(key: string): Instrument {
  const fam = BBC[key];
  if (!fam) throw new Error(`no BBC instrument "bbc/${key}" (${Object.keys(BBC).map((k) => `bbc/${k}`).join(", ")})`);
  probed ??= JSON.parse(readFileSync(join(ROOT, "data/bbc-probed.json"), "utf8"));
  const xml = nksXml(fam.preset);
  const controls: Record<string, Control> = {};
  for (const c of controlsOf(fam.preset, xml)) {
    if (c.cc === null) continue;
    const name = BBC_CC_NAMES[c.id] ?? (c.id.startsWith("m_") ? `mic.${c.id.slice(2)}` : null);
    if (name) controls[name] = { cc: c.cc, rest: c.value };
  }
  // BBC rests at full dynamics and expression; a song that sets neither should start at mf
  controls.dynamics.rest = MARKS.mf;
  controls.expression.rest = 0.9;
  const host = bbcHostParams();
  for (const [name, param] of Object.entries(BBC_PARAMS)) if (host[param]) controls[name] = { param: host[param].index, rest: host[param].value };
  const v = voiced(controls, inertOf(`bbc/${key}`));
  const artics: Record<string, Patch> = {};
  for (const [a, artic] of Object.entries(fam.artics)) {
    const m = probed![a === "default" ? key : `${key}-${a}`];
    artics[a] = {
      id: `bbc/${key}${a === "default" ? "" : `/${a}`}`,
      fx: bbc(fam.preset, artic),
      range: m ? [m.lo, m.hi] : undefined,
      lag: m?.lag ?? 0,
      controls: v.controls,
      native: controls,
      always: ["dynamics", "expression"],
    };
  }
  return { id: `bbc/${key}`, name: fam.name, artics, default: Object.keys(fam.artics)[0], inert: v.inert };
}

interface PatchFile {
  name?: string;
  range?: [number, number];
  lag?: number;
  drums?: Record<string, number>;
  sounding?: number[];
  controls?: Record<string, Control>;
  always?: string[];
  warmup?: number;
  setup?: "ezdrummer";
}

function templateInstrument(id: string): Instrument {
  const json = join(ROOT, "patches", `${id}.json`);
  const tpl = join(ROOT, "patches", `${id}.RTrackTemplate`);
  if (!existsSync(json) || !existsSync(tpl)) throw new Error(`no instrument "${id}": wants patches/${id}.json and patches/${id}.RTrackTemplate`);
  const f = JSON.parse(readFileSync(json, "utf8")) as PatchFile;
  const v = voiced(f.controls ?? {}, inertOf(id));
  const patch: Patch = { id, fx: { chain: templateChain(tpl) }, range: f.range, lag: f.lag ?? 0, controls: v.controls, native: f.controls ?? {}, drums: f.drums, sounding: f.sounding, always: f.always ?? [], warmup: f.warmup ?? 12 };
  const inst: Instrument = { id, name: f.name ?? id, artics: { default: patch }, default: "default", inert: v.inert };
  return f.setup === "ezdrummer" ? ezdrummer(inst) : inst;
}

/**
 * EZdrummer, its drum map read from the kit it plays, set up by `{ kit, mix }`:
 * - `kit`: an installed room (`MainRoom`, `TightRoom`, `MetalMachine`…), or one of its presets (`TightRoom/Classic Pop
 *   Basic`); a room alone plays its first preset, or for a room without presets, the kit EZdrummer loads for it;
 * - `mix`: dB on mixer channels (plugins/ezd.ts CHANNELS: kick, snare, hats, toms, ride, overheads, room, crunch,
 *   percussion, or EZdrummer's own: Tom1, KickSub…).
 */
function ezdrummer(base: Instrument): Instrument {
  const patch = base.artics.default;
  const chain = (patch.fx as { chain: string }).chain;
  const home = ezd.roomIn(ezd.readState(chain));
  const kitted = (p: Patch, room: string | undefined): Patch => ({ ...p, drums: room ? ezd.drumMap(room) : p.drums, sounding: room === home ? p.sounding : undefined });
  const setup = (o: Record<string, unknown>, warn: (m: string) => void): Instrument => {
    for (const k of Object.keys(o)) if (k !== "kit" && k !== "mix") throw new Error(`${base.id}: setup takes kit and mix, not "${k}"`);
    let text = ezd.readState(chain);
    let room = home;
    if (o.kit !== undefined) {
      const [r, preset] = String(o.kit).split("/");
      room = ezd.roomOf(r);
      if (preset && !ezd.hasPresets(room)) throw new Error(`${room} has no presets to pick "${preset}" from`);
      text = ezd.withSampler(text, ezd.hasPresets(room) ? ezd.sampler(room, preset) : ezd.bare(room));
    }
    if (o.mix !== undefined) {
      if (typeof o.mix !== "object" || !o.mix) throw new Error(`${base.id}: mix is { channel: dB, … }`);
      // a room without presets has its mixer only once EZdrummer has loaded it
      if (!text.includes("mixer {")) text = ezd.readState(settle(ezd.writeState(chain, text), (patch.warmup ?? 12) + 8));
      text = ezd.mix(text, Object.fromEntries(Object.entries(o.mix).map(([c, db]) => [c, Number(db)])), warn);
    }
    // another room's samples load from disk while the project waits
    const warmup = room === home ? patch.warmup : (patch.warmup ?? 12) + 8;
    return { ...base, setup: undefined, artics: { default: kitted({ ...patch, warmup, fx: { chain: ezd.writeState(chain, text) } }, room) } };
  };
  return { ...base, artics: { default: kitted(patch, home) }, setup };
}

const cache = new Map<string, Instrument>();

export function instrument(id: string): Instrument {
  let i = cache.get(id);
  if (!i) {
    i = id.startsWith("bbc/") ? bbcInstrument(id.slice(4)) : templateInstrument(id);
    cache.set(id, i);
  }
  return i;
}
