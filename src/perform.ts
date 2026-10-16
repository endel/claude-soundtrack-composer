/**
 * The performer: shaped notes (score/cascade.ts) played on their instruments, as REAPER tracks.
 *
 * A track whose notes ask for several articulations becomes a REAPER track per articulation ("Violins 1",
 * "Violins 1 (pizz)"): BBC SO plays one articulation per instance. Each REAPER track gets:
 * - the notes, moved by their timing and seeded humanizing, each a breath short so a repeated note re-attacks;
 * - each control the notes set (and the patch always sends), as CC events or a parameter envelope, of the instrument
 *   or of the voice REAPER adds after it (patches.ts VOICE). A note that doesn't set a control plays it at its rest.
 *   When notes overlap, the one that started last is followed: CCs belong to the whole channel, so a chord shares one
 *   vibrato, and a warning says when its notes disagree;
 * - its patch's attack lag as a negative playback offset, so the attack lands on the beat.
 */
import { createHash } from "node:crypto";
import { VOICE, VOICE_FX, type Instrument, type Patch } from "./patches.ts";
import type { Envelope, MidiEvent, RppTrack } from "./reaper/rpp.ts";
import type { Shaped } from "./score/cascade.ts";
import { beatAt, pitchName, seconds, where, type Song, type TrackDef } from "./score/song.ts";
import { isFlat, valueAt } from "./score/values.ts";

/** Seconds before beat 0: room for parts played early. */
export const LEAD = 1;
export const TAIL = 3;
const BREATH = 0.02;
/** How often a moving control is sampled (s). */
const STEP = 0.02;

export interface PlayedNote {
  n: Shaped;
  /** When it's heard (s), timing and humanizing in. */
  on: number;
  off: number;
  vel: number;
}

export interface Played {
  track: TrackDef;
  artic: string;
  patch: Patch;
  rpp: RppTrack;
  notes: PlayedNote[];
}

/** −1…1 per draw, the same for the same song, track and note on every build. */
function draws(seed: string): [number, number] {
  const h = createHash("sha1").update(seed).digest();
  return [(h.readUInt32LE(0) / 0xffffffff) * 2 - 1, (h.readUInt32LE(4) / 0xffffffff) * 2 - 1];
}

export interface PerformOpts {
  /** Labels a beat for warnings (an audition's beats are shifted). */
  where?: (beat: number) => string;
}

export function perform(song: Song, shaped: Shaped[], instrumentOf: (t: TrackDef) => Instrument, o: PerformOpts = {}): { played: Played[]; seconds: number; warnings: string[] } {
  const { seed = 0 } = song.score;
  const sec = (beat: number) => LEAD + seconds(song, beat);
  const label = o.where ?? ((b: number) => where(song, b));
  const warnings: string[] = [];
  const played: Played[] = [];
  const names = new Set<string>();

  for (const t of song.score.tracks) {
    const inst = instrumentOf(t);
    const mine = shaped.filter((n) => n.track === t.id);
    const artics = [...new Set(mine.map((n) => n.artic ?? inst.default))].sort((a, b) => (a === inst.default ? -1 : b === inst.default ? 1 : a.localeCompare(b)));
    for (const artic of artics) {
      const patch = inst.artics[artic];
      if (!patch) throw new Error(`${t.id}: ${inst.name} has no articulation "${artic}" (${Object.keys(inst.artics).join(", ")})`);
      const base = t.name ?? t.id;
      const name = artic === inst.default ? base : `${base} (${artic})`;
      if (names.has(name)) throw new Error(`two REAPER tracks would be called "${name}": stems are named after them`);
      names.add(name);
      const notes: PlayedNote[] = mine.filter((n) => (n.artic ?? inst.default) === artic).map((n) => {
        const [jt, jv] = draws(`${seed}|${t.id}|${n.at.toFixed(4)}|${n.pitch}`);
        const shift = (n.timing + jt * n.humanize.timing) / 1000;
        const on = sec(n.at) + shift;
        const off = Math.max(on + 0.03, sec(n.at + n.len * n.lenScale) + shift - BREATH);
        const vel = Math.max(1, Math.min(127, Math.round(n.vel + jv * n.humanize.vel)));
        if (patch.sounding && !patch.sounding.includes(n.pitch)) warnings.push(`${name} ${label(n.at)}: key ${n.pitch} makes no sound on ${patch.id} (scripts/probe.ts)`);
        else if (patch.range && (n.pitch < patch.range[0] || n.pitch > patch.range[1])) {
          warnings.push(`${name} ${label(n.at)}: ${pitchName(n.pitch)} is outside ${pitchName(patch.range[0])}–${pitchName(patch.range[1])}`);
        }
        return { n, on, off, vel };
      });
      const events: MidiEvent[] = notes.flatMap((p) => [
        { t: p.on, msg: [0x90, p.n.pitch, p.vel] as [number, number, number] },
        { t: p.off, msg: [0x80, p.n.pitch, 0] as [number, number, number] },
      ]);
      const envs: Envelope[] = [];
      let voice = false;
      const used = new Set([...patch.always, ...notes.flatMap((p) => Object.keys(p.n.controls))]);
      for (const c of used) {
        const ctl = patch.controls[c];
        if (!ctl) { warnings.push(`${name}: ${patch.id} has no control "${c}"`); continue; }
        const pts = timeline(song, notes, c, ctl.rest, (msg) => warnings.push(`${name} ${label(msg)}: overlapping notes want different ${c}; the channel follows the latest`));
        if ("cc" in ctl) {
          let last = -1;
          for (const [time, v] of pts) {
            const q = Math.max(1, Math.round(v * 127)); // BBC takes CC1 = 0 for 127
            if (q !== last) events.push({ t: time, msg: [0xb0, ctl.cc, q] });
            last = q;
          }
        } else {
          // envelopes run straight between points: a value that changes after a gap holds until just before, so it
          // steps there rather than drifting through the note before (a curve's samples, STEP apart, still glide)
          const points: [number, number][] = [];
          for (const [time, v] of pts) {
            const last = points[points.length - 1];
            if (last && Math.abs(last[1] - v) <= 1e-4) continue;
            if (last && time - last[0] > STEP * 1.5) points.push([time - 0.002, last[1]]);
            points.push([time, v]);
          }
          if ("voice" in ctl) voice = true;
          envs.push("voice" in ctl ? { param: ctl.voice, points, fx: 1 } : { param: ctl.param, points });
        }
      }
      const post = voice ? [{ path: VOICE_FX, sliders: Object.values(VOICE).sort((a, b) => a.slider - b.slider).map((v) => v.rest) }] : undefined;
      const vol = t.vol === undefined ? 1 : 10 ** (t.vol / 20);
      played.push({ track: t, artic, patch, notes, rpp: { name, fx: patch.fx, post, events, envs, vol, pan: t.pan, offset: patch.lag ? -patch.lag : undefined } });
    }
  }
  return { played, seconds: sec(song.beats) + TAIL, warnings: [...new Set(warnings)] };
}

/** A control over a track's notes, as [s, 0–1] points; `conflict` gets the beat where overlapping notes disagree. */
function timeline(song: Song, notes: PlayedNote[], c: string, rest: number | undefined, conflict: (beat: number) => void): [number, number][] {
  // not at 0: BBC drops controllers sent on the render's first sample (scripts/audit.ts heard them do nothing)
  const out: [number, number][] = rest === undefined ? [] : [[LEAD / 2, rest]];
  const shiftOf = (p: PlayedNote) => p.on - (LEAD + seconds(song, p.n.at));
  const valueOf = (p: PlayedNote, time: number): number | undefined => {
    const v = p.n.controls[c];
    if (!v) return rest;
    return valueAt(v, beatAt(song, time - shiftOf(p) - LEAD));
  };
  const times = new Set<number>();
  for (const p of notes) {
    times.add(p.on - 0.003); // in place before the note-on
    times.add(p.off);
    const v = p.n.controls[c];
    if (v && !isFlat(v)) for (let time = p.on; time < p.off; time += STEP) times.add(time);
  }
  let warned = false;
  for (const time of [...times].sort((a, b) => a - b)) {
    const active = notes.filter((p) => p.on - 0.004 <= time && time < p.off);
    if (!active.length) continue;
    const lead = active.reduce((a, b) => (b.on > a.on ? b : a));
    const v = valueOf(lead, time);
    if (v === undefined) continue;
    // overlaps under 50 ms are hand-offs from note to note, not chords
    if (!warned && active.some((p) => p !== lead && Math.min(p.off, lead.off) - time > 0.05 && Math.abs((valueOf(p, time) ?? v) - v) > 1 / 127)) {
      warned = true;
      conflict(lead.n.at);
    }
    out.push([Math.max(0, time), v]);
  }
  return out;
}
