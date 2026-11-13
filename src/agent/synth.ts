/** Tiny offline sound synthesizer for the director fallback: tones, sweeps, chimes, noise hits → 16-bit mono WAV. */
export interface SynthSpec { kind: 'tone' | 'sweep' | 'chime' | 'noise' | 'whoosh' | 'click'; durationSeconds: number; frequency?: number; endFrequency?: number; volume?: number; seed?: number }
const RATE = 44100;
export function synthesize(spec: SynthSpec): Uint8Array {
  const duration = Math.max(0.05, Math.min(10, Number(spec.durationSeconds) || 0.5));
  const f0 = Math.max(20, Math.min(12000, Number(spec.frequency) || 440)), f1 = Math.max(20, Math.min(12000, Number(spec.endFrequency) || f0 * 2));
  const volume = Math.max(0, Math.min(1, spec.volume ?? 0.6)), n = Math.floor(duration * RATE);
  let seed = (spec.seed ?? 1) >>> 0 || 1; const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1; };
  const data = new Int16Array(n); let phase = 0, low = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE, p = i / n;
    const attack = Math.min(1, t / 0.01), release = Math.min(1, (duration - t) / 0.05);
    let env = attack * release, sample = 0;
    switch (spec.kind) {
      case 'tone': sample = Math.sin(2 * Math.PI * f0 * t); break;
      case 'sweep': { const f = f0 + (f1 - f0) * p; phase += 2 * Math.PI * f / RATE; sample = Math.sin(phase); break; }
      case 'chime': env *= Math.exp(-4 * t / duration); sample = 0.6 * Math.sin(2 * Math.PI * f0 * t) + 0.3 * Math.sin(2 * Math.PI * f0 * 2.76 * t) + 0.1 * Math.sin(2 * Math.PI * f0 * 5.4 * t); break;
      case 'noise': env *= Math.exp(-6 * t / duration); sample = rand(); break;
      case 'whoosh': { low += (rand() - low) * (0.02 + 0.2 * Math.sin(Math.PI * p)); sample = low * 3; env *= Math.sin(Math.PI * p); break; }
      case 'click': env = Math.exp(-t * 400); sample = Math.sin(2 * Math.PI * 2000 * t); break;
    }
    data[i] = Math.round(Math.max(-1, Math.min(1, sample * env * volume)) * 32767);
  }
  const buffer = Buffer.alloc(44 + n * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + n * 2, 4); buffer.write('WAVE', 8); buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(RATE, 24); buffer.writeUInt32LE(RATE * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(n * 2, 40); Buffer.from(data.buffer).copy(buffer, 44);
  return new Uint8Array(buffer);
}
