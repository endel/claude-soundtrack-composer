# Composing with this repo

People open Claude Code here and describe a song. You are the composer: you write the song at the level of music
theory, and the engine derives every note, renders it in REAPER with the user's own instruments, and mixes it.

```
prompt.md  →  plan.yaml (you)  →  score.yaml (engine)  →  REAPER render  →  balance.yaml (measured mix)  →  mp3
                                                     overrides.yaml (the user's fine control) applies over both
```

## Composing a song from a prompt

1. If you don't know the machine is set up, run `node scripts/doctor.ts` and help fix what's missing.
2. Make `songs/<slug>/` and save the user's words verbatim in `prompt.md`.
3. Write `plan.yaml`. The format lives in the doc comments of `src/theory/plan.ts` (sections, parts, roles),
   `melody.ts` (themes in scale degrees, statements, development), `harmony.ts` (keys, Roman numerals),
   `rhythm.ts` (step rhythms) and `drums.ts` (grooves). `songs/black-feather/plan.yaml` is a worked example.
4. `node scripts/compose.ts songs/<slug>` derives `score.yaml`. Fix any error, then read the score as a composer
   would: registers, the melody's octave, entries, the number of melody notes "fitted" (moved onto the chords: a
   few is fine, many means the themes don't suit the progression), warnings.
5. `node scripts/compose.ts songs/<slug> --render` renders, balances the mix from what it measures, and renders
   again. It takes a few minutes and REAPER's windows show while it works: run it in the background. Only one
   render at a time.
6. Check `out/<slug>/report.json` (`warnings`, each track's `silent` notes) and `node scripts/levels.ts songs/<slug>`
   (each track's loudness per section, with its role). If balance left something off, `node scripts/balance.ts
   songs/<slug> --render` takes another pass.
7. Tell the user how to listen: `! afplay out/<slug>/<slug>.mp3`.

Then iterate on what they say:
- the music (form, harmony, themes, orchestration, tempo): change `plan.yaml`, compose and render again;
- another take of the same plan: `--seed=<n>`;
- one note, one phrase, a curve, a plug-in setting: `overrides.yaml`, then `node scripts/build.ts songs/<slug>
  --render` (or `--audition="<selector>"` to hear just those bars). Selectors and values: `src/score/select.ts`,
  `cascade.ts`, `values.ts`.

## Rules

- **Original music only.** When a prompt names an existing piece, film, game or artist, write an original piece in
  its manner (its instrumentation, harmony, rhythm, form, mood). Never reproduce its melodies, riffs or lyrics.
- `score.yaml` and `balance.yaml` are generated: never hand-edit them. `overrides.yaml` belongs to the user; add to
  it when they ask for a specific change, and keep their rules.
- Write themes to fit the chords under them; the engine's fitting is a safety net. Give the melody an `octave`.
  Contrast sections (tempo, meter, key, texture) and end them on cadences. Accompaniment roles already play a mark
  or so under the melody, and the balance pass sets levels: don't chase them with `vol`.

## The instruments

- **BBC Symphony Orchestra Discover** (free from Spitfire Audio), `bbc/<id>`:
  strings `vln1 vln2 vla vc` (`long spic pizz trem`) and `cb` (`long spic pizz`); brass `hn tpt tbn btb tba` and
  woodwinds `fl ob cl bsn picc` (`long stac`); `harp celeste timpani bells glock marimba xylo perc piano`.
  No choir, no guitars or synths. Ranges per articulation: `data/bbc-probed.json` (timpani start at C3).
  Controls that work: `dynamics expression release reverb gain pan tune`; Discover ignores its own vibrato, so
  `vibrato vibrato.rate spread tone volume` are played by REAPER after it (`src/reaper/jsfx/voice.jsfx`).
- **EZdrummer 3** (optional), `ezd3`, with `setup: { kit: <room>[/<preset>], mix: { hats: 6, … } }`. The installed
  rooms are listed by the doctor. Drum names: `kick kick2 sidestick snare hat hat-pedal hat-open tom1`…`tom5`
  (high to low) `crash crash2 ride ride-bell ride-crash china splash`, as far as the kit has them.
- Anything else: a track template plus a patch map in `patches/` (`src/patches.ts` says how; `scripts/capture.ts`,
  `scripts/probe.ts`, then `scripts/audit.ts` to learn which controls really change the sound).

## Working on the engine

TypeScript run directly by Node 22.18+ (no build step), one dependency (`yaml`). `npm test` for the unit tests;
`npm run validate` renders checks in REAPER and measures the audio (a few minutes). Facts about the plug-ins were
measured, not assumed; when one surprises you, measure it the same way.
