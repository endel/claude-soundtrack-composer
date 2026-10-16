# Claude Soundtrack Composer

Describe a song to Claude. Claude composes it at the level of music theory (form, keys, chords, themes, who plays
what), a seeded engine works out every note, and REAPER renders it with the virtual instruments on your own
machine. The mix is balanced by measuring the render. There's no interface to click through: you talk, it plays.

**It comes with no sounds.** It plays the instruments you have installed (VST or AU plug-ins, free or paid) through
your own copy of REAPER, so what you hear is only as good as what you own. See [Your instruments](#your-instruments).

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

- macOS (developed and tested on one Apple Silicon Mac; nothing else has been tried yet).
- [REAPER](https://www.reaper.fm) 7: paid software with a fully working 60-day evaluation. Open it once so it
  scans your plug-ins.
- Instruments you're licensed to use (see below). Out of the box, the engine knows
  [BBC Symphony Orchestra Discover](https://www.spitfireaudio.com/bbc-symphony-orchestra-discover) (free with a
  Spitfire Audio account, installed as a VST2; set `BBCSO_DIR` if it isn't in `~/Spitfire`) and, for drums,
  [EZdrummer 3](https://www.toontrack.com/product/ezdrummer-3/) (paid).
- Node 22.18 or later, `ffmpeg` (`brew install ffmpeg`) and [Claude Code](https://claude.com/claude-code).

```sh
git clone https://github.com/endel/claude-soundtrack-composer
cd claude-soundtrack-composer
npm install
npm run doctor      # checks all of the above and says what's missing
```

## Your instruments

Nothing here makes sound by itself. The engine writes notes, controller curves and plug-in settings into a REAPER
project, and REAPER plays them on the plug-ins installed on your machine. Your licences stay between you and the
vendors: nothing is downloaded, shared or bypassed, and Claude only edits text files and starts REAPER locally.

- **Known out of the box**: BBC SO Discover (the whole orchestra in `bbc/…`) and EZdrummer 3 (`ezd3`, with the kits
  you own). Their articulations, ranges, which controls really change the sound, and how loud each one plays were
  measured on one machine (`catalog/`, `data/`). If your versions differ, measure again: `npm run plugins`,
  `npm run ranges`, `npm run audit -- bbc/vln1 …`.
- **Anything else** (a Kontakt library, a synth, another sampler, free or paid) takes a one-time setup that Claude
  can walk through with you: load and configure the instrument in REAPER, save the track as a template into
  `patches/`, then probe which notes sound, audit which controls matter, and write a small patch map
  (`src/patches.ts` describes it; `scripts/capture.ts`, `probe.ts` and `audit.ts` do the measuring). Until then,
  Claude can only use what's already set up.
- **Bigger libraries sound better.** The demo uses Discover, the free tier of a far larger library: fewer
  articulations, no choir, and controls such as vibrato and microphone mixes that do nothing (REAPER plays vibrato
  after it instead).
- **Check your instruments' licences** before releasing music made with them; each vendor sets its own terms.

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

## Why REAPER

The approach needs a host that a program can drive end to end, with no one at the mouse: write a whole project,
set every plug-in's options, render it, and get each track back separately to measure. REAPER does all of it:

- **Its project file is plain text.** Tracks, MIDI, automation and each plug-in's saved state are all in the
  `.rpp`, so the engine writes the whole project directly, with no SDK and no GUI.
- **Plug-in state is editable.** Each plug-in's state is stored whole in the project. The engine sets BBC SO's
  articulation and resting controls, or EZdrummer's kit and mixer, by editing that state, instead of clicking in
  their windows.
- **It renders unattended.** REAPER runs Lua scripts and renders from the command line. Here it runs as a separate
  instance with its own settings folder (`.reaper/`), so your own REAPER setup is never touched.
- **Every track renders to its own stem**, in 32-bit float. That's what lets the mix be balanced by measurement.
- **You can write your own effects as text.** A JSFX effect compiles when REAPER loads it. The voice effect here
  (vibrato, stereo spread, tone, volume) adds controls that Discover lacks.
- **It hosts VST2, VST3 and AU**, so the plug-ins you already own work. It's also inexpensive and small, and runs
  on macOS, Windows and Linux (this tool is macOS-only so far).

The first design rendered through DawDreamer, a Python plug-in host, but was never built that way. It moved to
REAPER before any code was written: a real DAW is where large sample libraries expect to run, the result is a
project you can open and adjust by hand, and JSFX lets you add effects.

Other software that could fit this approach, as far as we know (none of these has been tried here):

| Software | Fit | Why |
|---|---|---|
| [Ardour](https://ardour.org) | good | Open source, XML sessions, scriptable in Lua (also without its window), hosts LV2, VST and AU. The closest alternative. |
| [DawDreamer](https://github.com/DBraun/DawDreamer), [Pedalboard](https://github.com/spotify/pedalboard) | good for rendering | Python libraries that load plug-ins and render offline, with no DAW at all. Heavy sample libraries can be finicky outside a DAW, and you get no project to open afterwards. |
| Ableton Live | partial | Its `.als` sets are gzipped XML and Live can be scripted (Max for Live, remote scripts), which suits working live with Claude. Exporting audio needs its window, so renders can't run unattended. |
| Bitwig Studio | partial | A JavaScript controller API can drive it live, but its projects are a closed format and we know of no way to render unattended. |
| Logic Pro, Cubase, Pro Tools, FL Studio | poor | Closed project formats, and little scripting beyond MIDI controllers. |
| A command-line host ([Plugalyzer](https://github.com/CrushedPixel/Plugalyzer)) or your own JUCE host | possible | Full control, but you'd rebuild what a DAW provides: many tracks, automation, effects. |

Moving to another host would mean replacing `src/reaper/`, `src/perform.ts` and the track-template side of
`src/patches.ts`. The composing (`src/theory/`, `src/score/`) and the mixing (`src/mix/`) work on notes and audio.

## Limits

- Early: built and tested on one Mac with one set of instruments. Expect rough edges elsewhere.
- macOS only, and REAPER's windows show during renders.
- Only the instruments that have been set up are available (see [Your instruments](#your-instruments)). Each new
  one is a setup step, not something Claude can play right away.
- Tempo changes are placed exactly in the render, but the REAPER project keeps a single tempo, so its ruler drifts
  if you open it.
- The mix is measured, not listened to: trust your ears over `balance.yaml`, and say what you hear.

## License

[MIT](LICENSE). It covers this repository; the instruments you play it with keep their own licences.
