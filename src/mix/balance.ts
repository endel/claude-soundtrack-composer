/**
 * The mix balanced by measurement: each track's loudness in each section (K-weighted, while it sounds) brought to
 * where its role there puts it under the melody, the section as a whole kept as loud as it was. `balance.yaml` keeps the result between the score and the
 * overrides: each track's fader, and a cut (the voice's volume, patches.ts VOICE) in each section that wants less.
 *
 *   tracks:
 *     hn: { vol: -3.5, sections: { wings: -9.2, apotheosis: -4 } }
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { Rule } from "../score/cascade.ts";
import type { Score } from "../score/song.ts";

/** dB under the melody each role sits, all its tracks together. */
export const TARGET: Record<string, number> = { melody: 0, double: -4, counter: -5, bass: -6, figure: -7, harmony: -9, drums: -4 };

/** The most a pass moves a track in a section: a bigger gap closes over passes, a level misheard can't run away. */
const STEP = 10;

export interface Balance {
  tracks: Record<string, { vol: number; sections: Record<string, number> }>;
}

/** Loudness (LUFS) and seconds sounding, per track and section. */
export type Levels = Map<string, Map<string, { lufs: number; seconds: number }>>;

export interface Move {
  track: string;
  section: string;
  /** What it lacked, and what this pass moved it (at most STEP). */
  want: number;
  dB: number;
}

/** A new balance from levels measured under `current` (none at first). */
export function rebalance(roles: NonNullable<Score["roles"]>, levels: Levels, current?: Balance): { balance: Balance; moves: Move[] } {
  const gain = new Map<string, Map<string, number>>();
  const moves: Move[] = [];
  const now = (t: string, s: string) => (current?.tracks[t]?.vol ?? 0) + (current?.tracks[t]?.sections[s] ?? 0);
  for (const [section, parts] of Object.entries(roles)) {
    const heard = Object.entries(parts).flatMap(([t, role]) => {
      const l = levels.get(t)?.get(section);
      return l && l.seconds >= 0.4 && Number.isFinite(l.lufs) ? [{ t, role, lufs: l.lufs }] : [];
    });
    if (!heard.length) continue;
    // a role's tracks share its level: four basses at −5 together, not each
    const share = (role: string) => (TARGET[role] ?? -6) - 10 * Math.log10(heard.filter((h) => h.role === role).length);
    // the section as loud as it was, only shared out anew: its dynamics are the plan's, the balance only the mix's
    const power = (xs: number[]) => xs.reduce((a, x) => a + 10 ** (x / 10), 0);
    const ref = 10 * Math.log10(power(heard.map((h) => h.lufs)) / power(heard.map((h) => share(h.role))));
    for (const h of heard) {
      const want = ref + share(h.role) - h.lufs;
      const d = Math.max(-STEP, Math.min(STEP, want));
      const g = Math.max(-18, Math.min(15, now(h.t, section) + d));
      if (!gain.has(h.t)) gain.set(h.t, new Map());
      gain.get(h.t)!.set(section, g);
      moves.push({ track: h.t, section, want: +want.toFixed(1), dB: +d.toFixed(1) });
    }
  }
  const tracks: Balance["tracks"] = {};
  for (const [t, by] of gain) {
    // the fader takes the most any section wants; the voice cuts the rest
    const vol = Math.max(...by.values());
    tracks[t] = { vol: +vol.toFixed(1), sections: Object.fromEntries([...by].map(([s, g]) => [s, +(g - vol).toFixed(1)]).filter(([, g]) => (g as number) < -0.05)) };
  }
  // a track this pass didn't hear keeps what it had
  for (const [t, b] of Object.entries(current?.tracks ?? {})) tracks[t] ??= b;
  return { balance: { tracks }, moves };
}

/** The highest a fader goes: REAPER's stop at +12 dB, with room. */
const TOP = 10;

/**
 * The balance as score changes: each fader moved, and the cuts as overrides of `volume` (gain v², so v = 10^(dB/40)).
 * Every fader comes down alike when one would pass the top, which leaves the balance as it is; mastering restores the
 * loudness.
 */
export function applied(score: Score, b: Balance | undefined): { score: Score; rules: Rule[] } {
  if (!b) return { score, rules: [] };
  const rules: Rule[] = [];
  const vols = score.tracks.map((t) => (t.vol ?? 0) + (b.tracks[t.id]?.vol ?? 0));
  const down = Math.max(0, Math.max(...vols) - TOP);
  const tracks = score.tracks.map((t, i) => {
    for (const [s, g] of Object.entries(b.tracks[t.id]?.sections ?? {})) if (score.sections.some((sec) => sec.name === s)) rules.push({ select: `${t.id} @ ${s}`, set: { volume: +(10 ** (g / 40)).toFixed(4) } });
    return { ...t, vol: +(vols[i] - down).toFixed(2) };
  });
  return { score: { ...score, tracks }, rules };
}

export const balanceFile = (dir: string): string => join(dir, "balance.yaml");

export function readBalance(dir: string): Balance | undefined {
  const f = balanceFile(dir);
  return existsSync(f) ? (parse(readFileSync(f, "utf8")) as Balance) : undefined;
}

export function writeBalance(dir: string, b: Balance): void {
  const head = "# Measured by scripts/balance.ts from the last render: each track's fader, and a cut where a section wants less.\n# Balance again after composing; overrides.yaml applies over this.\n";
  writeFileSync(balanceFile(dir), head + stringify(b, { lineWidth: 0, flowLevel: 3 }));
}
