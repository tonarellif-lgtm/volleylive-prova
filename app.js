// VolleyLive web: ripresa (o video registrato), riconoscimento della battuta nel browser, punteggio automatico.
import { ScoreEngine, defaultConfig, AutoScorer, FIRST, SECOND, other, pointDoubts, labelPoints } from './engine.js';
import { Calibration, PersonDetector, sampleOccupancy, checkCorners } from './vision.js';
import { LiveStream, PLATFORMS, QUALITY, DEFAULT_QUALITY, checkSettings } from './livestream.js';
import { DEFAULT_RELAY, makeCode, showCode, deriveKeys, normalizeRelay, joinUrl, ReplayGuard, Link } from './remote.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mmss = (s) => {
  s = Math.max(0, Math.round(s));
  return String(Math.floor(s / 60)) + ':' + String(s % 60).padStart(2, '0');
};
const parseTime = (txt) => {
  const m = String(txt).trim().match(/^(?:(\d+):)?(\d+)(?:[.,](\d+))?$/);
  if (!m) return null;
  return (m[1] ? +m[1] * 60 : 0) + +m[2] + (m[3] ? +('0.' + m[3]) : 0);
};
const parseTimes = (txt) => String(txt || '').split(/[\n;]+/).map(parseTime).filter((x) => x !== null).sort((a, b) => a - b);

const KEY = 'vl-app-v1';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
const store = load();
function persist() {
  try {
    store.corners = S.corners; store.size = S.size; store.ratio = S.ratio; store.side = $('sideSel').value;
    store.config = S.config; store.snapshot = S.engine ? S.engine.snapshot : null;
    store.armTimes = $('armTimes').value; store.contesaTimes = $('contesaTimes').value;
    store.issued = S.issued.map((i) => ({ id: i.id, time: i.time, side: i.side, end: i.end, gap: i.gap, q: i.q && { first: i.q.first, last: i.q.last, hits: i.q.hits, conflict: i.q.conflict } }));
    store.resyncs = S.resyncs; store.confirmed = [...S.confirmed]; store.neutral = [...S.neutral]; store.reviewedAll = $('reviewedChk').checked;
    store.form = { nameA: $('nameA').value, nameB: $('nameB').value, colA: $('colA').value, colB: $('colB').value, first: $('firstSel').value, fmt: $('fmtSel').value };
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch (e) { /* memoria non disponibile */ }
}

// ---------------------------------------------------------------- stato

const S = {
  mode: null,                  // 'camera' | 'file'
  video: $('src'),
  stream: null, fileUrl: null, wake: null,
  size: null, corners: [], ratio: 0.25, cal: null, measured: false,
  config: null, engine: null, scorer: null,
  detector: null, detecting: false,
  clockStart: 0,
  live: false, analyzing: false, stopAnalyze: false,
  lastOcc: null, dirty: true, drag: -1,
  inferMs: [], samples: 0,
  rec: null, recChunks: [], recMime: '', recBlobUrl: null, recFile: null, recording: false,
  notes: [],
  resyncs: [], issued: [], issuedPtr: 0, confirmed: new Set(), neutral: new Set(), doubtCount: 0,   // etichette dei punti automatici
};
// ripresa a tutto schermo con i tasti sopra l'immagine
const L = { on: false, phase: 'cal', lent: [], logLen: 0, ro: null, toastTimer: 0 };
const cv = $('cv'), ctx = cv.getContext('2d');
const ov = $('ov'), octx = ov.getContext('2d');
// diretta verso YouTube/Facebook tramite il convertitore (livestream.js); l'interfaccia è più sotto, nella sezione «diretta»
const ST = new LiveStream({ canvas: cv, getAudioTracks: () => (S.stream ? S.stream.getAudioTracks() : []), onState: (i) => stRender(i) });

const clock = () => (S.mode === 'file' ? S.video.currentTime : (performance.now() - S.clockStart) / 1000);
const note = (m) => { S.notes.push(mmss(clock()) + ' ' + m); if (S.notes.length > 200) S.notes.shift(); };
const stat = (m) => { $('stats').textContent = m; };
const srcMsg = (m) => { $('srcMsg').textContent = m; };

// ---------------------------------------------------------------- sorgente

function showSource(w, h, label) {
  S.size = { w, h };
  cv.width = ov.width = w; cv.height = ov.height = h;
  $('secStage').hidden = false; $('secField').hidden = false; $('secMatch').hidden = false;
  $('srcChip').textContent = label + ' · ' + w + '×' + h; $('srcChip').className = 'chip ok';
  // calibrazione salvata: valida solo se il video ha le stesse dimensioni
  if (store.corners && store.corners.length && store.size && store.size.w === w && store.size.h === h) {
    S.corners = store.corners; S.ratio = store.ratio || 0.25;
    $('calInfo').textContent = 'Calibrazione ripresa dall\'ultima volta: controlla che i punti siano ancora sugli angoli.';
  } else { S.corners = []; }
  rebuildCal();
  S.dirty = true;
  $('liveRow').hidden = S.mode !== 'camera';
  if (L.on) fitStage();
  if (!S.looping) { S.looping = true; requestAnimationFrame(frame); }
}

async function startCamera() {
  await stopSource();
  const [w, h] = $('resSel').value.split('x').map(Number);
  const vc = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 }, facingMode: { ideal: 'environment' } };
  const ac = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ video: vc, audio: ac });
  } catch (e) {
    try { S.stream = await navigator.mediaDevices.getUserMedia({ video: vc, audio: false }); note('senza microfono'); }
    catch (e2) { srcMsg('Camera non disponibile: ' + e2.name + '. Controlla i permessi di Safari per questo sito.'); return; }
  }
  S.mode = 'camera';
  srcMsg('');
  S.video.srcObject = S.stream;
  try { await S.video.play(); } catch (e) { note('play() rifiutato ' + e.name); }
  if (!S.video.videoWidth) await Promise.race([new Promise((r) => { S.video.onloadedmetadata = r; }), sleep(4000)]);
  S.clockStart = performance.now();
  $('seekRow').hidden = true; $('secOffline').hidden = true; $('secRec').hidden = false;
  showSource(S.video.videoWidth || w, S.video.videoHeight || h, 'camera');
  try { if ('wakeLock' in navigator) S.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* ignorato */ }
  stat('Camera attiva.');
}

async function openFile(file) {
  await stopSource();
  S.fileUrl = URL.createObjectURL(file);
  S.mode = 'file';
  const v = S.video;
  v.srcObject = null; v.src = S.fileUrl; v.muted = true; v.playsInline = true;
  await Promise.race([new Promise((r) => { v.onloadedmetadata = r; }), sleep(8000)]);
  if (!v.videoWidth) { srcMsg('Questo video non si apre in Safari (formato non supportato).'); return; }
  try { v.currentTime = 0.1; await new Promise((r) => { v.onseeked = r; setTimeout(r, 2000); }); } catch (e) { /* ignorato */ }
  $('seekRow').hidden = false; $('secOffline').hidden = false; $('secRec').hidden = true;
  showSource(v.videoWidth, v.videoHeight, 'video ' + mmss(v.duration));
  stat(file.name + ' · ' + mmss(v.duration));
}

async function stopSource() {
  S.live = false; S.stopAnalyze = true;
  if (S.recording) stopRec();
  if (ST.active) ST.stop();
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null;
  if (S.wake) { try { S.wake.release(); } catch (e) { /* ignorato */ } S.wake = null; }
  if (S.fileUrl) { URL.revokeObjectURL(S.fileUrl); S.fileUrl = null; }
  S.video.pause(); S.video.removeAttribute('src'); S.video.srcObject = null;
  S.mode = null;
}

// ---------------------------------------------------------------- disegno

function rr(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
const FONT = '-apple-system, "Helvetica Neue", Arial, sans-serif';

function drawBoard() {
  if (!S.engine) return;
  const st = S.engine.state, cfg = S.config;
  const k = Math.max(cv.width, cv.height) / 1280;
  const x = 24 * k, y = 24 * k, w = 350 * k, hh = 32 * k, rh = 50 * k;
  ctx.save();
  ctx.fillStyle = 'rgba(8,12,18,0.85)'; rr(ctx, x, y, w, hh + 2 * rh, 10 * k); ctx.fill();
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.72)'; ctx.font = '700 ' + 15 * k + 'px ' + FONT;
  ctx.fillText('SET ' + Math.min(st.currentSet, cfg.rules.setsToWin * 2 - 1), x + 14 * k, y + hh / 2);
  const badge = st.matchPointSide ? 'MATCH POINT' : st.setPointSide ? 'SET POINT' : '';
  if (badge) { ctx.textAlign = 'right'; ctx.fillStyle = '#ffd43b'; ctx.fillText(badge, x + w - 14 * k, y + hh / 2); }
  ['a', 'b'].forEach((side, i) => {
    const ry = y + hh + i * rh;
    ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(x + 10 * k, ry, w - 20 * k, k);
    ctx.fillStyle = side === 'a' ? cfg.teamAColor : cfg.teamBColor; rr(ctx, x + 12 * k, ry + 12 * k, 8 * k, rh - 24 * k, 3 * k); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.font = '700 ' + 21 * k + 'px ' + FONT;
    ctx.fillText((side === 'a' ? cfg.teamAName : cfg.teamBName).toUpperCase(), x + 30 * k, ry + rh / 2 + k);
    if (st.serving === side && !st.isFinished) { ctx.fillStyle = '#ffd43b'; ctx.beginPath(); ctx.arc(x + w - 118 * k, ry + rh / 2, 5 * k, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = 'rgba(255,255,255,0.14)'; rr(ctx, x + w - 102 * k, ry + 8 * k, 34 * k, rh - 16 * k, 6 * k); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '700 ' + 21 * k + 'px ' + FONT;
    ctx.fillText(String(st.setsWon(side)), x + w - 85 * k, ry + rh / 2 + k);
    ctx.fillStyle = '#fff'; rr(ctx, x + w - 62 * k, ry + 6 * k, 50 * k, rh - 12 * k, 6 * k); ctx.fill();
    ctx.fillStyle = '#0b0f14'; ctx.font = '800 ' + 27 * k + 'px ' + FONT;
    ctx.fillText(String(st.points(side)), x + w - 37 * k, ry + rh / 2 + k);
  });
  ctx.restore();
}

function frame() {
  if (!S.mode) { S.looping = false; return; }
  requestAnimationFrame(frame);
  const v = S.video;
  if (v.videoWidth) ctx.drawImage(v, 0, 0, cv.width, cv.height);
  drawBoard();
  if (S.dirty || S.mode === 'file') { drawOverlay(); S.dirty = false; }
  if (S.mode === 'file' && !S.seeking) {
    const dur = v.duration || 1;
    $('seek').value = String(Math.round((v.currentTime / dur) * 1000));
    $('seekTxt').textContent = mmss(v.currentTime) + ' / ' + mmss(dur);
  }
}

function drawOverlay() {
  octx.clearRect(0, 0, ov.width, ov.height);
  const k = Math.max(ov.width, ov.height) / 1280;
  const pts = S.corners;
  const line = (a, b, col, wd) => { octx.strokeStyle = col; octx.lineWidth = wd * k; octx.beginPath(); octx.moveTo(a[0], a[1]); octx.lineTo(b[0], b[1]); octx.stroke(); };
  if (S.cal) {
    const cal = S.cal;
    // zone di battuta
    for (const [end, col] of [[FIRST, 'rgba(46,204,113,0.22)'], [SECOND, 'rgba(255,159,28,0.22)']]) {
      const z = cal.zoneRect(end);
      octx.fillStyle = col; octx.beginPath();
      [[z.x0, z.y0], [z.x1, z.y0], [z.x1, z.y1], [z.x0, z.y1]].forEach(([x, y], i) => { const [u, v] = cal.toImage(x, y); i ? octx.lineTo(u, v) : octx.moveTo(u, v); });
      octx.closePath(); octx.fill();
    }
    // linee del campo: rete, 3 metri
    const seg = (x0, y0, x1, y1, col, wd) => line(cal.toImage(x0, y0), cal.toImage(x1, y1), col, wd);
    seg(0, 9, 9, 9, 'rgba(255,255,255,0.9)', 3);
    seg(0, 6, 9, 6, 'rgba(255,255,255,0.4)', 2); seg(0, 12, 9, 12, 'rgba(255,255,255,0.4)', 2);
  }
  if (pts.length >= 2) line(pts[0], pts[1], '#2ecc71', 4);
  if (pts.length >= 4) line(pts[2], pts[3], '#ff9f1c', 4);
  if (pts.length >= 3) line(pts[1], pts[2], 'rgba(255,255,255,0.8)', 2);
  if (pts.length >= 4) line(pts[3], pts[0], 'rgba(255,255,255,0.8)', 2);
  pts.forEach((p, i) => {
    octx.fillStyle = i < 2 ? '#2ecc71' : '#ff9f1c'; octx.strokeStyle = '#000'; octx.lineWidth = 2 * k;
    octx.beginPath(); octx.arc(p[0], p[1], 9 * k, 0, Math.PI * 2); octx.fill(); octx.stroke();
    octx.fillStyle = '#000'; octx.font = '700 ' + 12 * k + 'px ' + FONT; octx.textAlign = 'center'; octx.textBaseline = 'middle';
    octx.fillText(String(i + 1), p[0], p[1] + k);
  });
  if (pts.length >= 2) {
    const m = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    octx.fillStyle = '#2ecc71'; octx.font = '800 ' + 16 * k + 'px ' + FONT; octx.textAlign = 'center';
    octx.fillText('LATO 1', m[0], m[1] + 20 * k);
  }
  if (pts.length >= 4) {
    const m = [(pts[2][0] + pts[3][0]) / 2, (pts[2][1] + pts[3][1]) / 2];
    octx.fillStyle = '#ff9f1c'; octx.font = '800 ' + 16 * k + 'px ' + FONT; octx.textAlign = 'center';
    octx.fillText('LATO 2', m[0], m[1] - 14 * k);
  }
  // cosa vede il riconoscimento
  if (S.cal && S.lastOcc && $('debugChk').checked) {
    for (const end of [FIRST, SECOND]) {
      for (const b of S.lastOcc.boxes[end]) {
        const ok = S.cal.isServer(end, b);
        octx.strokeStyle = ok ? '#2ecc71' : 'rgba(255,255,255,0.55)'; octx.lineWidth = (ok ? 3 : 1.5) * k;
        octx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
      }
    }
    const by = S.engine ? 164 * k : 24 * k;
    octx.fillStyle = 'rgba(0,0,0,0.6)'; octx.fillRect(24 * k, by, 242 * k, 30 * k);
    octx.fillStyle = '#fff'; octx.font = '700 ' + 15 * k + 'px ' + FONT; octx.textAlign = 'left'; octx.textBaseline = 'middle';
    octx.fillText('lato 1 ' + (S.lastOcc.first ? '●' : '○') + '   lato 2 ' + (S.lastOcc.second ? '●' : '○'), 32 * k, by + 15 * k);
  }
  // lente d'ingrandimento mentre si trascina un angolo
  if (S.drag >= 0 && pts[S.drag]) {
    const p = pts[S.drag], r = 70 * k, z = 3;
    // in basso a sinistra; passa a destra solo se l'angolo che si trascina sta proprio lì e verrebbe coperto
    const cy = ov.height - r - 12 * k;
    let cx = r + 12 * k;
    if (Math.abs(p[0] - cx) < r + 40 * k && Math.abs(p[1] - cy) < r + 40 * k) cx = ov.width - r - 12 * k;
    octx.save(); octx.beginPath(); octx.arc(cx, cy, r, 0, Math.PI * 2); octx.clip();
    octx.fillStyle = '#000'; octx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    octx.drawImage(cv, p[0] - r / z, p[1] - r / z, 2 * r / z, 2 * r / z, cx - r, cy - r, 2 * r, 2 * r);
    octx.restore();
    octx.strokeStyle = '#fff'; octx.lineWidth = 3 * k; octx.beginPath(); octx.arc(cx, cy, r, 0, Math.PI * 2); octx.stroke();
    octx.strokeStyle = '#ff2d55'; octx.lineWidth = 1.5 * k;
    octx.beginPath(); octx.moveTo(cx - 10 * k, cy); octx.lineTo(cx + 10 * k, cy); octx.moveTo(cx, cy - 10 * k); octx.lineTo(cx, cy + 10 * k); octx.stroke();
  }
}

// ---------------------------------------------------------------- calibrazione del campo

function rebuildCal() {
  S.cal = null;
  const pts = S.corners;
  $('calMeasure').disabled = pts.length !== 4;
  if (pts.length === 4) {
    const err = checkCorners(pts);
    if (err) { $('calInfo').textContent = err; }
    else {
      try { S.cal = new Calibration(pts, S.size, S.ratio); $('calInfo').textContent = S.measured ? 'Altezze misurate (rapporto ' + S.ratio.toFixed(3) + ').' : 'Angoli a posto. Quando ci sono le giocatrici in campo tocca «Misura le persone».'; }
      catch (e) { $('calInfo').textContent = 'Calibrazione non valida: ' + e.message; }
    }
  } else {
    $('calInfo').textContent = pts.length + ' angoli su 4.';
  }
  $('hudNext').disabled = !S.cal;
  updateHud();
  S.dirty = true;
}

function ovPoint(e) {
  const r = ov.getBoundingClientRect();
  return [(e.clientX - r.left) * ov.width / r.width, (e.clientY - r.top) * ov.height / r.height, ov.width / r.width];
}
ov.addEventListener('pointerdown', (e) => {
  if (S.lockCal) return;
  const [x, y, scale] = ovPoint(e), hit = 30 * scale;
  let best = -1, bd = hit;
  S.corners.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } });
  if (best < 0 && S.corners.length < 4) { S.corners.push([x, y]); best = S.corners.length - 1; S.measured = false; }
  if (best >= 0) { S.drag = best; ov.setPointerCapture(e.pointerId); rebuildCal(); e.preventDefault(); }
});
ov.addEventListener('pointermove', (e) => {
  if (S.drag < 0) return;
  const [x, y] = ovPoint(e);
  S.corners[S.drag] = [Math.max(0, Math.min(ov.width, x)), Math.max(0, Math.min(ov.height, y))];
  S.measured = false; rebuildCal(); e.preventDefault();
});
const endDrag = () => { if (S.drag >= 0) { S.drag = -1; S.dirty = true; persist(); } };
ov.addEventListener('pointerup', endDrag); ov.addEventListener('pointercancel', endDrag);

$('calUndo').onclick = () => { S.corners.pop(); S.measured = false; rebuildCal(); persist(); };
$('calReset').onclick = () => { S.corners = []; S.measured = false; S.ratio = 0.25; rebuildCal(); persist(); };

// ---------------------------------------------------------------- modello

async function ensureDetector() {
  if (S.detector) return S.detector;
  if (typeof ort === 'undefined') throw new Error('libreria del modello non caricata');
  const [url, size] = $('modelSel').value.split('|');
  $('modelChip').textContent = 'carico il modello…'; $('modelChip').className = 'chip q';
  ort.env.wasm.wasmPaths = new URL('./ort/', location.href).href;
  ort.env.wasm.numThreads = 1;                       // senza isolamento cross-origin il multi-thread non c'è
  ort.env.wasm.proxy = false;
  S.detector = await PersonDetector.create(ort, new URL(url, location.href).href, +size);
  $('modelChip').textContent = 'modello pronto'; $('modelChip').className = 'chip ok';
  return S.detector;
}

async function timedOccupancy() {
  const t0 = performance.now();
  const occ = await sampleOccupancy(S.detector, S.cal, S.video);
  S.inferMs.push(performance.now() - t0); if (S.inferMs.length > 50) S.inferMs.shift();
  S.samples++;
  S.lastOcc = occ; S.dirty = true;
  return occ;
}
const avgMs = () => (S.inferMs.length ? S.inferMs.reduce((a, b) => a + b, 0) / S.inferMs.length : 0);

// Misura il rapporto altezza/orizzonte dalle persone in campo
$('calMeasure').onclick = async () => {
  if (!S.cal) return;
  $('calMeasure').disabled = true;
  try {
    await ensureDetector();
    const all = [];
    const cal = S.cal, xs = cal.corners.map((p) => p[0]), ys = cal.corners.map((p) => p[1]);
    const top = Math.min(...ys), left = Math.min(...xs), right = Math.max(...xs), bottom = Math.max(...ys);
    const head = 1.2 * cal.expectedHeight((left + right) / 2, top);
    const box = { x: Math.max(0, left - 6), y: Math.max(0, top - head), w: 0, h: 0 };
    box.w = Math.min(S.size.w, right + 6) - box.x; box.h = Math.min(S.size.h, bottom + 6) - box.y;
    const nt = Math.max(1, Math.round(box.w / (box.h * 1.1))), tw = box.w / nt;
    const startT = S.mode === 'file' ? S.video.currentTime : 0;
    for (let i = 0; i < 6; i++) {
      $('calInfo').textContent = 'Misuro… ' + (i + 1) + '/6';
      if (S.mode === 'file') await seekTo(startT + i * 2);
      else if (i) await sleep(700);
      for (let j = 0; j < nt; j++) {
        const crop = { x: box.x + j * tw - (j ? tw * 0.08 : 0), y: box.y, w: tw * (j && j < nt - 1 ? 1.16 : 1.08), h: box.h };
        crop.w = Math.min(crop.w, S.size.w - crop.x);
        (await S.detector.detect(S.video, crop)).forEach((b) => all.push(b));
      }
    }
    if (S.mode === 'file') await seekTo(startT);
    const r = Calibration.measureRatio(cal, all, 10);
    if (r === null) { $('calInfo').textContent = 'Ho visto poche persone in campo (' + all.length + '). Riprova quando ci sono le giocatrici; intanto uso un valore medio.'; }
    else { S.ratio = r; S.measured = true; rebuildCal(); $('calInfo').textContent = 'Fatto: altezze misurate su ' + all.length + ' persone (rapporto ' + r.toFixed(3) + '). Ora puoi iniziare la partita.'; persist(); }
  } catch (e) { $('calInfo').textContent = 'Errore: ' + e.message; }
  $('calMeasure').disabled = S.corners.length !== 4;
};

function seekTo(t) {
  return new Promise((resolve) => {
    const v = S.video;
    t = Math.max(0, Math.min((v.duration || 1e9) - 0.05, t));
    if (Math.abs(v.currentTime - t) < 0.02) { resolve(); return; }
    let done = false;
    const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); resolve(); };
    v.addEventListener('seeked', fin); v.currentTime = t; setTimeout(fin, 4000);
  });
}

// ---------------------------------------------------------------- partita

function readConfig() {
  const sets = +$('fmtSel').value;
  return defaultConfig({
    teamAName: $('nameA').value.trim() || 'Casa', teamBName: $('nameB').value.trim() || 'Ospiti',
    teamAColor: $('colA').value, teamBColor: $('colB').value,
    firstServer: $('firstSel').value, teamAStartsOnLeft: $('sideSel').value === 'a',
    rules: { setsToWin: sets },
  });
}
function newScorer() {
  // Con un campione al secondo o più rado ogni presenza conta; con campioni più fitti si chiedono due campioni di fila
  // (scarta i riconoscimenti sbagliati di un solo fotogramma). Provato sui dati reali: mergeGap 12 s.
  const step = sampleStep();
  return new AutoScorer({ mergeGap: 12, confirmSec: step >= 1 ? 0 : 0.3, dropoutSec: Math.max(2.5, step * 1.5) });
}
function startMatch(snapshot = null) {
  if (!S.cal) { $('calInfo').textContent = 'Prima serve il campo: tocca i 4 angoli.'; return; }
  S.config = snapshot ? snapshot.config : readConfig();
  S.engine = new ScoreEngine(S.config, snapshot);
  S.scorer = newScorer();
  S.scorer.autoApply = $('autoChk').checked;
  S.issuedPtr = 0;
  if (snapshot) {
    // ripresa: gli id dei punti automatici proseguono e le etichette già raccolte restano
    S.issued = (store.issued || []).map((i) => ({ ...i, q: i.q && { ...i.q, done: true } }));
    S.confirmed = new Set(store.confirmed || []); S.neutral = new Set(store.neutral || []); S.resyncs = store.resyncs || [];
    $('reviewedChk').checked = !!store.reviewedAll;
    S.scorer.seq = Math.max(0, ...(snapshot.meta || []).map((m) => m.id || 0), ...S.issued.map((i) => i.id || 0));
  } else {
    S.issued = []; S.confirmed = new Set(); S.neutral = new Set(); S.resyncs = []; $('reviewedChk').checked = false;
  }
  $('setup').hidden = true; $('play').hidden = false; $('secReview').hidden = false;
  S.lockCal = true;
  L.logLen = 0;
  labelButtons();
  if (L.on) setPhase('play');
  refreshAll();
  persist();
  if (S.mode === 'camera') startLive();
}
$('startMatch').onclick = () => startMatch();

function labelButtons() {
  $('addA').textContent = '+1 ' + S.config.teamAName; $('addB').textContent = '+1 ' + S.config.teamBName;
  $('addA').style.background = S.config.teamAColor; $('addB').style.background = S.config.teamBColor;
  [['hudA', S.config.teamAName, S.config.teamAColor], ['hudB', S.config.teamBName, S.config.teamBColor]].forEach(([id, name, col]) => {
    const b = $(id); b.textContent = '';
    const big = document.createElement('b'); big.textContent = '+1';
    const sm = document.createElement('small'); sm.textContent = name;
    b.append(big, sm); b.style.background = col; b.setAttribute('aria-label', 'Un punto a ' + name);
  });
}
const teamName = (side) => (side === 'a' ? S.config.teamAName : S.config.teamBName);

function refreshAll() {
  if (!S.engine) return;
  const st = S.engine.state, sc = S.scorer;
  let txt;
  if (st.isFinished) txt = 'Partita finita: ' + teamName(st.winner) + ' ' + st.setsWon(st.winner) + '-' + st.setsWon(other(st.winner));
  else if (sc.mode === 'idle') txt = 'Fermo. Quando il set sta per cominciare premi «Via». Batte ' + teamName(st.serving) + '.';
  else if (sc.mode === 'awaitingFirst') txt = 'Aspetto la prima battuta di ' + teamName(st.serving) + ' (' + (AutoScorer.endOf(st.serving, st) === FIRST ? 'lato 1' : 'lato 2') + ').';
  else txt = 'Seguo la partita · set ' + st.currentSet + ' · batte ' + teamName(st.serving);
  $('autoState').textContent = txt;
  const last = sc.log.slice(-12).reverse();
  $('autoLog').innerHTML = '';
  last.forEach((e) => {
    const d = document.createElement('div');
    d.textContent = mmss(e.time ?? 0) + ' ' + e.action + (e.side ? ' ' + teamName(e.side) : '') + (e.note ? ' · ' + e.note : '');
    $('autoLog').appendChild(d);
  });
  if (document.activeElement !== $('scA') && document.activeElement !== $('scB')) { $('scA').value = st.pointsA; $('scB').value = st.pointsB; }
  const dis = (ids, v) => ids.forEach((id) => { $(id).disabled = v; });
  dis(['viaBtn', 'hudVia', 'hudScore'], st.isFinished);
  dis(['subA', 'hudSubA'], st.isFinished || st.pointsA === 0);
  dis(['subB', 'hudSubB'], st.isFinished || st.pointsB === 0);
  dis(['undoBtn', 'hudUndo'], !S.engine.canUndo);
  dis(['addA', 'addB', 'hudA', 'hudB'], st.isFinished);
  syncIssued();
  renderReview();
  updateHud();
  announce(sc);
  tcPublish();
}

// Che fine fa ogni punto automatico (invertito, tolto, lasciato): serve a misurare la precisione sulle partite vere
function syncIssued() {
  const sc = S.scorer;
  if (!sc) return;
  for (; S.issuedPtr < sc.log.length; S.issuedPtr++) {
    const e = sc.log[S.issuedPtr];
    if (e.action === 'punto') S.issued.push({ id: e.id, time: e.time, side: e.side, end: e.end, gap: e.gap, q: e.q });
    if (e.undoneId != null) S.neutral.add(e.undoneId);            // tolto dalla contesa (oggi solo nell'analisi di un video): non è un errore
  }
}
// La durata di una presenza si giudica solo a presenza finita: con la camera dopo qualche secondo, con un video a analisi finita
const doubtNow = () => (S.mode === 'camera' ? clock() : (S.analyzing ? S.video.currentTime : Infinity));
const sampleStep = () => (S.mode === 'file' ? +$('stepSel').value : 0.45);
function doubtsOf(it) {
  const next = S.issued[S.issued.indexOf(it) + 1];
  return pointDoubts(it, doubtNow(), { nextTime: next ? next.time : null, sampleStep: sampleStep() });
}
const DOUBT_TEXT = { ravvicinato: 'troppo vicino a un altro avvistamento', 'presenza breve': 'persona vista pochissimo' };
const DOUBT_SHORT = { ravvicinato: 'ravvicinato', 'presenza breve': 'visto poco' };

function afterManualChange(prevSet) {
  const st = S.engine.state;
  if (S.scorer.mode === 'awaitingFirst' && S.engine.events.length) S.scorer.mode = 'tracking';
  if (st.isFinished || st.currentSet !== prevSet) S.scorer.mode = 'idle';
  persist(); refreshAll();
}
function manualPoint(side) {
  if (!S.engine) return;
  const prev = S.engine.state.currentSet;
  if (S.engine.apply({ type: 'point', side }, { time: clock(), auto: false })) afterManualChange(prev);
}
const bind = (ids, fn) => ids.forEach((id) => { $(id).onclick = fn; });
bind(['addA', 'hudA'], () => manualPoint('a'));
bind(['addB', 'hudB'], () => manualPoint('b'));
bind(['undoBtn', 'hudUndo'], () => {
  if (!S.engine) return;
  S.engine.undo();
  const st = S.engine.state;
  if (S.scorer.mode === 'idle' && !st.isFinished && !st.isAtStartOfSet) S.scorer.mode = 'tracking';
  S.scorer.lastAutoCount = null;
  persist(); refreshAll();
});
bind(['viaBtn', 'hudVia'], () => { if (S.engine) { S.scorer.arm(S.engine, null, clock()); persist(); refreshAll(); } });
// −1: toglie l'ultimo punto di quella squadra nel set. Se era un punto automatico, nella revisione risulta «tolto».
function removePoint(side) {
  if (!S.engine) return;
  const st = S.engine.state;
  const a = st.pointsA - (side === 'a' ? 1 : 0), b = st.pointsB - (side === 'b' ? 1 : 0);
  if (a < 0 || b < 0 || st.isFinished) return;
  if (!S.engine.setScore(a, b, { time: clock(), auto: false })) return;
  S.scorer.lastAutoCount = null;
  toast('Tolto un punto a ' + teamName(side));
  persist(); refreshAll();
}
bind(['subA', 'hudSubA'], () => removePoint('a'));
bind(['subB', 'hudSubB'], () => removePoint('b'));
// Fine partita: dal telecomando la conferma si chiede sul telecomando stesso, qui sul telefono con la camera non servirebbe a nessuno
function endMatchNow() {
  if (ST.active) ST.stop();        // la diretta finisce con la partita
  if (S.recording) stopRec();      // il video si chiude e si presenta da salvare (finishRec apre «Altro» con la registrazione pronta)
  S.live = false; S.lockCal = false;
  $('setup').hidden = false; $('play').hidden = true;
  S.engine = null; S.scorer = null; S.dirty = true;
  S.issued = []; S.issuedPtr = 0; S.confirmed = new Set(); S.neutral = new Set(); S.resyncs = []; S.doubtCount = 0;
  $('reviewedChk').checked = false;
  persist();          // salva «nessuna partita»: restano campo, squadre e collegamento del telecomando
  tcPublish(true);
  if (L.on) { closeMore(); setPhase('setup'); }
}
bind(['endMatch', 'hudEnd'], () => {
  const stops = [S.recording && 'la registrazione si ferma (resta da salvare)', ST.active && 'la diretta si interrompe'].filter(Boolean);
  const msg = 'Terminare la partita? Il punteggio e la revisione dei punti vengono cancellati' + (stops.length ? ' e ' + stops.join(' e ') : '') + '.';
  if (S.engine && S.engine.events.length && !confirm(msg)) return;
  endMatchNow();
});
$('debugChk').onchange = () => { S.dirty = true; };
$('reviewedChk').onchange = () => { persist(); if (S.engine) renderReview(); };
$('autoChk').onchange = () => { if (S.scorer) S.scorer.autoApply = $('autoChk').checked; };
function applyScore(a, b) {
  if (!S.engine) return false;
  if (!(a >= 0 && b >= 0)) { $('copyMsg').textContent = 'Scrivi i due punteggi.'; return false; }
  const before = S.engine.state.pointsA + '-' + S.engine.state.pointsB, t0 = clock();
  const ok = S.engine.setScore(a, b, { time: t0, auto: false });
  if (ok && before !== a + '-' + b) S.resyncs.push({ time: t0, set: S.engine.state.currentSet, da: before, a: a + '-' + b });
  const msg = ok ? '' : 'Non posso portare il set a ' + a + '–' + b + ' (chiuderebbe il set: usa i tasti +1 o «Via»).';
  $('copyMsg').textContent = msg;
  if (!ok && L.on) toast(msg);
  S.scorer.lastAutoCount = null;
  persist(); refreshAll();
  return ok;
}
$('setScoreBtn').onclick = () => applyScore(parseInt($('scA').value, 10), parseInt($('scB').value, 10));
// Risincronizzazione veloce dallo schermo della camera: si scrive il punteggio letto sul tabellone dell'arbitro
$('hudScore').onclick = () => {
  if (!S.engine) return;
  const st = S.engine.state;
  const r = prompt('Punteggio del set, come sul tabellone (' + teamName('a') + ' – ' + teamName('b') + '), es. 12-9', st.pointsA + '-' + st.pointsB);
  if (r === null) return;
  const m = r.match(/(\d+)\D+(\d+)/);
  if (!m) { toast('Scrivi due numeri, per esempio 12-9'); return; }
  applyScore(parseInt(m[1], 10), parseInt(m[2], 10));
};

// ---------------------------------------------------------------- riconoscimento dal vivo

async function startLive() {
  if (S.live || S.mode !== 'camera') return;
  try { await ensureDetector(); } catch (e) { stat('Modello non caricato: ' + e.message); return; }
  S.live = true;
  let lastUi = 0;
  while (S.live && S.mode === 'camera' && S.engine) {
    const t0 = performance.now();
    if (document.visibilityState === 'visible' && S.video.videoWidth) {
      try {
        const occ = await timedOccupancy();
        const dec = S.scorer.observe(clock(), occ, S.engine);
        if (dec.length) { persist(); refreshAll(); }
        else if (performance.now() - lastUi > 2000) { refreshAll(); lastUi = performance.now(); }
        stat('riconoscimento: ' + Math.round(avgMs()) + ' ms per campione · ' + S.samples + ' campioni');
      } catch (e) { stat('Errore del riconoscimento: ' + e.message); await sleep(1000); }
    }
    await sleep(Math.max(100, 450 - (performance.now() - t0)));
  }
}

// ---------------------------------------------------------------- analisi di un video registrato

$('seek').addEventListener('input', () => { S.seeking = true; S.video.currentTime = ($('seek').value / 1000) * (S.video.duration || 0); });
$('seek').addEventListener('change', () => { S.seeking = false; });
$('playBtn').onclick = () => { if (S.video.paused) { S.video.play(); $('playBtn').textContent = '❚❚ Pausa'; } else { S.video.pause(); $('playBtn').textContent = '▶︎ Riproduci'; } };

$('analyzeBtn').onclick = async () => {
  if (S.mode !== 'file' || !S.cal) { $('anaTxt').textContent = 'Servono il video e il campo calibrato.'; return; }
  if (S.engine && S.engine.events.length && !confirm('Questo azzera il punteggio attuale e rifà l\'analisi. Continuare?')) return;
  const arms = parseTimes($('armTimes').value), contese = parseTimes($('contesaTimes').value);
  if (!arms.length) { $('anaTxt').textContent = 'Scrivi almeno l\'inizio del primo set.'; return; }
  try { await ensureDetector(); } catch (e) { $('anaTxt').textContent = 'Modello non caricato: ' + e.message; return; }
  S.video.pause();
  startMatch();
  S.live = false;
  const step = +$('stepSel').value, dur = S.video.duration;
  const startT = Math.max(0, arms[0] - 12);
  S.analyzing = true; S.stopAnalyze = false;
  $('analyzeBtn').disabled = true; $('stopAnalyze').disabled = false;
  const t00 = performance.now();
  let ai = 0, ci = 0, n = 0;
  for (let t = startT; t < dur && !S.stopAnalyze; t += step) {
    await seekTo(t);
    while (ai < arms.length && arms[ai] <= t) { S.scorer.arm(S.engine, ai === 0 ? S.config.firstServer : null, arms[ai]); ai++; }
    while (ci < contese.length && contese[ci] <= t) { S.scorer.contesa(S.engine, contese[ci]); ci++; }
    const occ = await timedOccupancy();
    S.scorer.observe(t, occ, S.engine);
    n++;
    if (n % 4 === 0) {
      $('anaBar').style.width = (100 * t / dur).toFixed(1) + '%';
      const st = S.engine.state;
      $('anaTxt').textContent = mmss(t) + ' / ' + mmss(dur) + ' · set ' + st.currentSet + ' · ' + st.pointsA + '–' + st.pointsB + ' · set vinti ' + st.setsWonA + '–' + st.setsWonB + ' · ' + Math.round(avgMs()) + ' ms/campione';
      refreshAll(); await sleep(0);
    }
  }
  S.analyzing = false; $('analyzeBtn').disabled = false; $('stopAnalyze').disabled = true;
  $('anaBar').style.width = '100%';
  const st = S.engine.state;
  $('anaTxt').textContent = 'Fatto in ' + mmss((performance.now() - t00) / 1000) + ': set ' + st.completedSets.map((s) => s.pointsA + '–' + s.pointsB).join(', ') + (st.isFinished ? ' · vince ' + teamName(st.winner) : ' · set in corso ' + st.pointsA + '–' + st.pointsB);
  persist(); refreshAll();
};
$('stopAnalyze').onclick = () => { S.stopAnalyze = true; };

// ---------------------------------------------------------------- registrazione

const REC_TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
function startRec() {
  if (S.mode !== 'camera' || typeof MediaRecorder === 'undefined') { $('recStats').textContent = 'Registrazione non disponibile.'; return; }
  const out = cv.captureStream(30);
  S.stream.getAudioTracks().forEach((t) => out.addTrack(t));
  S.recMime = REC_TYPES.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  const opts = { videoBitsPerSecond: cv.width >= 1600 ? 8000000 : 6000000, audioBitsPerSecond: 128000 };
  if (S.recMime) opts.mimeType = S.recMime;
  try { S.rec = new MediaRecorder(out, opts); } catch (e) { try { S.rec = new MediaRecorder(out); } catch (e2) { $('recStats').textContent = 'Errore: ' + e2.name; return; } }
  S.recMime = S.rec.mimeType || S.recMime;
  S.recChunks = [];
  S.rec.ondataavailable = (e) => { if (e.data && e.data.size) S.recChunks.push(e.data); };
  S.rec.onstop = finishRec;
  S.rec.start(1000);
  // gli orari dei punti si misurano dall'inizio del file: se ci sono già punti li si sposta
  const shift = (performance.now() - S.clockStart) / 1000;
  if (S.engine) S.engine.meta.forEach((m) => { if (m.time !== null) m.time = Math.max(0, m.time - shift); });
  S.issued.forEach((i) => { i.time = Math.max(0, i.time - shift); if (i.q) { i.q.first = Math.max(0, i.q.first - shift); i.q.last = Math.max(0, i.q.last - shift); } });
  S.clockStart = performance.now();
  S.recording = true; S.recStart = performance.now();
  $('recBtn').textContent = 'Ferma la registrazione';
  $('recResult').hidden = true;
  const tick = () => { const t = mmss((performance.now() - S.recStart) / 1000); $('recStats').textContent = '● ' + t; $('hudRec').textContent = '■ ' + t; };
  tick(); $('hudRec').classList.add('on');
  S.recTimer = setInterval(tick, 1000);
}
function stopRec() {
  if (S.rec && S.rec.state !== 'inactive') S.rec.stop();
  clearInterval(S.recTimer); S.recording = false;
  $('recBtn').textContent = 'Registra'; $('hudRec').textContent = '● REC'; $('hudRec').classList.remove('on');
}
function finishRec() {
  const type = (S.recMime || 'video/mp4').split(';')[0];
  const blob = new Blob(S.recChunks, { type }), ext = type.includes('mp4') ? 'mp4' : 'webm';
  const d = new Date(), name = 'partita-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + '.' + ext;
  if (S.recBlobUrl) URL.revokeObjectURL(S.recBlobUrl);
  S.recBlobUrl = URL.createObjectURL(blob); S.recFile = new File([blob], name, { type });
  $('recPlay').src = S.recBlobUrl; $('dlLink').href = S.recBlobUrl; $('dlLink').download = name;
  $('recResult').hidden = false;
  $('recStats').textContent = name + ' · ' + (blob.size / 1048576).toFixed(1) + ' MB';
  renderReview();
  if (L.on) { openMore(); toast('Registrazione pronta: salvala da qui'); }
}
bind(['recBtn', 'hudRec'], () => (S.recording ? stopRec() : startRec()));
$('shareBtn').onclick = async () => {
  if (!S.recFile) return;
  try {
    if (navigator.canShare && navigator.canShare({ files: [S.recFile] })) await navigator.share({ files: [S.recFile], title: 'Partita' });
    else $('recStats').textContent += ' · «Condividi» non disponibile, usa «Scarica»';
  } catch (e) { /* annullato */ }
};

// ---------------------------------------------------------------- revisione

function renderReview() {
  const body = $('revTable').querySelector('tbody');
  body.textContent = '';
  if (!S.engine) return;
  const tl = S.engine.timeline();
  const hasVideo = S.mode === 'file' || !!S.recBlobUrl;
  const issuedById = new Map(S.issued.map((i) => [i.id, i]));
  S.doubtCount = 0;
  tl.forEach((r) => {
    const e = r.event, tr = document.createElement('tr');
    let doubtIt = null;
    if (r.setEnded) tr.className = 'setend';
    const td = (txt, cls) => { const c = document.createElement('td'); if (cls) c.className = cls; c.textContent = txt; tr.appendChild(c); return c; };
    td(String(r.index + 1), 'num');
    td(r.meta.time === null ? '–' : mmss(r.meta.time), 'num');
    td(String(r.set));
    if (e.type === 'point') {
      const c = td(''); const s = document.createElement('span'); s.className = e.side === 'a' ? 'tA' : 'tB'; s.textContent = teamName(e.side) + (r.meta.auto ? ' ·auto' : ''); c.appendChild(s);
      const it = r.meta.id != null ? issuedById.get(r.meta.id) : null;
      if (it && S.confirmed.has(it.id)) { c.append(' ✓'); }
      else if (it) {
        const why = doubtsOf(it);
        if (why.length) {
          S.doubtCount++; tr.classList.add('doubt'); doubtIt = it;
          const w = document.createElement('small'); w.className = 'why'; w.textContent = ' ⚠ ' + why.map((x) => DOUBT_SHORT[x]).join(', '); w.title = why.map((x) => DOUBT_TEXT[x]).join('; '); c.appendChild(w);
        }
      }
      td(r.a + '–' + r.b, 'num');
    } else {
      td({ timeout: 'time-out', substitution: 'sostituzione', setServing: 'chi batte', swapSides: 'cambio campo' }[e.type] + (e.side ? ' ' + teamName(e.side) : ''));
      td('');
    }
    const act = document.createElement('td');
    const mk = (label, title, fn, dis) => { const b = document.createElement('button'); b.className = 'small'; b.textContent = label; b.title = title; b.disabled = !!dis; b.onclick = fn; act.appendChild(b); };
    mk('▶︎', 'rivedi', () => previewAt(r.meta.time), !hasVideo || r.meta.time === null);
    if (doubtIt) mk('✓', 'il punto è giusto: togli il dubbio', () => { S.confirmed.add(doubtIt.id); persist(); refreshAll(); });
    if (e.type === 'point') mk('⇄', 'dai il punto all\'altra squadra', () => correct(S.engine.flipPoint(r.index)));
    mk('✕', 'togli', () => correct(S.engine.removeEvent(r.index)));
    tr.appendChild(act);
    body.appendChild(tr);
  });
  const { labels, summary } = labelPoints(S.issued, tl, [...S.neutral]);
  const conf = labels.filter((l) => l.state === 'non toccato' && S.confirmed.has(l.id)).length;
  $('accStats').textContent = summary.auto
    ? 'Punti automatici ' + summary.auto + ': ' + summary.nonToccati + ' lasciati (' + conf + ' confermati con ✓), ' + summary.invertiti + ' invertiti, ' + summary.tolti + ' tolti'
      + (summary.contesa ? ', ' + summary.contesa + ' tolti con la contesa' : '') + ' · ' + summary.manuali + ' punti dati a mano' + (S.resyncs.length ? ' · ' + S.resyncs.length + ' risincronizzazioni (le etichette dopo sono meno sicure)' : '')
    : '';
  const rep = {
    versione: 2, quando: new Date().toISOString(), dispositivo: navigator.userAgent, sorgente: S.mode, video: S.size,
    calibrazione: { angoli: S.corners, rapporto: S.ratio, misurato: S.measured, latoUno: $('sideSel').value },
    partita: S.engine.snapshot, registroAuto: S.scorer ? S.scorer.log : [],
    etichette: labels.map((l) => ({ id: l.id, orario: l.time, squadra: l.side, lato: l.end, set: l.set, stato: l.state, confermato: S.confirmed.has(l.id), distanzaSec: l.gap, presenza: l.q && { dal: l.q.first, al: l.q.last, campioni: l.q.hits, due_lati: l.q.conflict }, dubbi: l.state === 'tolto' || l.state === 'contesa' ? [] : doubtsOf(S.issued.find((x) => x.id === l.id)) })),
    risincronizzazioni: S.resyncs, riepilogo: summary, revisioneCompleta: $('reviewedChk').checked, campioni: S.samples, msPerCampione: Math.round(avgMs()), note: S.notes.slice(-60),
  };
  $('report').value = JSON.stringify(rep);
}
function correct(ok) {
  if (!ok) { $('copyMsg').textContent = 'Questa correzione renderebbe incoerenti i punti successivi: non fatta.'; return; }
  $('copyMsg').textContent = '';
  S.scorer.lastAutoCount = null;
  const st = S.engine.state;
  if (st.isFinished) S.scorer.mode = 'idle';
  persist(); refreshAll();
}
async function previewAt(t) {
  if (S.mode === 'file') { await seekTo(Math.max(0, t - 8)); S.video.play(); $('playBtn').textContent = '❚❚ Pausa'; window.scrollTo({ top: 0, behavior: 'smooth' }); }
  else if (S.recBlobUrl) { const v = $('recPlay'); v.currentTime = Math.max(0, t - 8); v.play(); $('recResult').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}
$('copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText($('report').value); $('copyMsg').textContent = 'Copiato.'; }
  catch (e) { $('report').select(); $('copyMsg').textContent = 'Seleziona e copia a mano.'; }
};


// ---------------------------------------------------------------- tutto schermo coi tasti sopra l'immagine

// Gli stessi elementi della pagina (riquadro, campo, impostazioni) vengono «prestati» al tutto schermo e poi restituiti:
// così c'è un solo insieme di campi e di funzioni, non due copie da tenere allineate.
function lend(id, hostId) {
  const el = $(id), mark = document.createComment('prestito ' + id);
  el.parentNode.insertBefore(mark, el);
  L.lent.push([el, mark]);
  $(hostId).appendChild(el);
}
function giveBack() {
  while (L.lent.length) { const [el, mark] = L.lent.pop(); mark.parentNode.insertBefore(el, mark); mark.remove(); }
}

const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const FS_OK = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
function requestFs() {
  const el = document.documentElement, fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (fn && !fsEl()) { try { const p = fn.call(el); if (p && p.catch) p.catch(() => {}); } catch (e) { /* non disponibile */ } }
  try { const o = screen.orientation; if (o && o.lock) o.lock('landscape').catch(() => {}); } catch (e) { /* solo Android, a schermo intero */ }
}
function leaveFs() {
  try { if (fsEl()) { const f = document.exitFullscreen || document.webkitExitFullscreen, p = f.call(document); if (p && p.catch) p.catch(() => {}); } } catch (e) { /* ignorato */ }
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* ignorato */ }
}

// Il riquadro del video occupa il più possibile dello schermo senza deformarsi; il resto resta nero
function fitStage() {
  if (!L.on) return;
  const host = $('liveStageHost'), W = host.clientWidth, H = host.clientHeight;
  if (!W || !H) return;
  const ar = cv.width / cv.height;
  let w = W, h = W / ar;
  if (h > H) { h = H; w = H * ar; }
  const st = $('stage'); st.style.width = Math.floor(w) + 'px'; st.style.height = Math.floor(h) + 'px';
  // il tabellone è disegnato nell'immagine (in alto a sinistra, 374/1280 della larghezza): i testi in alto non devono finirci sopra
  const r = st.getBoundingClientRect();
  $('live').style.setProperty('--sb-right', Math.round(r.left + r.width * 374 / 1280 + 8) + 'px');
  S.dirty = true;
}

const CAL_HINT = [
  'Tocca l\'angolo 1: un estremo della linea di fondo del «lato 1»',
  'Angolo 2: l\'altro estremo della stessa linea di fondo',
  'Angolo 3: sul fondo opposto, dalla parte dell\'angolo 2',
  'Angolo 4: l\'ultimo, ancora sul fondo opposto',
  'Trascina i punti per sistemarli, poi «Misura le persone» e «Avanti»',
];
function playStatus() { return playStatusText() + (TC.remotes ? ' · 📡 ' + TC.remotes : ''); }
function playStatusText() {
  const st = S.engine.state, sc = S.scorer;
  if (st.isFinished) return 'Partita finita · ' + teamName(st.winner) + ' ' + st.setsWon(st.winner) + '–' + st.setsWon(other(st.winner));
  if (sc.mode === 'idle') return 'Premi «Via» a inizio set · batte ' + teamName(st.serving);
  if (sc.mode === 'awaitingFirst') return 'Aspetto la prima battuta di ' + teamName(st.serving);
  return 'Set ' + st.currentSet + ' · batte ' + teamName(st.serving) + (sc.autoApply ? '' : ' · punti automatici spenti') + (S.doubtCount ? ' · ⚠ ' + S.doubtCount + ' da controllare' : '');
}
function updateHud() {
  if (!L.on) return;
  let t;
  if (!S.mode) t = 'Avvio la camera…';
  else if (L.phase === 'cal') t = CAL_HINT[Math.min(4, S.corners.length)];
  else if (L.phase === 'setup') t = 'Imposta la partita';
  else t = S.engine ? playStatus() : '—';
  $('hudStatus').textContent = t;
}

function toast(msg) {
  if (tcLive()) TC.link.send({ k: 'toast', text: msg });
  if (!L.on) return;
  const el = $('hudToast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(L.toastTimer); L.toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
// Un avviso sull'immagine per ciò che il riconoscimento ha deciso da solo
function announce(sc) {
  const n = sc.log.length;
  if (L.on || tcLive()) {
    const st = S.engine.state;
    for (let i = L.logLen; i < n; i++) {
      const e = sc.log[i];
      if (e.action === 'punto') {
        const d = pointDoubts({ time: e.time, gap: e.gap, q: null });
        toast('Punto automatico: ' + teamName(e.side) + ' · ' + st.pointsA + '–' + st.pointsB + (d.length ? ' · ⚠ da controllare' : ''));
      }
      else if (e.action === 'prima-battuta') toast('Prima battuta vista: si parte');
      else if (e.action === 'contesa') toast(e.side ? 'Contesa: punto tolto' : 'Contesa: la prossima battuta non vale');
      else if (e.action === 'ignorata') toast('Battuta ignorata (lato sbagliato)');
      else if (e.action === 'via') toast('Via: aspetto la prima battuta');
    }
  }
  L.logLen = n;
}

function setPhase(p) {
  L.phase = p;
  $('live').dataset.phase = p;
  $('hudCal').hidden = p !== 'cal';
  $('hudCalText').hidden = p !== 'cal';
  $('hudAct').hidden = p !== 'play';
  $('hudSideA').hidden = $('hudSideB').hidden = p !== 'play';
  $('sheetSetup').hidden = p !== 'setup';
  $('playMore').hidden = p !== 'play';
  updateHud();
}
const openMore = () => { $('sheetMore').hidden = false; };
const closeMore = () => { $('sheetMore').hidden = true; };

// Su iPhone la barra di Safari si toglie solo aprendo la pagina dall'icona nella schermata Home
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
document.querySelectorAll('[data-a2hs]').forEach((el) => { el.hidden = !(isIos && !isStandalone && !FS_OK); });

function enterLive() {
  if (L.on) return;
  L.on = true;
  document.body.classList.add('live');
  $('live').hidden = false;
  document.querySelector('main').inert = true;
  lend('stage', 'liveStageHost');
  lend('calInfo', 'hudCalText');
  ['calUndo', 'calReset', 'calMeasure'].forEach((id) => lend(id, 'hudCalBtns'));
  lend('sideRow', 'sheetSetupBody'); lend('setup', 'sheetSetupBody');
  lend('playMore', 'morePlay');
  lend('tcBox', 'morePlay');
  lend('stBox', 'morePlay');
  lend('recStats', 'moreRec'); lend('recResult', 'moreRec');
  lend('stats', 'moreStats');
  $('hudFs').hidden = !FS_OK;
  requestFs();
  if (!L.ro && typeof ResizeObserver !== 'undefined') { L.ro = new ResizeObserver(fitStage); L.ro.observe($('liveStageHost')); }
  setPhase(S.engine ? 'play' : 'cal');
  fitStage();
  if (S.engine) refreshAll();
}
function exitLive() {
  if (!L.on) return;
  L.on = false;
  closeMore();
  giveBack();
  $('playMore').hidden = false;
  $('stage').style.width = $('stage').style.height = '';
  document.body.classList.remove('live');
  document.querySelector('main').inert = false;
  $('live').hidden = true;
  leaveFs();
  S.dirty = true;
}

$('hudExit').onclick = exitLive;
$('liveBtn').onclick = enterLive;
$('hudNext').onclick = () => { if (S.cal) setPhase('setup'); };
$('hudBack').onclick = () => setPhase('cal');
$('hudMore').onclick = () => ($('sheetMore').hidden ? openMore() : closeMore());
$('hudMoreClose').onclick = closeMore;
$('sheetMore').addEventListener('click', (e) => { if (e.target === $('sheetMore')) closeMore(); });
$('hudReview').onclick = () => { exitLive(); if (S.engine) $('secReview').scrollIntoView({ block: 'start' }); };
$('hudFs').onclick = () => (fsEl() ? leaveFs() : requestFs());
['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => document.addEventListener(ev, () => { $('hudFs').textContent = fsEl() ? '⤡' : '⛶'; fitStage(); }));
window.addEventListener('resize', fitStage);
window.addEventListener('orientationchange', () => setTimeout(fitStage, 250));

// ---------------------------------------------------------------- avvio

// La camera si apre subito a tutto schermo: la richiesta parte dentro il tocco dell'utente, altrimenti il browser la rifiuta
$('camBtn').onclick = async () => {
  srcMsg('');
  enterLive();
  await startCamera();
  if (S.mode !== 'camera') exitLive();
};
$('fileBtn').onclick = () => $('fileIn').click();
$('fileIn').onchange = () => { const f = $('fileIn').files[0]; if (f) openFile(f); };
document.addEventListener('visibilitychange', () => { note('pagina ' + document.visibilityState); if (document.visibilityState === 'visible' && S.mode === 'camera' && !S.wake && 'wakeLock' in navigator) navigator.wakeLock.request('screen').then((w) => { S.wake = w; }).catch(() => {}); });

(function restore() {
  const f = store.form;
  if (f) { $('nameA').value = f.nameA; $('nameB').value = f.nameB; $('colA').value = f.colA; $('colB').value = f.colB; $('firstSel').value = f.first; $('fmtSel').value = f.fmt; }
  if (store.side) $('sideSel').value = store.side;
  if (store.armTimes) $('armTimes').value = store.armTimes;
  if (store.contesaTimes) $('contesaTimes').value = store.contesaTimes;
  if (store.snapshot && store.snapshot.events && store.snapshot.events.length) {
    $('srcChip').textContent = 'partita salvata: riapri la sorgente per continuare';
  }
})();
// ---------------------------------------------------------------- telecomando (altro telefono)
// Questo telefono tiene il punteggio vero. Il telecomando (telecomando.html) manda comandi e riceve lo stato; tutto passa dal
// relay, cifrato con una chiave ricavata dal codice. I comandi usano gli stessi gestori dei tasti, quindi valgono le stesse regole.

const TC = { link: null, code: null, relay: '', on: false, connected: false, remotes: 0, guard: new ReplayGuard(), lastJson: '', lastAt: 0, beat: null };
const tcLive = () => !!(TC.link && TC.connected && TC.remotes > 0);
const tcMsg = (t) => { $('tcMsg').textContent = t || ''; };

function tcState() {
  if (!S.engine) return { k: 'state', ts: Date.now(), started: false };
  const st = S.engine.state, sc = S.scorer;
  const byId = new Map(S.issued.map((i) => [i.id, i]));
  const recent = S.engine.timeline().filter((r) => r.event.type === 'point').slice(-4).map((r) => {
    const it = r.meta.id != null ? byId.get(r.meta.id) : null;
    return { side: r.event.side, a: r.a, b: r.b, set: r.set, auto: !!r.meta.auto, doubt: !!(it && !S.confirmed.has(it.id) && doubtsOf(it).length), t: r.meta.time };
  });
  return {
    k: 'state', ts: Date.now(), started: true,
    a: { name: S.config.teamAName, color: $('colA').value }, b: { name: S.config.teamBName, color: $('colB').value },
    set: st.currentSet, pa: st.pointsA, pb: st.pointsB, sa: st.setsWonA, sb: st.setsWonB, serving: st.serving,
    mode: sc.mode, auto: sc.autoApply, finished: st.isFinished, winner: st.isFinished ? st.winner : null,
    canUndo: S.engine.canUndo, doubts: S.doubtCount, status: playStatus() + streamTag(), recent,
  };
}
// Manda lo stato se è cambiato, e comunque ogni 5 s (il telecomando capisce così che questo telefono è vivo)
function tcPublish(force = false) {
  if (!TC.link || !TC.connected) return;
  const s = tcState(), j = JSON.stringify({ ...s, ts: 0 }), now = Date.now();
  if (!force && j === TC.lastJson && now - TC.lastAt < 5000) return;
  TC.lastJson = j; TC.lastAt = now;
  TC.link.send(s, true);
}
const TC_BTN = { addA: 'hudA', addB: 'hudB', subA: 'hudSubA', subB: 'hudSubB', undo: 'hudUndo', via: 'hudVia' };
function tcCommand(m) {
  if (!m || m.k !== 'cmd' || !TC.guard.accept(m.sid, m.seq)) return;
  let ok = true, msg = '';
  if (!S.engine) { ok = false; msg = 'La partita non è ancora cominciata'; }
  else if (TC_BTN[m.c]) { const b = $(TC_BTN[m.c]); if (b.disabled) { ok = false; msg = 'Non disponibile ora'; } else b.click(); }
  else if (m.c === 'score') {
    const a = m.a, b = m.b;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 60 || b > 60) { ok = false; msg = 'Punteggio non valido'; }
    else { ok = applyScore(a, b); msg = ok ? '' : $('copyMsg').textContent; }
  } else if (m.c === 'end') { endMatchNow(); toast('Partita terminata dal telecomando');
  } else if (m.c === 'auto') { $('autoChk').checked = !!m.on; $('autoChk').onchange(); persist(); refreshAll(); }
  else { ok = false; msg = 'Comando sconosciuto'; }
  TC.link.send({ k: 'ack', sid: m.sid, seq: m.seq, ok, msg });
}
function tcStatus(s) {
  TC.connected = s.connected; TC.remotes = Math.max(0, s.peers - 1);
  tcRender(); updateHud();
}
function tcRender() {
  $('tcToggle').textContent = TC.on ? 'Scollega il telecomando' : 'Collega un telecomando';
  $('tcOn').hidden = !TC.on;
  $('tcRelay').disabled = TC.on;
  if (!TC.on) return;
  $('tcState').textContent = !TC.connected ? 'Mi collego al servizio…' : TC.remotes ? '📡 ' + TC.remotes + (TC.remotes === 1 ? ' telecomando collegato' : ' telecomandi collegati') : 'Collegato al servizio, aspetto il telecomando.';
  $('tcLinkTxt').value = joinUrl(location.href, TC.code, TC.relay);
  $('tcCode').textContent = showCode(TC.code);
}
async function tcOpen() {
  const relay = normalizeRelay($('tcRelay').value || (store.tc && store.tc.relay) || DEFAULT_RELAY);
  if (!relay) { tcMsg('Scrivi l\'indirizzo del servizio, per esempio wss://volleylive-relay.nome.workers.dev'); return false; }
  if (location.protocol === 'https:' && relay.startsWith('ws:') && !/^ws:\/\/(localhost|127\.0\.0\.1)/.test(relay)) { tcMsg('Da una pagina https serve un indirizzo che comincia con wss://'); return false; }
  tcMsg('');
  const code = (store.tc && store.tc.code) || makeCode();
  const { key, room } = await deriveKeys(code);
  if (TC.link) TC.link.close();
  TC.code = code; TC.relay = relay; TC.on = true; TC.remotes = 0; TC.connected = false; TC.lastJson = '';
  $('tcRelay').value = relay;
  TC.link = new Link({ relay, room, key, onMessage: tcCommand, onStatus: tcStatus, onOpen: () => tcPublish(true) });
  TC.link.open();
  clearInterval(TC.beat); TC.beat = setInterval(() => tcPublish(), 5000);
  store.tc = { code, relay, on: true }; persist();
  tcRender();
  return true;
}
function tcClose(keepCode = true) {
  if (TC.link) TC.link.close();
  TC.link = null; TC.on = false; TC.connected = false; TC.remotes = 0; clearInterval(TC.beat);
  store.tc = { code: keepCode && store.tc ? store.tc.code : undefined, relay: TC.relay || (store.tc && store.tc.relay), on: false }; persist();
  tcRender(); updateHud();
}
$('tcToggle').onclick = async () => { if (TC.on) tcClose(); else await tcOpen(); };
$('tcNew').onclick = async () => { if (!confirm('Il codice cambia: i telecomandi già collegati smettono di funzionare finché non apri il nuovo link. Continuare?')) return; tcClose(false); await tcOpen(); };
$('tcCopy').onclick = async () => { try { await navigator.clipboard.writeText($('tcLinkTxt').value); tcMsg('Link copiato.'); } catch (e) { $('tcLinkTxt').select(); tcMsg('Seleziona e copia a mano.'); } };
$('tcShare').onclick = async () => {
  const url = $('tcLinkTxt').value;
  if (navigator.share) { try { await navigator.share({ title: 'Telecomando VolleyLive', text: 'Apri il link per comandare la partita:', url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  $('tcCopy').onclick();
};
$('tcRelay').onchange = () => { store.tc = { ...(store.tc || {}), relay: normalizeRelay($('tcRelay').value) || $('tcRelay').value.trim() }; persist(); };
if (store.tc && store.tc.relay) $('tcRelay').value = store.tc.relay; else if (DEFAULT_RELAY) $('tcRelay').value = DEFAULT_RELAY;
if (store.tc && store.tc.on) tcOpen().catch(() => {});

// ---------------------------------------------------------------- diretta (YouTube / Facebook tramite il convertitore sul NAS)
// Qui solo l'interfaccia e il salvataggio dei campi; il collegamento e il video sono in livestream.js, la conversione in stream/.
// La chiave resta sul telefono (se si lascia la spunta) e va solo all'indirizzo del convertitore scritto qui; non entra mai nel rapporto.

let stLast = 'idle';
function streamTag() { const i = ST.info; return i.state === 'live' ? ' · 🔴 in diretta' : i.state === 'retry' || i.state === 'connecting' ? ' · 🔴 diretta: mi ricollego' : ''; }
const stSay = (t) => { $('stMsg').textContent = t || ''; };
function stRender(i) {
  const on = ST.active;
  $('stGo').textContent = on ? 'Ferma la diretta' : 'Vai in diretta';
  $('stGo').classList.toggle('primary', !on);
  ['stPlat', 'stQ', 'stUrl', 'stKey', 'stConv', 'stTok', 'stCompat', 'stRemember'].forEach((id) => { $(id).disabled = on; });
  $('stMsg').textContent = i.text || '';
  const hb = $('hudStream');
  hb.hidden = !on;
  hb.textContent = i.state === 'live' ? '● ' + mmss(i.secs) : i.state === 'retry' ? '⚠ DIRETTA' : '… DIRETTA';
  hb.classList.toggle('retry', i.state === 'retry' || !!i.slow);
  if (i.state !== stLast) {
    note('diretta: ' + i.state);
    if (i.state === 'error' || (i.state === 'retry' && stLast === 'live')) toast(i.state === 'error' ? 'Diretta ferma: ' + i.text : 'Diretta interrotta, riprovo');
    stLast = i.state;
    tcPublish();      // il telecomando vede subito se si trasmette
    if (L.on) updateHud();
  }
}
function stPlatChanged() {
  const p = PLATFORMS[$('stPlat').value] || PLATFORMS.other;
  $('stUrlRow').hidden = $('stPlat').value !== 'other';
  $('stHint').textContent = p.hint;
}
function stRead() {
  return { platform: $('stPlat').value, url: $('stUrl').value, key: $('stKey').value, converter: $('stConv').value, token: $('stTok').value, bps: (QUALITY.find((q) => q.id === $('stQ').value) || QUALITY[1]).bps, compat: $('stCompat').checked };
}
function stSave() {
  const c = stRead(), remember = $('stRemember').checked;
  store.st = { plat: c.platform, url: c.url, conv: c.converter, token: c.token, q: $('stQ').value, compat: c.compat, remember, key: remember ? c.key : '' };
  persist();
}
(function stInit() {
  QUALITY.forEach((q) => { const o = document.createElement('option'); o.value = q.id; o.textContent = q.label; $('stQ').appendChild(o); });
  const st = store.st || {};
  $('stPlat').value = PLATFORMS[st.plat] ? st.plat : 'youtube';
  $('stQ').value = QUALITY.some((q) => q.id === st.q) ? st.q : DEFAULT_QUALITY;
  $('stUrl').value = st.url || ''; $('stConv').value = st.conv || ''; $('stTok').value = st.token || ''; $('stKey').value = st.key || '';
  $('stCompat').checked = !!st.compat; $('stRemember').checked = st.remember !== false;
  stPlatChanged();
})();
$('stPlat').onchange = () => { stPlatChanged(); stSave(); };
['stQ', 'stUrl', 'stKey', 'stConv', 'stTok', 'stCompat', 'stRemember'].forEach((id) => { $(id).onchange = stSave; });
$('stGo').onclick = () => {
  if (ST.active) { if (confirm('Fermare la diretta?')) ST.stop(); return; }
  if (S.mode !== 'camera') { stSay('Apri prima la camera: la diretta trasmette l\'immagine con il tabellone.'); return; }
  if (typeof MediaRecorder === 'undefined' || !cv.captureStream) { stSay('Questo browser non può registrare il video: la diretta non è disponibile.'); return; }
  const c = stRead(), chk = checkSettings(c, location.protocol);
  if (!chk.ok) { stSay(chk.error); return; }
  $('stKey').value = chk.key; $('stConv').value = chk.converter; stSave();
  stSay('');
  ST.start({ converter: chk.converter, token: c.token.trim(), url: chk.url, key: chk.key, bps: c.bps, compat: c.compat });
};
$('hudStream').onclick = () => { openMore(); $('stBox').scrollIntoView({ block: 'center' }); };

// Ripresa di una partita salvata
if (store.snapshot && store.snapshot.events && store.snapshot.events.length) $('resumeBtn').hidden = false;
$('resumeBtn').onclick = () => startMatch(store.snapshot);

window.__vl = { S, L, TC, ST, refreshAll, enterLive, exitLive, setPhase, startMatch, openFile, ensureDetector, rebuildCal, seekTo, timedOccupancy, clock };
