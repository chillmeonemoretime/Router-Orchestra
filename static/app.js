// Router Orchestra — UI: SSE stream, stats, waveform, beat visuals.

import { MusicEngine, RANGES, logLevel } from './audio.js';

const $ = (id) => document.getElementById(id);
const engine = new MusicEngine();
window.orchestra = engine; // handy for poking from devtools

const WINDOW = 60;                  // seconds shown in the waveform
const WAVE_RANGE = [0.01, 1000];    // Mbps, log scale

let status = { state: 'starting' };
let interval = 1;
let lastMetricsAt = 0;
let lastDecayAt = 0;
let history = [];                   // [{ts, down, up}]

// ---- stream --------------------------------------------------------------

function connect() {
  const es = new EventSource('/events');
  es.addEventListener('status', (e) => setStatus(JSON.parse(e.data)));
  es.addEventListener('history', (e) => {
    history = JSON.parse(e.data);
    const last = history[history.length - 1];
    if (last && Date.now() / 1000 - last.ts < interval * 3) showMetrics(last);
  });
  es.addEventListener('metrics', (e) => {
    const m = JSON.parse(e.data);
    history.push(m);
    const cutoff = Date.now() / 1000 - WINDOW - 5;
    while (history.length && history[0].ts < cutoff) history.shift();
    lastMetricsAt = performance.now();
    engine.update(m);
    showMetrics(m);
  });
  es.onerror = () => setStatus({ state: 'offline', message: 'Backend unreachable — retrying…' });
  es.onopen = () => { if (status.state === 'offline') setStatus({ state: 'connecting', message: 'Reconnected…' }); };
}

function setStatus(s) {
  status = s;
  if (s.interval) interval = s.interval;
  $('status').dataset.state = s.state;
  $('status-text').textContent = s.message || s.state;
  if (s.mode) $('source').textContent = s.mode === 'demo' ? 'Demo mode · simulated traffic' : `Source: ${s.target}`;
}

const fmtMbps = (v) => (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0));
const fmtPps = (v) => Math.round(v).toLocaleString();

function showMetrics(m) {
  $('down').textContent = fmtMbps(m.down);
  $('up').textContent = fmtMbps(m.up);
  $('rx').textContent = fmtPps(m.rx_pps);
  $('tx').textContent = fmtPps(m.tx_pps);
  $('down-meter').style.width = `${logLevel(m.down, RANGES.down) * 100}%`;
  $('up-meter').style.width = `${logLevel(m.up, RANGES.up) * 100}%`;
  $('rx-meter').style.width = `${logLevel(m.rx_pps, RANGES.rxPps) * 100}%`;
  $('tx-meter').style.width = `${logLevel(m.tx_pps, RANGES.txPps) * 100}%`;
}

// Data is fresh while the source is live and samples keep arriving. When it
// isn't, the band fades out and the targets decay towards silence.
function checkFreshness() {
  const now = performance.now();
  const live = status.state === 'connected' || status.state === 'demo';
  const fresh = live && now - lastMetricsAt < Math.max(3000, interval * 3500);
  engine.setPresent(fresh);
  document.querySelector('.stats').classList.toggle('stale', !fresh);
  if (!fresh && now - lastDecayAt > interval * 1000) {
    engine.update({});
    lastDecayAt = now;
  }
}

// ---- controls ------------------------------------------------------------

const toggle = $('toggle');
toggle.addEventListener('click', async () => {
  if (engine.running) engine.stop();
  else await engine.start();
  toggle.classList.toggle('on', engine.running);
  $('toggle-label').textContent = engine.running ? 'Stop' : 'Start';
});

const volume = $('volume');
volume.addEventListener('input', () => {
  engine.setVolume(volume.value / 100);
  $('volume-value').textContent = `${volume.value}%`;
});
engine.setVolume(volume.value / 100);

// ---- canvases ------------------------------------------------------------

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: width, h: height };
}

const css = getComputedStyle(document.documentElement);
const color = (name) => css.getPropertyValue(name).trim();
const COLORS = {
  down: color('--down'), up: color('--up'), rx: color('--rx'), tx: color('--tx'),
  grid: '#1b2030', label: color('--faint'),
};

function drawWave() {
  const { ctx, w, h } = fitCanvas($('wave'));
  ctx.clearRect(0, 0, w, h);
  const padL = 44, padB = 4, plotW = w - padL, plotH = h - padB;
  const y = (mbps) => plotH - logLevel(mbps, WAVE_RANGE) * plotH;
  const now = Date.now() / 1000;
  const x = (ts) => padL + (1 - (now - ts) / WINDOW) * plotW;

  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.label;
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (const [v, label] of [[0.1, '0.1'], [1, '1'], [10, '10'], [100, '100'], [1000, '1G']]) {
    const gy = Math.round(y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(w, gy);
    ctx.stroke();
    ctx.fillText(label, 0, Math.max(6, gy));
  }

  const pts = history.filter((p) => now - p.ts <= WINDOW + interval);
  if (pts.length < 2) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, 0, plotW, h);
  ctx.clip();

  // Download: filled area.
  const grad = ctx.createLinearGradient(0, 0, 0, plotH);
  grad.addColorStop(0, hexA(COLORS.down, 0.35));
  grad.addColorStop(1, hexA(COLORS.down, 0.02));
  ctx.beginPath();
  ctx.moveTo(x(pts[0].ts), plotH);
  for (const p of pts) ctx.lineTo(x(p.ts), y(p.down));
  ctx.lineTo(x(pts[pts.length - 1].ts), plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  strokeSeries(ctx, pts, x, (p) => y(p.down), COLORS.down);

  // Upload: line.
  strokeSeries(ctx, pts, x, (p) => y(p.up), COLORS.up);
  ctx.restore();
}

function strokeSeries(ctx, pts, x, y, c) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(x(p.ts), y(p)) : ctx.moveTo(x(p.ts), y(p))));
  ctx.strokeStyle = c;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Beat visuals, driven by the engine's scheduled note times.
const fx = { kick: 0, bass: 0, pad: 0, rings: [], sparks: [], notes: [] };
const chipTimers = {};

function onVisual(e, t) {
  if (e.type === 'kick') fx.kick = Math.max(fx.kick, e.v);
  else if (e.type === 'bass') fx.bass = Math.max(fx.bass, e.v);
  else if (e.type === 'pad') fx.pad = 1;
  else if (e.type === 'snare') fx.rings.push({ t0: t, v: e.v });
  else if (e.type === 'hat') fx.sparks.push({ t0: t, a: Math.random() * Math.PI * 2, v: e.v });
  else if (e.type === 'melody') fx.notes.push({ t0: t, note: e.note ?? 84, v: e.v });

  const chip = document.querySelector(`.chip[data-voice="${e.type}"]`);
  if (chip) {
    chip.classList.add('hit');
    clearTimeout(chipTimers[e.type]);
    chipTimers[e.type] = setTimeout(() => chip.classList.remove('hit'), e.type === 'pad' ? 400 : 110);
  }
}

function drawPulse() {
  const { ctx, w, h } = fitCanvas($('pulse'));
  const t = performance.now() / 1000;
  const cx = w / 2, cy = h * 0.4;
  const energy = engine.energy;
  ctx.clearRect(0, 0, w, h);

  // Ambient glow.
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.6);
  glow.addColorStop(0, hexA(COLORS.down, 0.05 + 0.12 * energy + 0.06 * fx.pad));
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  const breathe = engine.running ? 0 : Math.sin(t * 1.2) * 3;
  const r0 = 34 + 22 * energy + breathe;
  const r = r0 + 16 * fx.kick;

  // Snare rings.
  fx.rings = fx.rings.filter((ring) => t - ring.t0 < 0.7);
  for (const ring of fx.rings) {
    const p = (t - ring.t0) / 0.7;
    ctx.beginPath();
    ctx.arc(cx, cy, r + p * 90, 0, Math.PI * 2);
    ctx.strokeStyle = hexA(COLORS.rx, (1 - p) * 0.6 * ring.v);
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Hat sparks around the orb.
  fx.sparks = fx.sparks.filter((s) => t - s.t0 < 0.25);
  for (const s of fx.sparks) {
    const p = (t - s.t0) / 0.25;
    const d = r + 10 + p * 22;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(s.a) * d, cy + Math.sin(s.a) * d, 2, 0, Math.PI * 2);
    ctx.fillStyle = hexA(COLORS.tx, (1 - p) * s.v);
    ctx.fill();
  }

  // Melody notes rise, placed by pitch.
  fx.notes = fx.notes.filter((n) => t - n.t0 < 1.6);
  for (const n of fx.notes) {
    const p = (t - n.t0) / 1.6;
    const nx = cx + ((n.note - 76) / 12) * Math.min(160, w * 0.3);
    const ny = cy - r - 8 - p * (cy - 8);
    ctx.beginPath();
    ctx.arc(nx, ny, 3 + 2 * n.v * (1 - p), 0, Math.PI * 2);
    ctx.fillStyle = hexA(COLORS.down, (1 - p) * 0.9);
    ctx.fill();
  }

  // The orb: download teal blended towards upload pink by bass.
  const orb = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
  orb.addColorStop(0, hexA('#ffffff', 0.85));
  orb.addColorStop(0.35, hexA(COLORS.down, 0.9));
  orb.addColorStop(1, hexA(COLORS.up, 0.25 + 0.6 * fx.bass));
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = orb;
  ctx.shadowColor = hexA(COLORS.down, 0.6);
  ctx.shadowBlur = 20 + 30 * fx.kick;
  ctx.fill();
  ctx.shadowBlur = 0;

  fx.kick *= 0.88;
  fx.bass *= 0.93;
  fx.pad *= 0.97;
}

function frame() {
  for (const e of engine.drainVisuals()) onVisual(e, performance.now() / 1000);
  const bpm = engine.running ? engine.bpm : engine.targetBpm;
  $('bpm').textContent = Math.round(bpm);
  drawPulse();
  drawWave();
  requestAnimationFrame(frame);
}

connect();
setInterval(checkFreshness, 250);
requestAnimationFrame(frame);
