# Claude Soundtrack Composer

Describe a song to Claude. Claude composes it at the level of music theory (form, keys, chords, themes, who plays
what), a seeded engine works out every note, and REAPER renders it with the virtual instruments on your own
machine. The mix is balanced by measuring the render. There's no interface to click through: you talk, it plays.

```
"a theme song inspired by Sephiroth"
   → plan.yaml      Claude: C# minor, an omen at 66 bpm, a 3+3+2 string riff, a brass chant, the main theme…
   → score.yaml     the engine: voice leading, melodies fitted to chords, ostinatos, bass lines, drums, dynamics
   → REAPER         BBC Symphony Orchestra Discover and EZdrummer 3, one track per articulation
   → balance.yaml   each part's loudness measured and set by its role under the melody
   → black-feather.mp3
```

## Listen

[`songs/black-feather/black-feather.mp3`](songs/black-feather/black-feather.mp3) (2:21), composed from the prompt
"A theme song inspired by Sephiroth/One winged angel": an original piece in that manner, not a copy. Read the
[plan Claude wrote](songs/black-feather/plan.yaml) and the [score the engine derived](songs/black-feather/score.yaml).

## What you need

- macOS (developed on Apple Silicon) and [REAPER](https://www.reaper.fm) 7, opened once so it has scanned your
  plug-ins.
- [BBC Symphony Orchestra Discover](https://www.spitfireaudio.com/bbc-symphony-orchestra-discover), free from
  Spitfire Audio, installed as a VST2 (set `BBCSO_DIR` if it isn't in `~/Spitfire`).
- Optionally [EZdrummer 3](https://www.toontrack.com/product/ezdrummer-3/) for drums.
- Node 22.18 or later, `ffmpeg` (`brew install ffmpeg`) and [Claude Code](https://claude.com/claude-code).

```sh
git clone https://github.com/endel/claude-soundtrack-composer
cd claude-soundtrack-composer
npm install
npm run doctor      # checks all of the above and says what's missing
```

## Compose

Open Claude Code in the repo and describe the song, or use the skill:

```
/compose a melancholic waltz for a rainy city at night: harp, strings that swell, a clarinet melody
```

Claude writes `songs/<slug>/prompt.md` and `plan.yaml`, derives the score, renders it (a few minutes; REAPER's
windows appear while it works), balances the mix, renders again, and tells you how to listen. Then ask for changes
in plain words: "the chorus should hit harder", "slower bridge", "give the melody to the horns", "another take".

`CLAUDE.md` is what Claude follows here; it's worth a read if you want to steer it.

## The plan

What Claude writes, and what you can write yourself:

```yaml
title: Night Bus
key: A minor
tempo: 96

ensemble:
  vln1: { instrument: bbc/vln1, group: strings }
  vla: { instrument: bbc/vla, group: strings }
  vc: { instrument: bbc/vc, group: strings }
  drums: { instrument: ezd3, setup: { kit: TightRoom } }

themes:
  hook: "5:1 1':1 3':2 | 1':2 6:2 | 6:1 4:1 6:1 1':1 | #7:2 2':2"    # scale degrees : beats

sections:
  - name: verse
    bars: 8
    chords: "i | VI | iv | V | i | VI | V | i"
    dynamics: mp<f
    parts:
      vln1: { play: melody, line: [hook, gen 4 fall end=1], octave: 5 }   # the hook, then an answer the engine writes
      vla: { play: harmony, voices: 2 }
      vc: { play: bass, rhythm: "x..x..x." }
      drums: { play: drums, groove: halftime, fill: 4 }
```

```sh
npm run compose -- songs/night-bus --render    # --seed=2 for another take of the same plan
```

Sections can change key, meter and tempo (steady or `[from, to]`). Parts play a `melody` (themes developed by
sequence, inversion, augmentation, ornament), a `counter` line against another part, voice-led `harmony`, a `bass`,
a `figure` (ostinato or arpeggio), a `double` of another part, or `drums`. The full format is in the doc comments of
[`src/theory/plan.ts`](src/theory/plan.ts) and its neighbours.

## Fine control

`overrides.yaml` reshapes any note without touching the score, like CSS over HTML, so a re-roll keeps your edits:

```yaml
- select: "vln1 @ verse m3 b1"            # one note
  set: { vel: 110, timing: -15, vibrato: { from: 0, to: 0.4, ease: in, delay: 0.3 } }
- select: "strings @ chorus"              # a group, a section
  over: span
  set: { dynamics: [[0, mp], [0.8, ff], [1, f]] }
- select: "vc [dur>=2]"
  set: { artic: trem }
```

```sh
npm run build -- songs/night-bus --render --audition="vln1 @ verse m3-4"   # just those bars, in seconds
```

## Commands

| | |
|---|---|
| `npm run doctor` | check the machine |
| `npm run compose -- songs/<id> [--seed=n] [--render]` | plan → score (→ render, balance, render) |
| `npm run build -- songs/<id> [--render] [--audition=<selector>]` | score + overrides → REAPER project (→ render) |
| `npm run balance -- songs/<id> [--render]` | measure the last render and rebalance the mix |
| `npm run levels -- songs/<id>` | each track's loudness per section, with its role |
| `npm test`, `npm run validate` | unit tests; render checks that every control reaches the sound |
| `npm run plugins`, `audit`, `ranges`, `probe`, `capture` | measure your instruments (catalog/, data/, patches/) |

## Layout

- `src/theory/`: plan → notes (harmony, voicing, melody, rhythm, drums, orchestration).
- `src/score/`: the score format, selectors and the override cascade. `src/perform.ts` turns notes into MIDI and
  automation per articulation.
- `src/reaper/`: the project writer, a private REAPER instance in `.reaper/`, and the voice JSFX.
- `src/mix/`, `src/audio/`: balance, loudness and mastering.
- `catalog/`, `data/`, `patches/`: what was measured about the instruments. `songs/`: one folder per song
  (`songs/demo` is written by hand, with no plan).

## Limits

- macOS only, and REAPER's windows show during renders.
- BBC SO Discover has no choir, guitars or synths, and ignores its own vibrato (REAPER plays vibrato after it).
  Kontakt instruments need a track template per library (`src/patches.ts`).
- Tempo changes are placed exactly in the render, but the REAPER project keeps a single tempo, so its ruler drifts
  if you open it.
- The mix is measured, not listened to: trust your ears over `balance.yaml`, and say what you hear.
