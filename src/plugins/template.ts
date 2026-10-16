/** A track template's instrument: its first track's FX chain, as REAPER saved it. */
import { readFileSync } from "node:fs";

export function templateChain(path: string): string {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim());
  const start = lines.findIndex((l) => l.startsWith("<FXCHAIN"));
  if (start < 0) throw new Error(`${path}: no FX chain in the template`);
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    if (lines[i].startsWith("<")) depth++;
    else if (lines[i] === ">") depth--;
    if (depth === 0) {
      // REAPER gives each FX a fresh id when the line is missing; a template used twice mustn't share one
      return lines.slice(start, i + 1).filter((l) => !l.startsWith("FXID ")).join("\n");
    }
  }
  throw new Error(`${path}: its FX chain never closes`);
}
