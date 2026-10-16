/**
 * Overrides (`overrides.yaml`) reshape the score's notes without editing it, so a regenerated score keeps them:
 *
 *   - select: "vln1 @ theme m4 b1"
 *     set: { vel: 96, artic: spic, vibrato: { from: 0.1, to: 0.9, ease: in, delay: 0.3 } }
 *   - select: "strings @ theme"
 *     over: span        # the curve runs across all the notes picked (per track), not over each note
 *     set: { dynamics: [[0, mp], [0.8, f], [1, mf]] }
 *
 * `set` takes:
 * - `vel`: 1–127, or `"+n"` / `"-n"` on what it was;
 * - `timing`: ms, later when positive; `len`: a factor on the note's length; `artic`: one of the instrument's;
 * - `humanize`: `{ timing: ms, vel: n }`, a seeded nudge (the same on every build);
 * - any control the note's instrument has (`dynamics`, `expression`, `vibrato`, `release`, …: patches.ts), its value
 *   written as values.ts says.
 *
 * Rules apply from the least specific to the most (select.ts), equal ones in file order, so `*` sets a default
 * that a track, a passage or a note refines. A rule that picks no note is reported, so an override left behind by a
 * changed score doesn't go unnoticed.
 *
 * A score's own rules (`shape`, what a plan's engine wrote) apply first, all of them, however specific: any override
 * outweighs them, the way an author's stylesheet outweighs the browser's.
 */
import { parseSelector, select, specificity } from "./select.ts";
import { where, type Note, type Song } from "./song.ts";
import { resolve, type Value, type Written } from "./values.ts";

export interface Rule {
  select: string;
  set: Record<string, unknown>;
  over?: "note" | "span";
}

export interface Shaped extends Note {
  /** ms */
  timing: number;
  lenScale: number;
  humanize: { timing: number; vel: number };
  controls: Record<string, Value>;
}

/** What each track's instrument offers, for checking what rules ask of it. */
export interface Offer {
  controls(track: string): string[];
  artics(track: string): string[];
  /** Controls the track's instrument has but doesn't respond to. */
  inert(track: string): string[];
}

export function cascade(song: Song, raw: unknown[], offer: Offer, base: unknown[] = []): { notes: Shaped[]; warnings: string[] } {
  const notes: Shaped[] = song.notes.map((n) => ({ ...n, timing: 0, lenScale: 1, humanize: { timing: 0, vel: 0 }, controls: {} }));
  const shapedOf = new Map(song.notes.map((n, i) => [n, notes[i]]));
  const warnings = new Set<string>();
  const rules = [...base, ...raw].map((r, order) => {
    const rule = r as Rule;
    if (!rule || typeof rule.select !== "string" || typeof rule.set !== "object" || !rule.set) {
      const which = order < base.length ? `the score's shape rule ${order + 1}` : `override ${order - base.length + 1}`;
      throw new Error(`${which}: wants { select: "…", set: { … } }, got ${JSON.stringify(r)}`);
    }
    if (rule.over && rule.over !== "note" && rule.over !== "span") throw new Error(`"${rule.select}": over is "note" or "span"`);
    const sel = parseSelector(rule.select);
    return { rule, sel, layer: order < base.length ? 0 : 1, weight: specificity(sel, song), order };
  });
  rules.sort((a, b) => a.layer - b.layer || a.weight - b.weight || a.order - b.order);

  for (const { rule, sel } of rules) {
    const picked = select(sel, song);
    if (!picked.length) { warnings.add(`"${rule.select}" picks no note`); continue; }
    const spans = new Map<string, [number, number]>();
    for (const n of picked) {
      const s = spans.get(n.track);
      spans.set(n.track, [Math.min(s?.[0] ?? Infinity, n.at), Math.max(s?.[1] ?? -Infinity, n.at + n.len)]);
    }
    const tracks = [...spans.keys()];
    for (const key of Object.keys(rule.set)) {
      if (["vel", "timing", "len", "artic", "humanize"].includes(key)) continue;
      const having = tracks.filter((t) => offer.controls(t).includes(key));
      if (!having.length) warnings.add(`"${rule.select}": no track it picks has a control "${key}" (${[...new Set(tracks.flatMap((t) => offer.controls(t)))].join(", ")})`);
      const deaf = having.filter((t) => offer.inert(t).includes(key));
      if (deaf.length) warnings.add(`"${rule.select}": ${deaf.join(", ")} ${deaf.length > 1 ? "don't" : "doesn't"} respond to "${key}" (scripts/audit.ts measured no change)`);
    }
    for (const n of picked) {
      const s = shapedOf.get(n)!;
      for (const [key, v] of Object.entries(rule.set)) {
        const at = `"${rule.select}" at ${where(song, n.at)}`;
        if (key === "vel") {
          const vel = typeof v === "string" && /^[+-]\d+$/.test(v) ? s.vel + Number(v) : Number(v);
          if (!Number.isFinite(vel)) throw new Error(`${at}: vel is 1–127 or "+n"/"-n"`);
          s.vel = Math.max(1, Math.min(127, Math.round(vel)));
        } else if (key === "timing") s.timing = Number(v);
        else if (key === "len") s.lenScale = Number(v);
        else if (key === "artic") {
          const has = offer.artics(n.track);
          if (!has.includes(String(v))) warnings.add(`"${rule.select}": ${n.track} has no articulation "${v}" (${has.join(", ")})`);
          else s.artic = String(v);
        } else if (key === "humanize") {
          const h = v as { timing?: number; vel?: number };
          s.humanize = { timing: h.timing ?? s.humanize.timing, vel: h.vel ?? s.humanize.vel };
        } else {
          if (!offer.controls(n.track).includes(key)) continue;
          const [t0, t1] = rule.over === "span" ? spans.get(n.track)! : [n.at, n.at + n.len];
          try {
            s.controls[key] = resolve(v as Written, t0, t1);
          } catch (e) {
            throw new Error(`${at}: ${key}: ${(e as Error).message}`);
          }
        }
      }
    }
  }
  return { notes, warnings: [...warnings] };
}
