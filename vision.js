// Visione: calibrazione del campo (omografia), zone di battuta e rilevatore di persone (YOLOX via onnxruntime-web).
// La parte geometrica non dipende dal browser e si prova in Node.

// ---------------------------------------------------------------- geometria

/** Risolve un sistema lineare n×n (eliminazione di Gauss con pivot). */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Omografia (matrice 3×3 in righe) che porta 4 punti (x,y) in 4 punti (u,v). */
export function homographyFrom4(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  if (!h) return null;
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}

export function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return null;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

export function project(H, x, y) {
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w];
}

/** Controlla i 4 angoli toccati (in ordine: (0,0) (9,0) (9,18) (0,18)): quadrilatero convesso e non degenere. */
export function checkCorners(pts) {
  if (pts.length !== 4) return 'servono 4 angoli';
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % 4], [x2, y2] = pts[(i + 2) % 4];
    const cr = (x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1);
    if (Math.abs(cr) < 1e-6) return 'tre angoli sono sulla stessa linea';
    const s = Math.sign(cr);
    if (sign && s !== sign) return 'gli angoli non sono in ordine: tocca i quattro angoli del campo andando in giro, senza incrociare';
    sign = s;
  }
  return null;
}

export const COURT = { w: 9, l: 18 };

export class Calibration {
  /**
   * @param corners 4 punti immagine (pixel del video) degli angoli del campo, nell'ordine:
   *   1 = angolo sinistro del lato vicino ai primi due, 2 = angolo destro dello stesso lato (in fondo "lato 1"),
   *   3 = angolo del lato opposto vicino a 2, 4 = angolo del lato opposto vicino a 1.
   * @param size { w, h } dimensioni del video su cui sono stati toccati
   * @param ratio R = altezza persona / distanza dall'orizzonte (si misura con measureRatio)
   */
  constructor(corners, size, ratio = 0.25, opts = {}) {
    this.corners = corners;
    this.size = size;
    this.ratio = ratio;
    this.depth = opts.depth ?? 7;             // profondità della zona di battuta oltre la linea di fondo
    this.margin = opts.margin ?? 0.3;         // la zona comincia 30 cm dietro la linea di fondo
    this.minQ = opts.minQ ?? 0.55;            // altezza minima = 55% di quella attesa
    this.maxQ = opts.maxQ ?? 1.6;             // massima = 160%
    this.minQCut = opts.minQCut ?? 0.3;       // se il riquadro tocca il bordo basso i piedi sono fuori inquadratura
    this.sideMargin = opts.sideMargin ?? 0.3;
    const world = [[0, 0], [COURT.w, 0], [COURT.w, COURT.l], [0, COURT.l]];
    this.H = homographyFrom4(world, corners);
    this.Hi = this.H && inv3(this.H);
    if (!this.H || !this.Hi) throw new Error('calibrazione non valida');
    const r = this.Hi[2], n = Math.hypot(r[0], r[1]);
    this.horizon = [r[0] / n, r[1] / n, r[2] / n];   // retta dell'orizzonte: a·u + b·v + c = 0
  }
  toWorld(u, v) { return project(this.Hi, u, v); }
  toImage(x, y) { return project(this.H, x, y); }
  distToHorizon(u, v) { return Math.abs(this.horizon[0] * u + this.horizon[1] * v + this.horizon[2]); }
  /** Altezza attesa in pixel di una persona con i piedi in (u,v). */
  expectedHeight(u, v) { return this.ratio * this.distToHorizon(u, v); }

  /** Rettangolo (in metri) della zona di battuta di un lato: 'first' (dietro y=0) o 'second' (dietro y=18). */
  zoneRect(end) {
    const sm = this.sideMargin;
    return end === 'first'
      ? { x0: -sm, x1: COURT.w + sm, y0: -this.depth, y1: -this.margin }
      : { x0: -sm, x1: COURT.w + sm, y0: COURT.l + this.margin, y1: COURT.l + this.depth };
  }
  inZone(end, u, v) {
    const [x, y] = this.toWorld(u, v), z = this.zoneRect(end);
    return x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1;
  }
  /** Ritaglio in pixel che contiene la zona e la testa delle persone che ci stanno, ritagliato ai bordi del video. */
  cropBox(end, pad = 6) {
    const z = this.zoneRect(end), pts = [];
    for (const [x, y] of [[z.x0, z.y0], [z.x1, z.y0], [z.x1, z.y1], [z.x0, z.y1]]) {
      const [u, v] = this.toImage(x, y);
      pts.push([u, v]);
      pts.push([u, v - 1.15 * this.expectedHeight(u, v)]);
    }
    const us = pts.map((p) => p[0]), vs = pts.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...us) - pad)), y0 = Math.max(0, Math.floor(Math.min(...vs) - pad));
    const x1 = Math.min(this.size.w, Math.ceil(Math.max(...us) + pad)), y1 = Math.min(this.size.h, Math.ceil(Math.max(...vs) + pad));
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }
  /** Una persona (riquadro in pixel del video) è "in battuta" se i piedi sono nella zona e l'altezza è quella attesa. */
  isServer(end, box) {
    const [x1, y1, x2, y2] = box, fu = (x1 + x2) / 2, fv = y2;
    if (!this.inZone(end, fu, fv)) return false;
    const q = (y2 - y1) / Math.max(1e-6, this.distToHorizon(fu, fv));
    const cut = y2 >= this.size.h - 3;       // piedi tagliati dal bordo: il riquadro è più basso del vero
    return q >= (cut ? this.minQCut : this.minQ) * this.ratio && q <= this.maxQ * this.ratio;
  }
  /** Stima R dalle persone dentro il campo (mediana di altezza/distanza dall'orizzonte). */
  static measureRatio(cal, boxes, minCount = 8) {
    const q = [];
    for (const [x1, y1, x2, y2] of boxes) {
      const fu = (x1 + x2) / 2, fv = y2, [x, y] = cal.toWorld(fu, fv);
      if (x >= 0 && x <= COURT.w && y >= 0 && y <= COURT.l) q.push((y2 - y1) / Math.max(1e-6, cal.distToHorizon(fu, fv)));
    }
    if (q.length < minCount) return null;
    q.sort((a, b) => a - b);
    return q[Math.floor(q.length / 2)];
  }
}

// ---------------------------------------------------------------- rilevatore YOLOX

function makeGrid(size, strides = [8, 16, 32]) {
  const gx = [], gy = [], st = [];
  for (const s of strides) {
    const n = Math.floor(size / s);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { gx.push(x); gy.push(y); st.push(s); }
  }
  return { gx: Float32Array.from(gx), gy: Float32Array.from(gy), st: Float32Array.from(st) };
}

export function nms(boxes, scores, iouThr) {
  const order = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
  const keep = [];
  for (const i of order) {
    let ok = true;
    for (const j of keep) {
      const a = boxes[i], b = boxes[j];
      const iw = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), ih = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      if (iw <= 0 || ih <= 0) continue;
      const inter = iw * ih, uni = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
      if (inter / uni > iouThr) { ok = false; break; }
    }
    if (ok) keep.push(i);
  }
  return keep;
}

/** Decodifica l'uscita di YOLOX (N×85) per la classe "persona". Restituisce riquadri nello spazio dell'input. */
export function decodeYolox(out, grid, thr = 0.3, nmsThr = 0.5) {
  const n = grid.gx.length, boxes = [], scores = [];
  for (let i = 0; i < n; i++) {
    const o = i * 85, s = out[o + 4] * out[o + 5];
    if (s <= thr) continue;
    const cx = (out[o] + grid.gx[i]) * grid.st[i], cy = (out[o + 1] + grid.gy[i]) * grid.st[i];
    const w = Math.exp(out[o + 2]) * grid.st[i], h = Math.exp(out[o + 3]) * grid.st[i];
    boxes.push([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]); scores.push(s);
  }
  return nms(boxes, scores, nmsThr).map((i) => [...boxes[i], scores[i]]);
}

export class PersonDetector {
  /** @param ort modulo onnxruntime-web (già caricato)  @param session sessione con il modello YOLOX  @param size lato dell'input (416 o 640) */
  constructor(ort, session, size) {
    this.ort = ort; this.session = session; this.size = size;
    this.grid = makeGrid(size);
    this.inputName = session.inputNames[0];
    this.buf = new Float32Array(3 * size * size);
    this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.thr = 0.3; this.nmsThr = 0.5; this.maxUpscale = 3;
  }
  static async create(ort, modelUrl, size, providers = ['wasm']) {
    const session = await ort.InferenceSession.create(modelUrl, { executionProviders: providers, graphOptimizationLevel: 'all' });
    return new PersonDetector(ort, session, size);
  }
  /** Rileva persone in un ritaglio {x,y,w,h} di una sorgente disegnabile (video, canvas, immagine). Riquadri in pixel della sorgente. */
  async detect(source, crop) {
    const S = this.size;
    const sc = Math.min(S / crop.w, S / crop.h, this.maxUpscale);
    const nw = Math.max(1, Math.round(crop.w * sc)), nh = Math.max(1, Math.round(crop.h * sc));
    const c = this.ctx;
    c.fillStyle = 'rgb(114,114,114)'; c.fillRect(0, 0, S, S);
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    c.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, nw, nh);
    const px = c.getImageData(0, 0, S, S).data, plane = S * S, buf = this.buf;
    for (let i = 0, p = 0; i < plane; i++, p += 4) {       // YOLOX: ordine BGR, valori 0-255, nessuna normalizzazione
      buf[i] = px[p + 2]; buf[plane + i] = px[p + 1]; buf[2 * plane + i] = px[p];
    }
    const feeds = { [this.inputName]: new this.ort.Tensor('float32', buf, [1, 3, S, S]) };
    const res = await this.session.run(feeds);
    const out = res[this.session.outputNames[0]].data;
    return decodeYolox(out, this.grid, this.thr, this.nmsThr).map(([x1, y1, x2, y2, s]) => [
      x1 / sc + crop.x, y1 / sc + crop.y, x2 / sc + crop.x, y2 / sc + crop.y, s,
    ]);
  }
}

/** Presenza in zona di battuta dei due lati, dato un fotogramma. */
export async function sampleOccupancy(detector, cal, source) {
  const res = { first: false, second: false, boxes: { first: [], second: [] } };
  for (const end of ['first', 'second']) {
    const crop = cal.cropBox(end);
    if (crop.w < 8 || crop.h < 8) continue;
    const boxes = await detector.detect(source, crop);
    res.boxes[end] = boxes;
    res[end] = boxes.some((b) => cal.isServer(end, b));
  }
  return res;
}
