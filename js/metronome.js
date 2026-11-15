// Metrónomo con Web Audio (planificación anticipada para que no se atrase).

// Audio silencioso en bucle: en iPhone/iPad hace que el metrónomo suene
// aunque el interruptor de silencio esté activado.
function silentWavUrl() {
  const rate = 8000;
  const samples = rate / 2; // medio segundo
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
let SILENT_WAV = null;

export class Metronome {
  constructor() {
    this.bpm = 80;
    this.beats = 4;
    this.running = false;
    this.onBeat = null;
    this.volume = 0.8;
  }

  _ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      SILENT_WAV ||= silentWavUrl();
      this.unlock = new Audio(SILENT_WAV);
      this.unlock.loop = true;
    }
  }

  _click(time, accent) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1000;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(this.volume, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  _schedule() {
    const ahead = 0.12;
    while (this.next < this.ctx.currentTime + ahead) {
      const beat = this.beat;
      this._click(this.next, beat === 0);
      const delay = Math.max(0, (this.next - this.ctx.currentTime) * 1000);
      setTimeout(() => { if (this.running && this.onBeat) this.onBeat(beat); }, delay);
      this.next += 60 / this.bpm;
      this.beat = (this.beat + 1) % this.beats;
    }
  }

  start() {
    this._ensure();
    this.ctx.resume();
    this.unlock.play().catch(() => {});
    this.running = true;
    this.beat = 0;
    this.next = this.ctx.currentTime + 0.06;
    clearInterval(this.timer);
    this.timer = setInterval(() => this._schedule(), 25);
    this._schedule();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.unlock?.pause();
  }

  toggle() { this.running ? this.stop() : this.start(); return this.running; }

  set(bpm, time) {
    const b = Number(bpm);
    if (b >= 20 && b <= 300) this.bpm = b;
    const num = parseInt(String(time || '4/4').split('/')[0], 10);
    if (num >= 1 && num <= 16) this.beats = num;
  }
}

// Tap tempo: devuelve el BPM promedio de los últimos toques.
export function makeTapper() {
  let taps = [];
  return () => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    if (taps.length > 6) taps.shift();
    if (taps.length < 2) return null;
    const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    return Math.round(60000 / avg);
  };
}
