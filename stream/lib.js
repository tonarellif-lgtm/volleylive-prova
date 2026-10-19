// Funzioni pure del convertitore: validazioni, riconoscimento del video in arrivo, comando ffmpeg, chiavi nascoste nei messaggi.
// Nessuna dipendenza, così si provano senza ffmpeg né rete.
import crypto from 'node:crypto';

/** Server ai quali il convertitore può mandare il video. Altri si aggiungono con ALLOWED_HOSTS. */
export const DEFAULT_HOSTS = [
  'a.rtmp.youtube.com', 'b.rtmp.youtube.com', 'a.rtmps.youtube.com', 'b.rtmps.youtube.com',
  'rtmp-api.facebook.com', 'live-api-s.facebook.com',
];

export const parseList = (s) => String(s || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

const URL_RE = /^(rtmps?):\/\/([a-z0-9][a-z0-9.-]*)(?::(\d{1,5}))?(\/[A-Za-z0-9_\-./]*)?$/i;
const KEY_RE = /^[A-Za-z0-9_\-.?=&%~:]{4,400}$/;

/** Controlla server e chiave e compone l'indirizzo completo. Restituisce { ok, out, host, scheme } oppure { ok:false, error }. */
export function validateTarget(url, key, hosts = DEFAULT_HOSTS) {
  const m = URL_RE.exec(String(url || '').trim());
  if (!m) return { ok: false, error: 'L\'indirizzo del server deve cominciare con rtmp:// o rtmps://' };
  const scheme = m[1].toLowerCase(), host = m[2].toLowerCase(), port = m[3] ? +m[3] : null, path = (m[4] || '').replace(/\/+$/, '');
  if (port !== null && (port < 1 || port > 65535)) return { ok: false, error: 'Porta del server non valida' };
  if (!hosts.includes(host)) return { ok: false, error: 'Questo convertitore non può trasmettere verso ' + host + ' (si abilita con ALLOWED_HOSTS)' };
  const k = String(key || '').trim();
  if (!KEY_RE.test(k)) return { ok: false, error: 'La chiave di streaming non sembra valida' };
  return { ok: true, scheme, host, out: scheme + '://' + host + (port !== null ? ':' + port : '') + path + '/' + k, key: k };
}

/** Toglie chiavi e indirizzi completi dai testi che escono dal convertitore (registro e messaggi al telefono). */
export function redact(text, secrets = []) {
  let t = String(text || '').replace(/rtmps?:\/\/[^\s'"]+/gi, (m) => m.replace(/^(rtmps?:\/\/[^/\s]+\/?).*$/i, '$1***'));
  for (const s of secrets) if (s && s.length >= 4) t = t.split(s).join('***');
  return t;
}

export function safeEqual(a, b) {
  const h = (x) => crypto.createHash('sha256').update(String(x || '')).digest();
  return crypto.timingSafeEqual(h(a), h(b)) && String(a || '').length > 0;
}

/**
 * Guarda l'inizio del video (la parte con l'intestazione) e dice contenitore e codec.
 * Il tipo dichiarato dal browser non basta: Safari può dare solo «video/mp4».
 * `known` è vero se l'elenco delle tracce è stato visto: solo allora «niente audio» è una certezza.
 */
export function detectMedia(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  let container = null;
  if (b.length >= 8 && b.subarray(4, 8).toString('latin1') === 'ftyp') container = 'mp4';
  else if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) container = 'webm';
  let video = null, audio = null, known = false, scope = b;
  if (container === 'mp4') {
    const i = b.indexOf('moov', 0, 'latin1');      // le marche compatibili di «ftyp» nominano avc1 anche per altri codec: si cerca solo dentro «moov»
    if (i >= 0) { known = true; scope = b.subarray(i); }
    else scope = Buffer.alloc(0);
  } else if (container === 'webm') {
    known = b.includes('V_', 0, 'latin1');
  }
  const has = (s) => scope.includes(s, 0, 'latin1');
  if (container === 'mp4') {
    if (has('avc1') || has('avc3')) video = 'h264'; else if (has('hvc1') || has('hev1')) video = 'hevc'; else if (has('vp09')) video = 'vp9'; else if (has('av01')) video = 'av1';
    if (has('mp4a')) audio = 'aac'; else if (has('Opus')) audio = 'opus';
  } else if (container === 'webm') {
    if (has('V_MPEG4/ISO/AVC')) video = 'h264'; else if (has('V_VP9')) video = 'vp9'; else if (has('V_VP8')) video = 'vp8'; else if (has('V_AV1')) video = 'av1';
    if (has('A_AAC')) audio = 'aac'; else if (has('A_OPUS')) audio = 'opus';
  }
  return { container, video, audio, known };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+n) ? +n : lo));

/**
 * Argomenti di ffmpeg. H.264 + AAC si copiano senza ricodificare (poca CPU: va bene anche su un NAS piccolo);
 * il resto, o MODE=transcode, si ricodifica in H.264 con un fotogramma chiave ogni 2 s, come chiede Facebook.
 */
export function buildArgs({ out, media, bitrate = 3000000, mode = 'auto' }) {
  const copyVideo = mode !== 'transcode' && media.video === 'h264';
  const noAudio = media.known && media.audio === null;
  const copyAudio = media.audio === 'aac';
  const br = clamp(bitrate, 500000, 8000000);
  const a = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1', '-stats_period', '2',
    '-fflags', '+genpts', '-analyzeduration', '2000000', '-probesize', '2000000',
    '-f', media.container === 'webm' ? 'webm' : 'mp4', '-i', 'pipe:0'];
  if (noAudio) a.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  a.push('-map', '0:v:0', '-map', noAudio ? '1:a:0' : '0:a:0?');
  if (copyVideo) a.push('-c:v', 'copy');
  else a.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-r', '30',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-b:v', String(br), '-maxrate', String(br), '-bufsize', String(br * 2));
  if (copyAudio) a.push('-c:a', 'copy'); else a.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2');
  if (noAudio) a.push('-shortest');
  a.push('-f', 'flv', '-flvflags', 'no_duration_filesize', out);
  return { args: a, copyVideo, copyAudio, noAudio };
}

/** Una riga di «-progress» alla volta; restituisce lo stato quando il blocco è completo. */
export function progressParser() {
  let cur = {};
  return (line) => {
    const i = line.indexOf('=');
    if (i < 0) return null;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
    cur[k] = v;
    if (k !== 'progress') return null;
    const kb = parseFloat(String(cur.bitrate || '').replace('kbits/s', ''));
    const sp = parseFloat(String(cur.speed || '').replace('x', ''));
    const out = { kbps: Number.isFinite(kb) ? Math.round(kb) : null, speed: Number.isFinite(sp) ? sp : null, secs: cur.out_time_us ? Math.max(0, Math.round(+cur.out_time_us / 1e6)) : null, drop: +cur.drop_frames || 0, end: v === 'end' };
    cur = {};
    return out;
  };
}

/** Frase comprensibile per chi sta trasmettendo, a partire dall'ultimo messaggio di ffmpeg (già ripulito dalle chiavi). */
export function friendlyError(stderr, host) {
  const t = String(stderr || '');
  if (/Connection refused|Connection timed out|Network is unreachable|Name or service not known|Cannot assign|failed to resolve|getaddrinfo/i.test(t)) return 'Il convertitore non riesce a raggiungere ' + host + '. Controlla la rete del NAS.';
  if (/Server returned|RTMP_Connect|Handshake|Input\/output error|Broken pipe|Connection reset|Cannot open connection|rtmp.*(failed|error)/i.test(t)) return host + ' ha chiuso il collegamento: controlla server e chiave di streaming e che la diretta sia pronta.';
  if (/Invalid data found|moov atom not found|could not find codec|Could not write header/i.test(t)) return 'Il convertitore non capisce il video che arriva dal telefono.';
  return 'La conversione si è fermata' + (t ? ': ' + t.trim().split('\n').slice(-1)[0].slice(0, 160) : '.');
}
