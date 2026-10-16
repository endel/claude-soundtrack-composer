/**
 * REAPER projects written as text: one track per part, a MIDI item on an instrument (a VST2 carrying its state, or a
 * track template's FX chain), its parameters' automation, and the project set to render every track to its own
 * 32-bit float stem.
 */

export interface MidiEvent {
  /** Seconds from the start. */
  t: number;
  msg: [number, number, number];
}

export interface Vst2 {
  /** The name REAPER lists it under, e.g. "VSTi: BBC Symphony Orchestra (Spitfire Audio) (32 out)". */
  name: string;
  file: string;
  /** The plug-in's unique id, and REAPER's tag for it (`<…>` after the id in a saved project). */
  id: number;
  tag: string;
  outs: number;
  /** What the plug-in's getChunk returns. */
  chunk: Buffer;
}

/** A JSFX (a path under REAPER's Effects folder) and its sliders' values. */
export interface Jsfx {
  path: string;
  sliders: number[];
}

/** A plug-in parameter's automation: [s, 0–1] points, straight between them. */
export interface Envelope {
  param: number;
  points: [number, number][];
  /** Which plug-in: 0 the instrument (the default), 1… the effects after it. */
  fx?: number;
}

export interface RppTrack {
  name: string;
  /** A VST2 with its state, or an FX chain as a track template saved it (plugins/template.ts). */
  fx: Vst2 | { chain: string };
  /** Effects after the instrument. */
  post?: Jsfx[];
  events: MidiEvent[];
  envs?: Envelope[];
  /** The fader (linear gain). */
  vol?: number;
  /** −1 … 1 */
  pan?: number;
  /** The track's playback offset (s): negative plays its notes early, so a slow attack lands on the beat. */
  offset?: number;
}

export interface Rpp {
  bpm: number;
  num: number;
  den: number;
  seconds: number;
  /** Where the stems go: `<out>/<track name>.wav`. */
  out: string;
  tracks: RppTrack[];
}

const PPQ = 960;
const b64lines = (b: Buffer, pad: string): string => (b.toString("base64").match(/.{1,128}/g) ?? []).map((l) => pad + l).join("\n");

/** REAPER's VST2 block: its header (pins, the chunk's size), the chunk, an empty program name. */
export function vstBlock(v: Vst2, pad: string): string {
  const h = Buffer.alloc(16 + v.outs * 8 + 12);
  h.writeUInt32LE(v.id, 0);
  h.writeUInt32LE(0xfeed5eee, 4);
  h.writeUInt32LE(0, 8);
  h.writeUInt32LE(v.outs, 12);
  for (let k = 0; k < v.outs; k++) h.writeBigUInt64LE(1n << BigInt(k), 16 + k * 8);
  const o = 16 + v.outs * 8;
  h.writeUInt32LE(v.chunk.length, o);
  h.writeUInt32LE(1, o + 4);
  return [
    `${pad}<VST "${v.name}" "${v.file}" 0 "" ${v.id}${v.tag} ""`,
    b64lines(h, pad + "  "),
    b64lines(v.chunk, pad + "  "),
    `${pad}  AAAAAAAA`,
    `${pad}>`,
  ].join("\n");
}

const hex = (n: number): string => n.toString(16).padStart(2, "0");

/** The events on the project's tick grid, in the order they play: at one tick, note-offs, then controllers, then note-ons. */
export function ticked(p: Rpp, events: MidiEvent[]): { k: number; msg: [number, number, number] }[] {
  const rank = (m: number) => ((m & 0xf0) === 0x80 ? 0 : (m & 0xf0) === 0xb0 ? 1 : 2);
  return events.map((e) => ({ k: Math.round((e.t * p.bpm * PPQ) / 60), msg: e.msg })).sort((a, b) => a.k - b.k || rank(a.msg[0]) - rank(b.msg[0]));
}

function midiSource(p: Rpp, events: MidiEvent[], pad: string): string {
  const end = Math.round((p.seconds * p.bpm * PPQ) / 60);
  const lines = [`${pad}<SOURCE MIDI`, `${pad}  HASDATA 1 ${PPQ} QN`];
  let at = 0;
  for (const e of ticked(p, events)) {
    lines.push(`${pad}  E ${e.k - at} ${hex(e.msg[0])} ${hex(e.msg[1])} ${hex(e.msg[2])}`);
    at = e.k;
  }
  lines.push(`${pad}  E ${Math.max(0, end - at)} b0 7b 00`, `${pad}>`);
  return lines.join("\n");
}

function envBlock(e: Envelope, pad: string): string {
  return [
    `${pad}<PARMENV ${e.param} 0 1 ${e.points[0]?.[1] ?? 0}`,
    `${pad}  ACT 1 -1`,
    `${pad}  VIS 0 1 1`,
    `${pad}  LANEHEIGHT 0 0`,
    `${pad}  ARM 0`,
    `${pad}  DEFSHAPE 0 -1 -1`,
    ...e.points.map(([t, v]) => `${pad}  PT ${t.toFixed(6)} ${v.toFixed(6)} 0`),
    `${pad}>`,
  ].join("\n");
}

/** REAPER's JS block: the path, then every slider's value (`-` for the ones it hasn't). */
function jsBlock(j: Jsfx, pad: string): string {
  const v = Array.from({ length: 64 }, (_, k) => (k < j.sliders.length ? String(+j.sliders[k].toFixed(6)) : "-"));
  return [`${pad}<JS ${j.path} ""`, `${pad}  ${v.join(" ")}`, `${pad}>`].join("\n");
}

/** The track's FX chain, each plug-in's envelopes placed after it (before its `WAK`, as REAPER writes them). */
function fxChain(t: RppTrack, pad: string): string {
  const envsOf = (fx: number) => (t.envs ?? []).filter((e) => (e.fx ?? 0) === fx).map((e) => envBlock(e, pad + "  "));
  const post = (t.post ?? []).flatMap((j, k) => [
    `${pad}  BYPASS 0 0 0`,
    jsBlock(j, pad + "  "),
    `${pad}  FLOATPOS 0 0 0 0`,
    ...envsOf(k + 1),
    `${pad}  WAK 0 0`,
  ]);
  if ("chain" in t.fx) {
    const lines = t.fx.chain.split("\n").map((l) => pad + l);
    const wak = lines.findIndex((l) => l.trim().startsWith("WAK "));
    lines.splice(wak >= 0 ? wak : lines.length - 1, 0, ...envsOf(0));
    lines.splice(lines.length - 1, 0, ...post);
    return lines.join("\n");
  }
  return [
    `${pad}<FXCHAIN`,
    `${pad}  SHOW 0`,
    `${pad}  LASTSEL 0`,
    `${pad}  DOCKED 0`,
    `${pad}  BYPASS 0 0 0`,
    vstBlock(t.fx, pad + "  "),
    `${pad}  FLOATPOS 0 0 0 0`,
    ...envsOf(0),
    `${pad}  WAK 0 0`,
    ...post,
    `${pad}>`,
  ].join("\n");
}

export function writeRpp(p: Rpp): string {
  const out = [
    `<REAPER_PROJECT 0.1 "7.48/macOS-arm64" 0`,
    `  TEMPO ${p.bpm} ${p.num} ${p.den}`,
    `  SAMPLERATE 44100 1 0`,
    `  RENDER_FILE "${p.out}"`,
    `  RENDER_PATTERN $track`,
    `  RENDER_FMT 0 2 0`,
    `  RENDER_1X 0`,
    `  RENDER_RANGE 0 0 ${p.seconds} 0 1000`,
    `  RENDER_RESAMPLE 3 0 1`,
    `  RENDER_ADDTOPROJ 0`,
    `  RENDER_STEMS 3`, // the selected tracks, each to its own file
    `  RENDER_DITHER 0`,
    `  <RENDER_CFG`,
    `    ZXZhdyAAAA==`, // WAV, 32-bit float
    `  >`,
    `  MASTER_NCH 2 2`,
    `  MASTER_VOLUME 1 0 -1 -1 1`,
  ];
  for (const t of p.tracks) {
    out.push(
      `  <TRACK`,
      `    NAME "${t.name}"`,
      `    VOLPAN ${t.vol ?? 1} ${t.pan ?? 0} -1 -1 1`,
      `    PLAYOFFS ${t.offset ?? 0} ${t.offset ? 0 : 1}`, // seconds; flag 1 bypasses it
      `    SEL 1`,
      `    NCHAN 2`,
      `    MAINSEND 1 0`,
      fxChain(t, "    "),
      `    <ITEM`,
      `      POSITION 0`,
      `      LENGTH ${p.seconds}`,
      `      LOOP 0`,
      `      NAME "${t.name}"`,
      midiSource(p, t.events, "      "),
      `    >`,
      `  >`,
    );
  }
  out.push(`>`, ``);
  return out.join("\n");
}
