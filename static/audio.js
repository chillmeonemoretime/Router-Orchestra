// Router Orchestra — generative music engine (Web Audio API, no samples).
//
// Network metrics only set *targets*. A 16th-note clock reads those targets
// and decides what to play, so the result stays in time and in key no matter
// how spiky the traffic is.
//
//   Download Mbps → tempo + melody density
//   Upload Mbps   → bass intensity
//   RX PPS        → kick / snare density
//   TX PPS        → hi-hat rate
//   Idle          → ambient pad + the odd chime

const MIN_BPM = 60;
const MAX_BPM = 160;
const EMA_ALPHA = 0.3;
const GLIDE = 0.15;        // per-16th approach of playing levels to targets
const LOOKAHEAD = 0.12;    // seconds of audio scheduled ahead of the clock
const TICK_MS = 25;
const MAX_OUTPUT = 0.9;    // gain at 100 % volume (a limiter follows)

// Log-mapping ranges [floor, ceiling] → level 0..1.
export const RANGES = {
  down: [0.05, 500],   // Mbps
  up: [0.1, 100],      // Mbps
  rxPps: [20, 40000],
  txPps: [20, 20000],
};

export function logLevel(value, [lo, hi]) {
  if (!(value > lo)) return 0;
  return Math.min(1, Math.log(value / lo) / Math.log(hi / lo));
}

// vi–IV–I–V in A minor, voiced so every A-minor-pentatonic note fits on top.
const CHORDS = [
  { bass: 45, pad: [57, 60, 64, 67], tones: [9, 0, 4, 7] },   // Am7
  { bass: 41, pad: [53, 57, 60, 64], tones: [5, 9, 0, 4] },   // Fmaj7
  { bass: 48, pad: [55, 60, 62, 64], tones: [0, 4, 7, 2] },   // Cadd9
  { bass: 43, pad: [55, 57, 62, 67], tones: [7, 9, 2] },      // Gsus2
];
const MELODY_NOTES = [64, 67, 69, 72, 74, 76, 79, 81, 84, 86]; // E4..D6, A minor pentatonic
const CHIME_NOTES = [81, 84, 86, 88, 91, 93];

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function snapToChord(midi, chord) {
  for (const off of [0, -1, 1, -2, 2, -3, 3]) {
    if (chord.tones.includes((midi + off + 120) % 12)) return midi + off;
  }
  return midi;
}

export class MusicEngine {
  constructor() {
    this.ctx = null;
    this.running = false;
    this.volume = 0.3;
    this.target = { down: 0, up: 0, rxPps: 0, txPps: 0 };   // EMA of levels
    this.level = { ...this.target };                          // what's playing now
    this.bpm = MIN_BPM;
    this.step = 0;
    this.bar = 0;
    this.phrase = null;
    this.phrasePlays = 0;
    this.phraseDensity = 0;
    this.melodyIndex = 4;
    this.visuals = [];
  }

  get targetBpm() {
    return MIN_BPM + (MAX_BPM - MIN_BPM) * this.target.down;
  }

  get energy() {
    const l = this.running ? this.level : this.target;
    return (l.down + l.up + l.rxPps + l.txPps) / 4;
  }

  // Feed one sample (raw Mbps / PPS). Smoothed with an EMA on log levels.
  update({ down = 0, up = 0, rx_pps = 0, tx_pps = 0 }) {
    const raw = {
      down: logLevel(down, RANGES.down),
      up: logLevel(up, RANGES.up),
      rxPps: logLevel(rx_pps, RANGES.rxPps),
      txPps: logLevel(tx_pps, RANGES.txPps),
    };
    for (const k in raw) this.target[k] += EMA_ALPHA * (raw[k] - this.target[k]);
  }

  // Fade the whole band in (fresh data) or out (stale / disconnected).
  setPresent(on) {
    if (on === this.present) return;
    this.present = on;
    if (!this.ctx) return;
    this.presence.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, on ? 0.6 : 1.2);
  }

  setVolume(v) {
    this.volume = v;
    if (this.ctx && this.running) {
      this.out.gain.setTargetAtTime(this._volumeGain(), this.ctx.currentTime, 0.05);
    }
  }

  async start() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._build();
    }
    await this.ctx.resume();
    const now = this.ctx.currentTime;
    this.running = true;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(this._volumeGain(), now + 0.4);
    this.presence.gain.setValueAtTime(this.present ? 1 : 0, now);
    this.level = { ...this.target };
    this.bpm = this.targetBpm;
    this.step = 0;
    this.nextTime = now + 0.06;
    clearInterval(this.timer);
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  stop() {
    if (!this.ctx || !this.running) return;
    this.running = false;
    clearInterval(this.timer);
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(0, now + 0.3);
    setTimeout(() => { if (!this.running) this.ctx.suspend(); }, 400);
  }

  drainVisuals() {
    if (!this.ctx) return [];
    const now = this.ctx.currentTime;
    const due = this.visuals.filter((e) => e.time <= now);
    this.visuals = this.visuals.filter((e) => e.time > now);
    return due;
  }

  _volumeGain() {
    return Math.pow(this.volume, 1.5) * MAX_OUTPUT;
  }

  // ---- audio graph -------------------------------------------------------

  _build() {
    const ctx = this.ctx;
    this.mix = ctx.createGain();

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.25;

    this.presence = ctx.createGain();
    this.presence.gain.value = 0;
    this.out = ctx.createGain();
    this.out.gain.value = 0;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;

    this.mix.connect(comp).connect(this.presence).connect(this.out).connect(limiter).connect(ctx.destination);

    // Reverb: generated impulse response, no files needed.
    this.reverb = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = this._impulse(2.8);
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    this.reverb.connect(conv).connect(wet).connect(this.mix);

    // Tempo-synced dotted-eighth echo for the melody.
    this.echo = ctx.createGain();
    this.delay = ctx.createDelay(2);
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2400;
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.3;
    this.echo.connect(this.delay).connect(tone).connect(fb).connect(this.delay);
    tone.connect(echoOut).connect(this.mix);
    echoOut.connect(this.reverb);

    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  _impulse(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }

  // ---- clock -------------------------------------------------------------

  _tick() {
    const now = this.ctx.currentTime;
    if (this.nextTime < now - 0.25) this.nextTime = now + 0.05; // resync after a stall
    while (this.nextTime < now + LOOKAHEAD) {
      this._scheduleStep(this.step, this.nextTime);
      this.nextTime += 60 / this.bpm / 4;
      this.step = (this.step + 1) % 16;
      if (this.step === 0) this.bar++;
    }
  }

  _scheduleStep(step, t) {
    const L = this.level;
    for (const k in L) L[k] += (this.target[k] - L[k]) * GLIDE;
    this.bpm += (this.targetBpm - this.bpm) * 0.05;

    const beat = 60 / this.bpm;
    const stepDur = beat / 4;
    const chord = CHORDS[this.bar % CHORDS.length];
    // Pad: the ambient bed, one chord per bar.
    if (step === 0) {
      this.delay.delayTime.setTargetAtTime(beat * 0.75, t, 0.5);
      this._pad(t, chord, beat * 4);
      this._emit('pad', t, 0.5);
    }

    // Bass ← upload.
    const u = L.up;
    if (u > 0.06) {
      let hit, dur;
      let note = chord.bass;
      if (u < 0.35) {
        hit = step === 0 || (step === 8 && u > 0.2);
        dur = stepDur * 7;
      } else if (u < 0.65) {
        hit = step % 4 === 0 || (step === 14 && Math.random() < 0.5);
        dur = stepDur * 3;
      } else {
        hit = step % 2 === 0 || (step === 7 && Math.random() < 0.4);
        if (step % 4 === 2) note += 12;
        dur = stepDur * 1.6;
      }
      if (hit) {
        this._bass(t, note, dur, 0.4 + 0.6 * u, u);
        this._emit('bass', t, u);
      }
    }

    // Kick & snare ← RX packets/s.
    const r = L.rxPps;
    const kick = (r > 0.1 && step === 0) || (r > 0.3 && step === 8)
      || (r > 0.55 && step === 10 && this.bar % 2 === 1)
      || (r > 0.75 && (step === 3 || step === 11) && Math.random() < 0.35);
    if (kick) {
      this._kick(t, 0.55 + 0.45 * r);
      this._emit('kick', t, r);
    }
    let snare = 0;
    if (r > 0.3 && (step === 4 || step === 12)) snare = 0.5 + 0.5 * r;
    else if (r > 0.7 && step === 15 && Math.random() < 0.4) snare = 0.25;
    else if (r > 0.85 && step === 7 && Math.random() < 0.3) snare = 0.2;
    if (snare) {
      this._snare(t, snare);
      this._emit('snare', t, snare);
    }

    // Hi-hats ← TX packets/s: offbeats → 8ths → 16ths.
    const x = L.txPps;
    const hat = (x > 0.1 && step % 4 === 2) || (x > 0.35 && step % 2 === 0) || x > 0.65;
    if (hat) {
      const open = x > 0.82 && step === 14;
      const v = (step % 2 === 0 ? 0.9 : 0.45) * (0.5 + 0.5 * x) * (0.85 + 0.3 * Math.random());
      this._hat(t, v, open);
      this._emit('hat', t, v);
    }

    // Melody ← download.
    this._melodyStep(step, t, chord, stepDur);

    // Idle: occasional chime over the pad.
    if (L.down < 0.12 && L.up < 0.12 && step % 2 === 0 && Math.random() < 0.035) {
      this._chime(t, snapToChord(pick(CHIME_NOTES), chord));
      this._emit('melody', t, 0.3);
    }
  }

  _melodyStep(step, t, chord, stepDur) {
    const d = this.level.down;
    if (d < 0.08) {
      this.phrase = null;
      return;
    }
    // Two-bar phrases, each played twice, so you hear motifs instead of noise.
    const pos = (this.bar % 2) * 16 + step;
    if (pos === 0) {
      if (!this.phrase || this.phrasePlays >= 2 || Math.abs(d - this.phraseDensity) > 0.2) {
        this.phrase = this._makePhrase(d);
        this.phraseDensity = d;
        this.phrasePlays = 0;
      }
      this.phrasePlays++;
    }
    const ev = this.phrase && this.phrase[pos];
    if (!ev) return;
    let midi = MELODY_NOTES[ev.idx];
    if (step % 8 === 0) midi = snapToChord(midi, chord);
    this._melody(t, midi, ev.len * stepDur, ev.vel * (0.6 + 0.4 * d));
    this._emit('melody', t, ev.vel, midi);
  }

  _makePhrase(d) {
    const density = 0.15 + 0.75 * d;
    const weights = [1, 0.2, 0.55, 0.2];   // downbeat, e, and, a
    const phrase = new Array(32).fill(null);
    let idx = this.melodyIndex;
    for (let pos = 0; pos < 32; pos++) {
      if (pos >= 30) continue;             // breathe before the repeat
      if (Math.random() >= density * weights[pos % 4]) continue;
      idx += pick([-2, -1, -1, 0, 1, 1, 2]);
      if (idx < 1) idx += 2;
      if (idx > MELODY_NOTES.length - 2) idx -= 2;
      phrase[pos] = { idx, vel: pos % 4 === 0 ? 1 : 0.75, len: 1 };
    }
    let next = 32;
    for (let pos = 31; pos >= 0; pos--) {
      if (!phrase[pos]) continue;
      phrase[pos].len = Math.min(4, next - pos);
      next = pos;
    }
    this.melodyIndex = idx;
    return phrase;
  }

  _emit(type, time, v, note) {
    if (this.visuals.length < 256) this.visuals.push({ type, time, v, note });
  }

  // ---- voices ------------------------------------------------------------

  _voice(t, peak, attack, decay) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  _osc(type, freq, t, end, dest) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.connect(dest);
    o.start(t);
    o.stop(end);
    o.onended = () => dest.disconnect();
    return o;
  }

  _noise(t, end, dest) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.connect(dest);
    s.start(t, Math.random() * 0.5);
    s.stop(end);
    s.onended = () => dest.disconnect();
  }

  _kick(t, v) {
    const g = this._voice(t, 0.85 * v, 0.002, 0.38);
    g.connect(this.mix);
    const o = this._osc('sine', 150, t, t + 0.45, g);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  }

  _snare(t, v) {
    const g = this._voice(t, 0.32 * v, 0.001, 0.18);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;
    bp.connect(g);
    g.connect(this.mix);
    const send = this.ctx.createGain();
    send.gain.value = 0.25;
    g.connect(send).connect(this.reverb);
    this._noise(t, t + 0.25, bp);

    const body = this._voice(t, 0.22 * v, 0.001, 0.1);
    body.connect(this.mix);
    const o = this._osc('triangle', 190, t, t + 0.15, body);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.1);
  }

  _hat(t, v, open) {
    const decay = open ? 0.28 : 0.045;
    const g = this._voice(t, 0.11 * v, 0.001, decay);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = 0.25;
    hp.connect(g).connect(pan).connect(this.mix);
    this._noise(t, t + decay + 0.02, hp);
  }

  _bass(t, midi, dur, v, bright) {
    const f = mtof(midi);
    const g = this.ctx.createGain();
    const peak = 0.2 * v;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.01);
    g.gain.exponentialRampToValueAtTime(peak * 0.45, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.08);

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 4;
    lp.frequency.setValueAtTime(220 + 1500 * bright, t);
    lp.frequency.exponentialRampToValueAtTime(140 + 260 * bright, t + dur);
    lp.connect(g).connect(this.mix);

    const end = t + dur + 0.1;
    this._osc('sawtooth', f, t, end, lp);
    const subGain = this.ctx.createGain();
    subGain.gain.value = 0.8;
    subGain.connect(g);
    this._osc('sine', f, t, end, subGain);
  }

  _melody(t, midi, len, v) {
    const f = mtof(midi);
    const decay = Math.min(1.2, 0.18 + len * 1.4);
    const g = this._voice(t, 0.15 * v, 0.005, decay);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = (midi - 75) / 30;
    lp.connect(g).connect(pan).connect(this.mix);
    pan.connect(this.echo);
    const send = this.ctx.createGain();
    send.gain.value = 0.35;
    pan.connect(send).connect(this.reverb);

    const end = t + decay + 0.05;
    this._osc('triangle', f, t, end, lp);
    const overtone = this.ctx.createGain();
    overtone.gain.value = 0.25;
    overtone.connect(lp);
    this._osc('sine', f * 2, t, end, overtone);
  }

  _pad(t, chord, barDur) {
    const attack = Math.min(1.2, barDur * 0.35);
    const release = 1.6;
    const end = t + barDur + release;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700 + 900 * this.level.down;
    const peak = 0.022 + 0.03 * this.energy;  // a soft bed at idle, fuller when busy
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + barDur);
    g.gain.linearRampToValueAtTime(0, end);
    lp.connect(g).connect(this.mix);
    const send = this.ctx.createGain();
    send.gain.value = 0.7;
    g.connect(send).connect(this.reverb);

    for (const m of chord.pad) {
      const f = mtof(m);
      const a = this._osc('triangle', f, t, end, lp);
      a.detune.value = -6;
      const sawGain = this.ctx.createGain();
      sawGain.gain.value = 0.3;
      sawGain.connect(lp);
      const b = this._osc('sawtooth', f, t, end, sawGain);
      b.detune.value = 7;
    }
  }

  _chime(t, midi) {
    const g = this._voice(t, 0.06, 0.004, 2.4);
    g.connect(this.mix);
    g.connect(this.reverb);
    g.connect(this.echo);
    this._osc('sine', mtof(midi), t, t + 2.5, g);
  }
}
