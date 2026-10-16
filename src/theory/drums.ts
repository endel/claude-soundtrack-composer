/**
 * Drums: a groove, by name or written out, varied from the seed, filling into the next phrase and crashing it in.
 *
 * Named grooves are a 4/4 bar of sixteenths (`shuffle` of triplet eighths); a bar of another meter takes as many
 * steps as it has, the pattern cycling:
 * - `rock`, `halftime`, `four` (four on the floor), `double` (double kick under a backbeat), `gallop`, `blast`
 *   (kick and snare on every eighth), `shuffle`, `march`, `tribal` (toms, no cymbals), `waltz` (3/4), `six` (6/8);
 * - written out, each drum by its name in the kit's map with a rhythm (rhythm.ts): `{ kick: "x..x..x.", snare: "....x..." }`.
 *
 * `cymbal` keeps time on `hat` (the default), `ride`, `hat-open` or `crash`; `fill` every that many bars (and in the
 * last bar, unless `fill: false`); `crash` on the first downbeat (unless false) and after each fill; `ghosts` 0–1,
 * soft snare strokes between the backbeats. How loud the music is (the section's dynamics) sets the velocities and
 * how busy a fill gets.
 */
import { barOf, grid } from "./rhythm.ts";
import type { Context, Ev, Rng } from "./melody.ts";

export const GROOVES: Record<string, Record<string, string>> = {
  rock: { kick: "x.......x.x.....", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." },
  halftime: { kick: "x.....x...x.....", snare: "........x.......", hat: "x.x.x.x.x.x.x.x." },
  four: { kick: "x...x...x...x...", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." },
  double: { kick: "xxxxxxxxxxxxxxxx", snare: "....x.......x...", hat: "x...x...x...x..." },
  gallop: { kick: "x.xxx.xxx.xxx.xx", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." },
  blast: { kick: "x.x.x.x.x.x.x.x.", snare: ".x.x.x.x.x.x.x.x", hat: "x.x.x.x.x.x.x.x." },
  shuffle: { kick: "x.....x.x...", snare: "...x.....x..", hat: "x.xx.xx.xx.x" },
  march: { kick: "x.......x.......", snare: "x.ox.ox.x.ox.oxx" },
  tribal: { kick: "x.....x...x.....", tom4: "x..x..x...x..x..", tom2: "......x.......x.", tom1: "...............x" },
  waltz: { kick: "x...........", snare: "....x...x...", hat: "x.x.x.x.x.x." },
  six: { kick: "x...........", snare: "......x.....", hat: "x.xx.xx.xx.x" },
};

export interface DrumPart {
  groove: string | Record<string, string>;
  cymbal?: string;
  fill?: number | boolean;
  crash?: boolean;
  ghosts?: number;
}

/** Each name a groove might ask for, and what stands in for it in a kit without it. */
const STAND_IN: Record<string, string[]> = {
  ride: ["hat"], "hat-open": ["hat"], crash: ["crash2", "ride"], tom5: ["tom4", "tom3"], tom4: ["tom3", "tom5"], tom3: ["tom2", "tom4"],
  tom2: ["tom1", "tom3"], tom1: ["tom2"], china: ["crash"], splash: ["crash"], "ride-bell": ["ride"], kick2: ["kick"],
};

/** The pattern's characters cycled to `n` steps. */
const steps = (s: string, n: number): string => {
  const clean = s.replace(/\s+/g, "");
  let out = "";
  while (out.length < n) out += clean;
  return out.slice(0, n);
};

/**
 * The drums over beats `a`–`b`. `names` are the kit's drums, so a groove asking for one it hasn't gets the nearest
 * it has.
 */
export function drums(part: DrumPart, a: number, b: number, ctx: Context, names: string[], r: Rng): Ev[] {
  const have = new Set(names);
  const pick = (n: string): string => {
    if (have.has(n)) return n;
    for (const s of STAND_IN[n] ?? []) if (have.has(s)) return s;
    throw new Error(`the kit has no "${n}" (${names.join(", ")})`);
  };
  const g = typeof part.groove === "string" ? GROOVES[part.groove] : part.groove;
  if (!g) throw new Error(`no groove "${part.groove}" (${Object.keys(GROOVES).join(", ")})`);
  const perBeat = part.groove === "shuffle" ? 3 : 4;
  const cymbal = part.cymbal ?? "hat";
  const every = part.fill === false ? 0 : typeof part.fill === "number" ? part.fill : 0;
  const out: Ev[] = [];
  const bars: number[] = [];
  for (let t = a; t < b - 1e-6;) {
    bars.push(t);
    const meter = ctx.meter(t);
    t += (meter[0] * 4) / meter[1];
  }
  let crashNext = part.crash !== false;
  bars.forEach((t0, i) => {
    const meter = ctx.meter(t0);
    const B = (meter[0] * 4) / meter[1];
    const lv = ctx.level(t0);
    const base = 42 + 78 * lv;
    const n = Math.round(B * perBeat);
    const fills = part.fill !== false && ((every > 0 && (i + 1) % every === 0) || i === bars.length - 1);
    const fillBeats = fills ? Math.min(B / 2, lv > 0.62 ? 2 : 1) : 0;
    const fillFrom = t0 + B - fillBeats;
    const bar: Ev[] = [];
    for (const [drum, pat] of Object.entries(g)) {
      const name = pick(drum === "hat" ? cymbal : drum);
      // a named groove is one bar, stretched over this one's steps; a written one may run several bars
      const hits = typeof part.groove === "string" ? grid(steps(pat, n), B)[0] : barOf(grid(pat, B), i);
      for (const h of hits) {
        const at = t0 + h.at;
        if (at >= fillFrom - 1e-6) continue;
        const pos = h.at % 1;
        let vel = base;
        if (drum === "kick" && h.at < 1e-6) vel += 8;
        if (drum === "snare") vel += 6;
        if (drum === "hat") vel += pos < 1e-6 ? 0 : Math.abs(pos - 0.5) < 1e-6 ? -12 : -20;
        if (h.accent > 0) vel += 12;
        if (h.accent < 0) vel = 30 + 20 * lv;
        bar.push({ pitch: name, at, len: h.len, vel, accent: h.accent });
      }
    }
    // ghost strokes in the gaps of the snare's line
    const ghosts = part.ghosts ?? 0;
    if (ghosts > 0 && have.has("snare")) {
      for (const s of [0.75, 1.75, 2.5, 3.75]) {
        const at = t0 + s;
        if (s >= B || at >= fillFrom - 1e-6 || bar.some((e) => Math.abs(e.at - at) < 1e-6 && (e.pitch === "snare" || e.pitch === pick("kick")))) continue;
        if (r() < ghosts * 0.45) bar.push({ pitch: "snare", at, len: 0.25, vel: 26 + 18 * lv, accent: -1 });
      }
    }
    // the fourth bar of a phrase turns over: a kick pushed late, the hat opened
    if (!fills && i % 4 === 3 && typeof part.groove === "string" && !["tribal", "march"].includes(part.groove)) {
      const x = r();
      if (x < 0.45 && B >= 4) bar.push({ pitch: pick("kick"), at: t0 + B - 0.5, len: 0.25, vel: base - 6, accent: 0 });
      else if (x < 0.8 && have.has("hat-open") && cymbal === "hat") {
        const at = t0 + B - 0.5;
        const k = bar.findIndex((e) => e.pitch === "hat" && Math.abs(e.at - at) < 1e-6);
        if (k >= 0) bar[k] = { ...bar[k], pitch: "hat-open", vel: bar[k].vel! + 10 };
      }
    }
    if (crashNext) {
      const k = bar.findIndex((e) => e.pitch === pick(cymbal) && Math.abs(e.at - t0) < 1e-6);
      if (k >= 0) bar.splice(k, 1);
      bar.push({ pitch: pick("crash"), at: t0, len: 1, vel: base + 10, accent: 1 });
      if (!bar.some((e) => e.pitch === pick("kick") && Math.abs(e.at - t0) < 1e-6)) bar.push({ pitch: pick("kick"), at: t0, len: 0.25, vel: base + 8, accent: 1 });
      crashNext = false;
    }
    if (fills) {
      bar.push(...fill(fillFrom, fillBeats, lv, r, pick));
      crashNext = part.crash !== false;
    }
    out.push(...bar);
  });
  for (const e of out) e.vel = Math.max(1, Math.min(127, Math.round(e.vel!)));
  return out;
}

/** A fill over `beats` from `at`, in sixteenths, louder as it goes. */
function fill(at: number, beats: number, lv: number, r: Rng, pick: (n: string) => string): Ev[] {
  const n = Math.round(beats * 4);
  const shapes: string[][] = [
    ["snare", "snare", "tom1", "tom1", "tom2", "tom2", "tom3", "tom3", "tom4", "tom4", "tom5", "tom5"],
    ["snare", "snare", "snare", "snare", "tom1", "tom1", "tom3", "tom3", "tom5", "tom5", "tom5", "tom5"],
    ["tom1", "tom1", "tom2", "tom2", "tom3", "tom3", "tom4", "tom4", "snare", "snare", "snare", "snare"],
    ["snare", "snare", "snare", "snare", "snare", "snare", "snare", "snare", "snare", "snare", "snare", "snare"],
  ];
  const shape = shapes[Math.floor(r() * shapes.length)];
  const out: Ev[] = [];
  const busy = lv > 0.45;
  for (let k = 0; k < n; k++) {
    // a quiet fill plays eighths
    if (!busy && k % 2 === 1) continue;
    const drum = shape[Math.round((k / Math.max(1, n - 1)) * (shape.length - 1))];
    const vel = 52 + 60 * lv + (k / n) * 18 - (k % 2 ? 8 : 0);
    out.push({ pitch: pick(drum), at: at + k / 4, len: 0.25, vel, accent: 0 });
    if (k % 4 === 0 && lv > 0.7) out.push({ pitch: pick("kick"), at: at + k / 4, len: 0.25, vel: vel - 6, accent: 0 });
  }
  return out;
}
