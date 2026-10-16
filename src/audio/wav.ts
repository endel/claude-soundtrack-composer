/** WAV files in and out, and the levels the checks read. */
import { readFileSync, writeFileSync } from "node:fs";

export interface Stereo { l: Float32Array; r: Float32Array }

export const SR = 44100;

/** A WAV's samples (32-bit float or 16/24-bit PCM), as stereo. */
export function readWav(path: string): Stereo {
  const b = readFileSync(path);
  let fmt = 0;
  let ch = 0;
  let bits = 0;
  for (let i = 12; i + 8 <= b.length;) {
    const id = b.toString("latin1", i, i + 4);
    const n = b.readUInt32LE(i + 4);
    if (id === "fmt ") { fmt = b.readUInt16LE(i + 8); ch = b.readUInt16LE(i + 10); bits = b.readUInt16LE(i + 22); }
    if (id === "data") {
      const bytes = bits / 8;
      const frames = Math.floor(n / (bytes * ch));
      const l = new Float32Array(frames);
      const r = new Float32Array(frames);
      const at = (k: number): number => {
        const p = i + 8 + k * bytes;
        if (fmt === 3) return b.readFloatLE(p);
        return bits === 24 ? b.readIntLE(p, 3) / 8388608 : b.readInt16LE(p) / 32768;
      };
      for (let f = 0; f < frames; f++) { l[f] = at(f * ch); r[f] = at(f * ch + (ch > 1 ? 1 : 0)); }
      return { l, r };
    }
    i += 8 + n + (n & 1);
  }
  throw new Error(`${path}: no audio`);
}

/** A 32-bit float stereo WAV. */
export function writeWav(path: string, s: Stereo): void {
  const n = s.l.length;
  const b = Buffer.alloc(44 + n * 8);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + n * 8, 4);
  b.write("WAVEfmt ", 8, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(3, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 8, 28);
  b.writeUInt16LE(8, 32);
  b.writeUInt16LE(32, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) { b.writeFloatLE(s.l[i], 44 + i * 8); b.writeFloatLE(s.r[i], 48 + i * 8); }
  writeFileSync(path, b);
}

export const dB = (v: number): number => 20 * Math.log10(v + 1e-12);

/** The RMS between two times (s). */
export function rms(s: Stereo, a: number, b: number): number {
  const i0 = Math.max(0, Math.round(a * SR));
  const i1 = Math.min(s.l.length, Math.round(b * SR));
  let e = 0;
  for (let i = i0; i < i1; i++) e += s.l[i] * s.l[i] + s.r[i] * s.r[i];
  return Math.sqrt(e / Math.max(1, 2 * (i1 - i0)));
}

export function peak(s: Stereo): number {
  let p = 0;
  for (let i = 0; i < s.l.length; i++) p = Math.max(p, Math.abs(s.l[i]), Math.abs(s.r[i]));
  return p;
}
