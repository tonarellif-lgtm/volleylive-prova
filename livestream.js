// Diretta: manda l'immagine della camera con il tabellone (quella che si registra) al convertitore (web/stream), che la gira in RTMP
// a YouTube, Facebook o altro. Il browser non parla RTMP: il video parte da qui come pezzi MP4/WebM dentro un WebSocket.
// Nessun segreto passa da altre parti: chiave e codice vanno solo al convertitore indicato, che nel registro non li scrive.

export const PLATFORMS = {
  youtube: {
    label: 'YouTube', url: 'rtmps://a.rtmps.youtube.com:443/live2',
    hint: 'In YouTube Studio apri «Crea → Vai in diretta», scegli «Stream» e copia la «Chiave stream». La diretta parte da sola quando arriva il video.',
  },
  facebook: {
    label: 'Facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp/',
    hint: 'Su Facebook scegli «Video in diretta → Software di streaming» e copia la «Chiave di streaming»: vale per una diretta sola. Facebook vuole un fotogramma chiave ogni 2 secondi: se protesta, attiva «Ricodifica sempre».',
  },
  other: {
    label: 'Altro (RTMP)', url: '',
    hint: 'Scrivi l\'indirizzo del server (rtmp:// o rtmps://…) e la chiave. L\'host deve essere ammesso dal convertitore (ALLOWED_HOSTS).',
  },
};

export const QUALITY = [
  { id: 'low', label: 'Bassa · 2 Mbit/s (rete dati debole)', bps: 2000000 },
  { id: 'mid', label: 'Media · 3 Mbit/s', bps: 3000000 },
  { id: 'high', label: 'Alta · 4,5 Mbit/s (Wi-Fi buono)', bps: 4500000 },
];
export const DEFAULT_QUALITY = 'mid';

// Preferenza: MP4 H.264+AAC (il convertitore lo copia senza ricodificare); poi WebM, dal più leggero da ricodificare al più pesante.
export const STREAM_TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];

/** Indirizzo del convertitore in forma wss://host[:porta][/percorso] (accetta anche https://, host nudo, e toglie un /live finale). null se non valido. */
export function normalizeConverter(text) {
  let s = String(text || '').trim().replace(/\/+$/, '').replace(/\/live$/i, '');
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = 'wss://' + s;
  s = s.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
  try {
    const u = new URL(s);
    return (u.protocol === 'wss:' || u.protocol === 'ws:') && u.host ? u.protocol + '//' + u.host + u.pathname.replace(/\/+$/, '') : null;
  } catch (e) { return null; }
}

/** Toglie spazi e a capo che si portano dietro copiando la chiave. */
export const cleanKey = (t) => String(t || '').replace(/\s+/g, '');

const KEY_RE = /^[A-Za-z0-9_\-.?=&%~:]{4,400}$/;
/**
 * Controlla le impostazioni prima di partire. Restituisce { ok, error, converter, url, key }.
 * pageProtocol: da una pagina https un ws:// non si apre (contenuto misto), tranne verso questo stesso computer.
 */
export function checkSettings(c, pageProtocol = 'https:') {
  const conv = normalizeConverter(c.converter);
  if (!conv) return { ok: false, error: 'Scrivi l\'indirizzo del convertitore, per esempio wss://nas.tuonome.synology.me:8443' };
  if (pageProtocol === 'https:' && conv.startsWith('ws:') && !/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(conv)) {
    return { ok: false, error: 'Da questa pagina (https) serve un indirizzo che comincia con wss://: vedi stream/README.md per il certificato.' };
  }
  if (!String(c.token || '').trim()) return { ok: false, error: 'Scrivi il codice di accesso del convertitore (STREAM_TOKEN).' };
  const plat = PLATFORMS[c.platform] || PLATFORMS.other;
  const url = (plat.url || String(c.url || '')).trim();
  if (!/^rtmps?:\/\/[^\s/]+/i.test(url)) return { ok: false, error: 'Scrivi l\'indirizzo RTMP, che comincia con rtmp:// o rtmps://' };
  const key = cleanKey(c.key);
  if (!key) return { ok: false, error: 'Incolla la chiave della diretta (la dà ' + (c.platform === 'facebook' ? 'Facebook' : c.platform === 'youtube' ? 'YouTube' : 'il servizio') + ').' };
  if (!KEY_RE.test(key)) return { ok: false, error: 'La chiave ha caratteri strani o è troppo corta: copiala di nuovo, intera.' };
  return { ok: true, converter: conv, url, key };
}

const mmss = (s) => String(Math.floor(s / 60)) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const SOFT_SECONDS = 3, HARD_SECONDS = 12, MAX_ATTEMPTS = 20;

export class LiveStream {
  /**
   * canvas: l'immagine da trasmettere · getAudioTracks(): tracce audio della camera · onState(info): { state, text, secs, kbps, slow, mode }
   * state: 'idle' | 'connecting' | 'live' | 'retry' | 'error'
   */
  constructor({ canvas, getAudioTracks = () => [], onState = () => {}, WS = globalThis.WebSocket, MR = globalThis.MediaRecorder, setT = (f, ms) => setTimeout(f, ms), clearT = (id) => clearTimeout(id), setI = (f, ms) => setInterval(f, ms), clearI = (id) => clearInterval(id), now = () => Date.now() } = {}) {
    Object.assign(this, { canvas, getAudioTracks, onState, WS, MR, setT, clearT, setI, clearI, now });
    this.info = { state: 'idle', text: '', secs: 0, kbps: 0, slow: false, mode: null };
    this.ws = null; this.rec = null; this.out = null; this.retryTimer = 0; this.tick = 0;
    this.cfg = null; this.userStop = true; this.attempt = 0; this.everOpened = false; this.liveSince = 0; this.startedAt = 0;
    this.stat = null; this.modeInfo = null; this.lastErr = ''; this.backlog = 0; this.slow = false; this.mime = '';
  }
  get active() { return this.info.state !== 'idle' && this.info.state !== 'error'; }

  _emit(state, text) {
    const secs = this.startedAt ? Math.max(0, (this.now() - this.startedAt) / 1000) : 0;
    this.info = { state, text, secs, kbps: this.stat ? this.stat.kbps : 0, slow: this.slow, mode: this.modeInfo ? this.modeInfo.mode : null };
    try { this.onState(this.info); } catch (e) { /* chi ascolta non deve fermare la diretta */ }
  }
  _liveText() {
    const m = this.modeInfo;
    return 'In diretta ' + mmss((this.now() - this.startedAt) / 1000)
      + (this.stat && this.stat.kbps ? ' · ' + (this.stat.kbps / 1000).toFixed(1).replace('.', ',') + ' Mbit/s' : '')
      + (m ? ' · ' + (m.mode === 'copy' ? 'video copiato' : 'video ricodificato') + (m.silentAudioAdded ? ', senza audio' : '') : '')
      + (this.slow ? ' · ⚠ la rete fatica a stare dietro' : '');
  }

  start(cfg) {
    if (this.active) return false;
    this.cfg = { ...cfg, bps: cfg.bps || 3000000 };
    this.userStop = false; this.attempt = 0; this.everOpened = false; this.liveSince = 0; this.startedAt = this.now();
    this.stat = null; this.modeInfo = null; this.lastErr = ''; this.slow = false;
    this.tick = this.setI(() => { if (this.info.state === 'live') this._emit('live', this._liveText()); }, 1000);
    this._open();
    return true;
  }

  stop() {
    this.userStop = true;
    this.clearT(this.retryTimer); this.retryTimer = 0;
    const ws = this.ws;
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ k: 'stop' })); } catch (e) { /* già chiuso */ } }
    this._teardown();
    this.clearI(this.tick); this.tick = 0;
    this.startedAt = 0; this.stat = null; this.modeInfo = null; this.slow = false;
    this._emit('idle', '');
  }

  _teardown() {
    const rec = this.rec, ws = this.ws, out = this.out;
    this.rec = null; this.ws = null; this.out = null;
    if (rec) { rec.ondataavailable = null; rec.onerror = null; rec.onstop = null; try { if (rec.state !== 'inactive') rec.stop(); } catch (e) { /* già fermo */ } }
    if (out) out.getVideoTracks().forEach((t) => { try { t.stop(); } catch (e) { /* ignorato */ } });   // l'audio è della camera: non si ferma
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch (e) { /* già chiuso */ } }
  }

  _open() {
    this._emit('connecting', this.attempt ? 'Mi ricollego al convertitore…' : 'Mi collego al convertitore…');
    let ws;
    try { ws = new this.WS(this.cfg.converter + '/live'); } catch (e) { this._fail('Indirizzo del convertitore non valido.'); return; }
    this.ws = ws; this.stat = null; this.modeInfo = null; this.slow = false; this.backlog = 0;
    try { ws.binaryType = 'arraybuffer'; } catch (e) { /* ignorato */ }
    const mine = () => this.ws === ws;
    ws.onopen = () => {
      if (!mine()) return;
      this.everOpened = true;
      ws.send(JSON.stringify({ k: 'start', token: this.cfg.token, url: this.cfg.url, key: this.cfg.key, bitrate: this.cfg.bps, compat: !!this.cfg.compat }));
    };
    ws.onmessage = (ev) => {
      if (!mine() || typeof ev.data !== 'string') return;
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.k === 'ready') this._record(ws);
      else if (m.k === 'mode') { this.modeInfo = m; }
      else if (m.k === 'stat') { this.stat = m; if (this.info.state === 'live') this._emit('live', this._liveText()); }
      else if (m.k === 'err') {
        this.lastErr = String(m.msg || 'Errore del convertitore.');
        if (m.fatal) this._fail(this.lastErr);
      }
    };
    ws.onerror = () => { /* segue sempre onclose */ };
    ws.onclose = () => { if (mine()) this._lost(); };
  }

  _record(ws) {
    if (this.rec || this.ws !== ws) return;
    let out, rec;
    try {
      out = this.canvas.captureStream(30);
      this.getAudioTracks().forEach((t) => out.addTrack(t));
      this.mime = STREAM_TYPES.find((t) => this.MR.isTypeSupported && this.MR.isTypeSupported(t)) || '';
      const opts = { videoBitsPerSecond: this.cfg.bps, audioBitsPerSecond: 128000 };
      if (this.mime) opts.mimeType = this.mime;
      try { rec = new this.MR(out, opts); } catch (e) { rec = new this.MR(out); }
    } catch (e) { this._fail('Questo browser non sa registrare il video per la diretta (' + (e && e.name || 'errore') + ').'); return; }
    this.out = out; this.rec = rec;
    const soft = this.cfg.bps / 8 * SOFT_SECONDS, hard = this.cfg.bps / 8 * HARD_SECONDS;
    rec.ondataavailable = (e) => {
      if (this.ws !== ws || ws.readyState !== 1 || !e.data || !e.data.size) return;
      try { ws.send(e.data); } catch (err) { return; }
      this.backlog = ws.bufferedAmount;
      const slow = this.backlog > soft;
      if (slow !== this.slow) { this.slow = slow; if (this.info.state === 'live') this._emit('live', this._liveText()); }
      // TCP non perde pezzi: se la coda cresce troppo si riparte da capo (chi guarda vede un salto, ma torna in tempo reale)
      if (this.backlog > hard) { this.lastErr = 'La rete dati non regge il video: riparto da capo (prova una qualità più bassa).'; this._lost(); }
    };
    rec.onerror = () => { if (this.rec === rec) { this.lastErr = 'Errore della registrazione per la diretta.'; this._lost(); } };
    try { rec.start(500); } catch (e) { this._fail('La registrazione per la diretta non parte (' + (e && e.name || 'errore') + ').'); return; }
    this.liveSince = this.now();
    this._emit('live', this._liveText());
  }

  _fail(text) {
    this.userStop = true;
    this.clearT(this.retryTimer); this.retryTimer = 0;
    this._teardown();
    this.clearI(this.tick); this.tick = 0;
    this.startedAt = 0; this.stat = null; this.modeInfo = null; this.slow = false;
    this._emit('error', text);
  }

  // Collegamento perso: se non si è mai riusciti a collegarsi l'impostazione è sbagliata (si dice subito), altrimenti si riprova.
  _lost() {
    if (this.userStop) return;
    const wasLive = this.liveSince && this.now() - this.liveSince > 10000;
    const why = this.lastErr;
    this._teardown();
    if (!this.everOpened) {
      this._fail('Non riesco a collegarmi al convertitore. Controlla l\'indirizzo, che il NAS sia raggiungibile (VPN accesa?) e che il certificato sia valido: da questa pagina serve wss://.');
      return;
    }
    if (wasLive) this.attempt = 0;
    this.liveSince = 0;
    this.attempt++;
    if (this.attempt > MAX_ATTEMPTS) { this._fail((why ? why + ' ' : '') + 'Ho provato più volte senza riuscire a ripartire: la diretta è ferma.'); return; }
    const wait = Math.min(30, 2 ** Math.min(this.attempt, 5));
    this.lastErr = '';
    this._emit('retry', (why || 'Collegamento interrotto.') + ' Riprovo tra ' + wait + ' s (tentativo ' + this.attempt + ').');
    this.clearT(this.retryTimer);
    this.retryTimer = this.setT(() => { this.retryTimer = 0; if (!this.userStop) this._open(); }, wait * 1000);
  }
}
