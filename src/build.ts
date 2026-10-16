/**
 * A song built: score and overrides → shaped notes → REAPER tracks → a REAPER project; rendered, its stems, a mix
 * (mastered to −16 LUFS under a −1 dBFS ceiling: audio/master.ts) and a report (each track's level while it plays,
 * and every note that didn't sound: 30 dB under the loudest note of its
 * track, or under −80 dBFS).
 *
 * An audition builds only what a selector picks: the tracks it touches, from a bar before its first note to the end
 * of the bar of its last, in the song's own tempo, so a tweak can be heard in seconds.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { master, type Mastered } from "./audio/master.ts";
import { dB, peak, rms, SR, writeWav, type Stereo } from "./audio/wav.ts";
import { configured, instrument, type Instrument } from "./patches.ts";
import { perform, type Played } from "./perform.ts";
import { applied, type Balance } from "./mix/balance.ts";
import { render } from "./reaper/reaper.ts";
import type { Rpp } from "./reaper/rpp.ts";
import { cascade, type Shaped } from "./score/cascade.ts";
import { parseSelector, select, specificity } from "./score/select.ts";
import { barAt, compose, excerpt, pitchName, where, type Score, type Song, type TrackDef } from "./score/song.ts";

export interface Build {
  song: Song;
  notes: Shaped[];
  played: Played[];
  rpp: Rpp;
  warnings: string[];
  /** An audition's beats in the song. */
  window?: [number, number];
  balance?: Balance;
}

export interface BuildOpts {
  /** Where the stems go. */
  out: string;
  audition?: string;
  instrumentOf?: (id: string) => Instrument;
  /** The measured mix (mix/balance.ts): faders, and cuts between the score's own rules and the overrides. */
  balance?: Balance;
}

export function build(input: Score, rules: unknown[], o: BuildOpts): Build {
  const { score, rules: mixRules } = applied(input, o.balance);
  const byId = o.instrumentOf ?? instrument;
  const setupWarnings: string[] = [];
  const set = new Map<string, Instrument>();
  // each track's instrument, set up as it asks (a kit, a mix), once
  const inst = (t: TrackDef): Instrument => {
    let i = set.get(t.id);
    if (!i) set.set(t.id, (i = configured(byId(t.instrument), t.setup, (m) => setupWarnings.push(`${t.id}: ${m}`))));
    return i;
  };
  const song = compose(score, (t) => { const i = inst(t); return i.artics[i.default].drums; });
  const instOf = (track: string) => inst(score.tracks.find((t) => t.id === track)!);
  const { notes, warnings } = cascade(song, rules, {
    controls: (track) => { const i = instOf(track); return Object.keys(i.artics[i.default].controls); },
    artics: (track) => Object.keys(instOf(track).artics),
    inert: (track) => instOf(track).inert,
  }, [...(score.shape ?? []), ...mixRules]);
  let use = song;
  let shaped = notes;
  let window: [number, number] | undefined;
  if (o.audition) ({ song: use, notes: shaped, window } = crop(song, notes, o.audition));
  const w0 = window?.[0] ?? 0;
  const p = perform(use, shaped, inst, { where: (b) => where(song, b + w0) });
  // the project keeps one tempo: perform.ts has placed every event in seconds by the song's own
  const s0 = use.sections[0];
  const meter = s0.meter ?? score.meter;
  const rpp: Rpp = { bpm: s0.bpm[0], num: meter[0], den: meter[1], seconds: p.seconds, out: o.out, tracks: p.played.map((x) => x.rpp) };
  return { song, notes: shaped, played: p.played, rpp, warnings: [...setupWarnings, ...warnings, ...p.warnings], window, balance: o.balance };
}

/** The tracks a selector touches, from a bar before what it picks to the end of the bar it ends in, moved to beat 0. */
export function crop(song: Song, notes: Shaped[], selector: string): { song: Song; notes: Shaped[]; window: [number, number] } {
  const sel = parseSelector(selector);
  specificity(sel, song);
  const picked = select(sel, song);
  if (!picked.length) throw new Error(`audition "${selector}" picks no note`);
  const tracks = new Set(picked.map((n) => n.track));
  const first = barAt(song, Math.min(...picked.map((n) => n.at)));
  const w0 = song.bars[Math.max(0, first - 1)];
  const last = Math.max(...picked.map((n) => n.at + n.len));
  const w1 = song.bars.find((b) => b >= last - 1e-6) ?? song.beats;
  const kept = notes
    .filter((n) => tracks.has(n.track) && n.at >= w0 - 1e-6 && n.at < w1 - 1e-6)
    .map((n) => ({ ...n, at: n.at - w0, controls: Object.fromEntries(Object.entries(n.controls).map(([k, v]) => [k, v.map(([t, x]) => [t - w0, x] as [number, number])])) }));
  const cut = excerpt(song, w0, w1);
  const score = { ...song.score, tracks: song.score.tracks.filter((t) => tracks.has(t.id)) };
  return { song: { ...cut, score, notes: kept }, notes: kept, window: [w0, w1] };
}

export interface TrackReport {
  name: string;
  notes: number;
  /** dBFS RMS while it plays. */
  level: number;
  peak: number;
  silent: string[];
}

export interface Report {
  title: string;
  seconds: number;
  tracks: TrackReport[];
  warnings: string[];
  files: { rpp: string; wav: string; mp3: string };
  /** The mixdown's loudness (LUFS) before and after mastering, and the most the limiter took off. */
  master: Mastered;
  /** The balance it was rendered with, which a new balance starts from. */
  balance: Balance | null;
}

/** Renders a build in REAPER into `dir`: stems, the mix (`<name>.wav`, `.mp3`, peaking at −1 dBFS), `report.json`. */
export function renderBuild(b: Build, dir: string, name: string): Report & { stems: Map<string, Stereo> } {
  mkdirSync(dir, { recursive: true });
  const rppPath = join(dir, `${name}.rpp`);
  const stems = render(b.rpp, rppPath, { warmup: Math.max(0, ...b.played.map((p) => p.patch.warmup ?? 0)) });
  const tracks: TrackReport[] = b.played.map((p) => {
    const s = stems.get(p.rpp.name)!;
    const lv = p.notes.map((x) => dB(rms(s, x.on + 0.03, Math.max(x.on + 0.12, x.off))));
    // a kit's soft hit under the kick's tail can't be told from silence by level: kits are checked by key at build
    // (perform.ts, against the keys the probe heard), and here only for true silence
    const floor = p.patch.drums ? -80 : Math.max(Math.max(...lv) - 30, -80);
    let e = 0;
    let len = 0;
    for (const x of p.notes) { const d = Math.max(0.09, x.off - x.on - 0.03); e += rms(s, x.on + 0.03, x.on + 0.03 + d) ** 2 * d; len += d; }
    return {
      name: p.rpp.name,
      notes: p.notes.length,
      level: +dB(Math.sqrt(e / Math.max(len, 1e-9))).toFixed(1),
      peak: +dB(peak(s)).toFixed(1),
      silent: p.notes.filter((_, i) => lv[i] < floor).map((x) => `${pitchName(x.n.pitch)} at ${where(b.song, x.n.at + (b.window?.[0] ?? 0))}`),
    };
  });
  const n = Math.round(b.rpp.seconds * SR);
  const mix: Stereo = { l: new Float32Array(n), r: new Float32Array(n) };
  for (const s of stems.values()) for (let i = 0; i < Math.min(n, s.l.length); i++) { mix.l[i] += s.l[i]; mix.r[i] += s.r[i]; }
  const mastered = master(mix);
  const wav = join(dir, `${name}.wav`);
  const mp3 = join(dir, `${name}.mp3`);
  writeWav(wav, mix);
  const enc = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-q:a", "2", mp3], { encoding: "utf8" });
  if (enc.status !== 0) throw new Error(`ffmpeg: ${enc.stderr}`);
  const report: Report = { title: b.song.score.title, seconds: +b.rpp.seconds.toFixed(2), tracks, warnings: b.warnings, files: { rpp: rppPath, wav, mp3 }, master: mastered, balance: b.balance ?? null };
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 1) + "\n");
  return { ...report, stems };
}
