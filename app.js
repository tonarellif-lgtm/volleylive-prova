// VolleyLive web: ripresa (o video registrato), riconoscimento della battuta nel browser, punteggio automatico.
import { ScoreEngine, defaultConfig, AutoScorer, FIRST, SECOND, other } from './engine.js';
import { Calibration, PersonDetector, sampleOccupancy, checkCorners } from './vision.js';

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
};
const cv = $('cv'), ctx = cv.getContext('2d');
const ov = $('ov'), octx = ov.getContext('2d');

const clock = () => (S.mode === 'file' ? S.video.currentTime : (performance.now() - S.clockStart) / 1000);
const note = (m) => { S.notes.push(mmss(clock()) + ' ' + m); if (S.notes.length > 200) S.notes.shift(); };
const stat = (m) => { $('stats').textContent = m; };

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
    catch (e2) { stat('Camera non disponibile: ' + e2.name + '. Controlla i permessi di Safari per questo sito.'); return; }
  }
  S.mode = 'camera';
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
  if (!v.videoWidth) { stat('Questo video non si apre in Safari (formato non supportato).'); return; }
  try { v.currentTime = 0.1; await new Promise((r) => { v.onseeked = r; setTimeout(r, 2000); }); } catch (e) { /* ignorato */ }
  $('seekRow').hidden = false; $('secOffline').hidden = false; $('secRec').hidden = true;
  showSource(v.videoWidth, v.videoHeight, 'video ' + mmss(v.duration));
  stat(file.name + ' · ' + mmss(v.duration));
}

async function stopSource() {
  S.live = false; S.stopAnalyze = true;
  if (S.recording) stopRec();
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
    octx.fillStyle = 'rgba(0,0,0,0.6)'; octx.fillRect(ov.width - 250 * k, 8 * k, 242 * k, 30 * k);
    octx.fillStyle = '#fff'; octx.font = '700 ' + 15 * k + 'px ' + FONT; octx.textAlign = 'left'; octx.textBaseline = 'middle';
    octx.fillText('lato 1 ' + (S.lastOcc.first ? '●' : '○') + '   lato 2 ' + (S.lastOcc.second ? '●' : '○'), ov.width - 242 * k, 23 * k);
  }
  // lente d'ingrandimento mentre si trascina un angolo
  if (S.drag >= 0 && pts[S.drag]) {
    const p = pts[S.drag], r = 70 * k, z = 3;
    const cx = p[0] < ov.width / 2 ? ov.width - r - 12 * k : r + 12 * k, cy = r + 12 * k;
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
  const step = S.mode === 'file' ? +$('stepSel').value : 0.45;
  return new AutoScorer({ mergeGap: 12, confirmSec: step >= 1 ? 0 : 0.3, dropoutSec: Math.max(2.5, step * 1.5) });
}
function startMatch(snapshot = null) {
  if (!S.cal) { $('calInfo').textContent = 'Prima serve il campo: tocca i 4 angoli.'; return; }
  S.config = snapshot ? snapshot.config : readConfig();
  S.engine = new ScoreEngine(S.config, snapshot);
  S.scorer = newScorer();
  S.scorer.autoApply = $('autoChk').checked;
  $('setup').hidden = true; $('play').hidden = false; $('secReview').hidden = false;
  S.lockCal = true;
  labelButtons(); refreshAll();
  persist();
  if (S.mode === 'camera') startLive();
}
$('startMatch').onclick = () => startMatch();

function labelButtons() {
  $('addA').textContent = '+1 ' + S.config.teamAName; $('addB').textContent = '+1 ' + S.config.teamBName;
  $('addA').style.background = S.config.teamAColor; $('addB').style.background = S.config.teamBColor;
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
  $('viaBtn').disabled = st.isFinished;
  $('contesaBtn').disabled = sc.mode === 'idle' || st.isFinished;
  $('undoBtn').disabled = !S.engine.canUndo;
  renderReview();
}

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
$('addA').onclick = () => manualPoint('a');
$('addB').onclick = () => manualPoint('b');
$('undoBtn').onclick = () => {
  if (!S.engine) return;
  S.engine.undo();
  const st = S.engine.state;
  if (S.scorer.mode === 'idle' && !st.isFinished && !st.isAtStartOfSet) S.scorer.mode = 'tracking';
  S.scorer.lastAutoCount = null;
  persist(); refreshAll();
};
$('viaBtn').onclick = () => { if (S.engine) { S.scorer.arm(S.engine, null, clock()); persist(); refreshAll(); } };
$('contesaBtn').onclick = () => { if (S.engine) { S.scorer.contesa(S.engine, clock()); persist(); refreshAll(); } };
$('endMatch').onclick = () => {
  S.live = false; S.lockCal = false;
  $('setup').hidden = false; $('play').hidden = true;
  try { localStorage.removeItem(KEY); } catch (e) { /* ignorato */ }
  S.engine = null; S.scorer = null; S.dirty = true;
};
$('debugChk').onchange = () => { S.dirty = true; };
$('autoChk').onchange = () => { if (S.scorer) S.scorer.autoApply = $('autoChk').checked; };
$('setScoreBtn').onclick = () => {
  if (!S.engine) return;
  const a = parseInt($('scA').value, 10), b = parseInt($('scB').value, 10);
  if (!(a >= 0 && b >= 0)) { $('copyMsg').textContent = 'Scrivi i due punteggi.'; return; }
  const ok = S.engine.setScore(a, b, { time: clock(), auto: false });
  $('copyMsg').textContent = ok ? '' : 'Non posso portare il set a ' + a + '–' + b + ' (chiuderebbe il set: usa i tasti +1 o «Via»).';
  S.scorer.lastAutoCount = null;
  persist(); refreshAll();
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
  const opts = { videoBitsPerSecond: 6000000, audioBitsPerSecond: 128000 };
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
  S.clockStart = performance.now();
  S.recording = true; S.recStart = performance.now();
  $('recBtn').textContent = 'Ferma la registrazione';
  $('recResult').hidden = true;
  S.recTimer = setInterval(() => { $('recStats').textContent = '● ' + mmss((performance.now() - S.recStart) / 1000); }, 1000);
}
function stopRec() { if (S.rec && S.rec.state !== 'inactive') S.rec.stop(); clearInterval(S.recTimer); S.recording = false; $('recBtn').textContent = 'Registra'; }
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
}
$('recBtn').onclick = () => (S.recording ? stopRec() : startRec());
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
  tl.forEach((r) => {
    const e = r.event, tr = document.createElement('tr');
    if (r.setEnded) tr.className = 'setend';
    const td = (txt, cls) => { const c = document.createElement('td'); if (cls) c.className = cls; c.textContent = txt; tr.appendChild(c); return c; };
    td(String(r.index + 1), 'num');
    td(r.meta.time === null ? '–' : mmss(r.meta.time), 'num');
    td(String(r.set));
    if (e.type === 'point') {
      const c = td(''); const s = document.createElement('span'); s.className = e.side === 'a' ? 'tA' : 'tB'; s.textContent = teamName(e.side) + (r.meta.auto ? ' ·auto' : ''); c.appendChild(s);
      td(r.a + '–' + r.b, 'num');
    } else {
      td({ timeout: 'time-out', substitution: 'sostituzione', setServing: 'chi batte', swapSides: 'cambio campo' }[e.type] + (e.side ? ' ' + teamName(e.side) : ''));
      td('');
    }
    const act = document.createElement('td');
    const mk = (label, title, fn, dis) => { const b = document.createElement('button'); b.className = 'small'; b.textContent = label; b.title = title; b.disabled = !!dis; b.onclick = fn; act.appendChild(b); };
    mk('▶︎', 'rivedi', () => previewAt(r.meta.time), !hasVideo || r.meta.time === null);
    if (e.type === 'point') mk('⇄', 'dai il punto all\'altra squadra', () => correct(S.engine.flipPoint(r.index)));
    mk('✕', 'togli', () => correct(S.engine.removeEvent(r.index)));
    tr.appendChild(act);
    body.appendChild(tr);
  });
  const rep = {
    versione: 1, quando: new Date().toISOString(), dispositivo: navigator.userAgent, sorgente: S.mode, video: S.size,
    calibrazione: { angoli: S.corners, rapporto: S.ratio, misurato: S.measured, latoUno: $('sideSel').value },
    partita: S.engine.snapshot, registroAuto: S.scorer ? S.scorer.log : [], campioni: S.samples, msPerCampione: Math.round(avgMs()), note: S.notes.slice(-60),
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

// ---------------------------------------------------------------- avvio

$('camBtn').onclick = startCamera;
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
// Ripresa di una partita salvata
if (store.snapshot && store.snapshot.events && store.snapshot.events.length) $('resumeBtn').hidden = false;
$('resumeBtn').onclick = () => startMatch(store.snapshot);

window.__vl = { S, startMatch, openFile, ensureDetector, rebuildCal, seekTo, timedOccupancy, clock };
