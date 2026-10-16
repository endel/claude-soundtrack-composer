---
name: compose
description: Compose, render and mix a new song from a description ("an urgent chase cue for strings and drums"). Writes songs/<slug>/prompt.md and plan.yaml, then derives the notes, renders them in REAPER and balances the mix. Use whenever the user asks for a new song or soundtrack piece.
---

Compose the song the user described, following "Composing a song from a prompt" in CLAUDE.md:

1. Pick a short slug from the idea; save the user's words verbatim in `songs/<slug>/prompt.md`.
2. Read the format docs (the header comments of `src/theory/plan.ts`, `melody.ts`, `harmony.ts`, `rhythm.ts`,
   `drums.ts`) and `songs/black-feather/plan.yaml`, then write `songs/<slug>/plan.yaml`: key, tempo, form, chords,
   themes in scale degrees, and a role for each instrument in each section. Open it with a comment saying what the
   piece is. Original music only, even when the prompt names a piece or an artist.
3. `node scripts/compose.ts songs/<slug>`; fix errors and read the score for musical problems.
4. `node scripts/compose.ts songs/<slug> --render` in the background; when it's done, check `out/<slug>/report.json`
   and `node scripts/levels.ts songs/<slug>`.
5. Tell the user what you wrote (the form, section by section, in a few lines) and how to listen:
   `! afplay out/<slug>/<slug>.mp3`. Ask what to change.
