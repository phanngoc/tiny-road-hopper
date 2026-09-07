/** All sound is synthesised with WebAudio oscillators - the game ships no audio
 *  files, so there is nothing to license and nothing to download. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;

  private ensure(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.32;
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain = 0.5, slideTo?: number): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + dur);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    osc.connect(g).connect(this.master);
    osc.start();
    osc.stop(ctx.currentTime + dur + 0.02);
  }

  private noise(dur: number, gain = 0.4, filterHz = 900): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const frames = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = filterHz;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(this.master);
    src.start();
  }

  coin(): void {
    this.tone(1180, 0.09, 'triangle', 0.32);
    this.tone(1760, 0.07, 'triangle', 0.18);
  }
  hop(): void {
    this.tone(420, 0.09, 'square', 0.18, 720);
  }
  bump(): void {
    this.tone(150, 0.1, 'square', 0.2, 90);
  }
  board(): void {
    this.tone(300, 0.14, 'sine', 0.22, 480);
    this.noise(0.16, 0.14, 700);
  }
  milestone(): void {
    [660, 880, 1320].forEach((f, i) => window.setTimeout(() => this.tone(f, 0.14, 'square', 0.2), i * 55));
  }
  horn(): void {
    this.tone(300, 0.5, 'sawtooth', 0.2);
    this.tone(226, 0.5, 'sawtooth', 0.16);
  }
  splash(): void {
    this.noise(0.5, 0.5, 1600);
    this.tone(520, 0.3, 'sine', 0.16, 120);
  }
  crash(): void {
    this.noise(0.55, 0.6, 420);
    this.tone(120, 0.5, 'sawtooth', 0.28, 48);
  }
}
