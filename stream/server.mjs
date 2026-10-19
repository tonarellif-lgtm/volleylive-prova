// Convertitore di diretta: riceve il video dal telefono (WebSocket) e lo manda in RTMP/RTMPS a YouTube, Facebook o altro con ffmpeg.
//
// Telefono → server (testo JSON, poi solo pezzi di video in binario):
//   {"k":"start","token":"…","url":"rtmps://server/app","key":"chiave","bitrate":3000000,"compat":false}
//                                       compat:true = ricodifica sempre (per chi vuole un fotogramma chiave ogni 2 s, come Facebook)
//   {"k":"stop"}
// Server → telefono:
//   {"k":"ready"}                              avvio accettato: si può mandare il video
//   {"k":"mode","mode":"copy|transcode",…}     come viene convertito
//   {"k":"stat","kbps":…,"speed":…,"secs":…}   ogni 2 s
//   {"k":"err","msg":"…","fatal":true|false}   fatal: inutile riprovare con gli stessi dati
//
// Il codice di accesso (STREAM_TOKEN) è obbligatorio. Chiavi di streaming e codice non vengono mai scritti nel registro
// né rimandati al telefono: ogni testo di ffmpeg passa da redact().
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { DEFAULT_HOSTS, parseList, validateTarget, detectMedia, buildArgs, progressParser, redact, friendlyError, safeEqual } from './lib.js';

export const LIMITS = { maxChunk: 4 * 1024 * 1024, startWaitMs: 10000, idleMs: 20000, maxPending: 16 * 1024 * 1024, headBytes: 48 * 1024, headWaitMs: 1500, noDataMs: 20000, killMs: 4000 };

/** MP4 a pezzi: l'intestazione è completa quando «moov» è tutto arrivato (da lì si sa quali codec ci sono). */
function mp4InitComplete(b) {
  if (b.length < 16 || b.toString('latin1', 4, 8) !== 'ftyp') return false;
  for (let off = 0; off + 8 <= b.length;) {
    const size = b.readUInt32BE(off), type = b.toString('latin1', off + 4, off + 8);
    if (size < 8) return false;
    if (type === 'moov') return off + size <= b.length;
    off += size;
  }
  return false;
}

export function startStream(opts = {}) {
  const cfg = {
    port: opts.port ?? 8080, token: opts.token || '', origins: opts.origins || [], hosts: opts.hosts && opts.hosts.length ? opts.hosts : DEFAULT_HOSTS,
    maxSessions: opts.maxSessions ?? 1, ffmpeg: opts.ffmpeg || 'ffmpeg', mode: opts.mode === 'transcode' ? 'transcode' : 'auto',
    caCert: opts.caCert || null,      // certificato pubblico della CA: si scarica da /ca.crt per installarlo sul telefono
    tls: opts.tls && opts.tls.cert && opts.tls.key ? opts.tls : null,    // {cert, key} (testo PEM): il convertitore parla direttamente wss://
    log: opts.log || (() => {}), ...LIMITS, ...(opts.limits || {}),
  };
  if (!cfg.token) throw new Error('Manca STREAM_TOKEN: senza codice di accesso il convertitore non parte.');
  let ffOk = false;
  try { ffOk = spawnSync(cfg.ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0; } catch (e) { ffOk = false; }
  if (!ffOk) cfg.log('ATTENZIONE: ffmpeg non trovato (' + cfg.ffmpeg + ')');

  const active = new Set();
  const onRequest = (req, res) => {
    if (req.url === '/health') {
      res.writeHead(ffOk ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: ffOk, ffmpeg: ffOk, sessions: active.size }));
      return;
    }
    if (req.url === '/ca.crt' && cfg.caCert) {      // è un certificato pubblico, non un segreto: serve a installarlo sul telefono
      res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="volleylive-ca.crt"', 'cache-control': 'no-store' });
      res.end(cfg.caCert);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('volleylive stream ok\n');
  };
  const server = cfg.tls ? https.createServer({ cert: cfg.tls.cert, key: cfg.tls.key }, onRequest) : http.createServer(onRequest);
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxChunk });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (!/^\/live(\?|$)/.test(req.url || '')) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    if (cfg.origins.length && !(origin && cfg.origins.includes(origin))) { cfg.log('collegamento rifiutato: la pagina «' + String(origin || 'sconosciuta').slice(0, 80) + '» non è in ALLOWED_ORIGINS'); socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => session(ws, req));
  });

  function session(ws, req) {
    const id = crypto.randomBytes(3).toString('hex');
    const who = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').toString().split(',')[0].trim();
    let state = 'new', target = null, bitrate = 3000000, head = [], headLen = 0, headTimer = null, ff = null, stderr = '', watchdog = null;
    let lastData = Date.now(), startedAt = 0, counted = false, compat = false;
    const secrets = [];
    const send = (o) => { if (ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch (e) { /* chiuso */ } } };
    const log = (m) => cfg.log('[' + id + '] ' + m);
    const startTimer = setTimeout(() => fail('Nessun comando di avvio ricevuto.', true, 1008), cfg.startWaitMs);

    function close(code = 1000) {
      if (state === 'closed') return;
      const was = state; state = 'closed';
      clearTimeout(startTimer); clearTimeout(headTimer); clearInterval(watchdog);
      if (counted) active.delete(id);
      if (ff) {
        const p = ff; ff = null;
        try { p.stdin.end(); } catch (e) { /* già chiuso */ }
        const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* già finito */ } }, cfg.killMs); t.unref();
        p.once('exit', () => clearTimeout(t));
      }
      try { ws.close(code); } catch (e) { /* già chiuso */ }
      if (was === 'live' || was === 'head') log('chiusa dopo ' + Math.round((Date.now() - startedAt) / 1000) + ' s');
    }
    function fail(msg, fatal = true, code = 1011) { log('errore: ' + redact(msg, secrets)); send({ k: 'err', msg: redact(msg, secrets), fatal }); close(code); }

    function begin() {
      clearTimeout(headTimer);
      const buf = Buffer.concat(head); head = [];
      const media = detectMedia(buf);
      if (!media.container) { log('formato non riconosciuto: ' + buf.length + ' byte, inizio ' + buf.subarray(0, 16).toString('hex')); fail('Il convertitore non riconosce il formato del video (serve MP4 o WebM).', true, 1003); return; }
      const { args, copyVideo, copyAudio, noAudio } = buildArgs({ out: target.out, media, bitrate, mode: cfg.mode === 'transcode' || compat ? 'transcode' : 'auto' });
      try { ff = spawn(cfg.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { fail('ffmpeg non si avvia sul convertitore.', false); return; }
      const p = ff;
      p.on('error', () => { if (ff === p) fail('ffmpeg non si avvia sul convertitore.', true); });
      p.stdin.on('error', () => { /* se ffmpeg è già uscito lo dice 'exit' */ });
      const parse = progressParser(); let outBuf = '';
      p.stdout.on('data', (d) => {
        outBuf += d.toString();
        let i;
        while ((i = outBuf.indexOf('\n')) >= 0) {
          const line = outBuf.slice(0, i); outBuf = outBuf.slice(i + 1);
          const s = parse(line);
          if (s && !s.end) send({ k: 'stat', ...s });
        }
      });
      p.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
      p.on('exit', (code, sig) => {
        if (ff !== p || state === 'closed') return;
        ff = null;
        const clean = redact(stderr, secrets);
        log('ffmpeg è uscito (' + (code ?? sig) + ') ' + clean.trim().split('\n').slice(-1)[0]);
        send({ k: 'err', msg: friendlyError(clean, target.host), fatal: false });
        close(1011);
      });
      state = 'live';
      send({ k: 'mode', mode: copyVideo ? 'copy' : 'transcode', video: media.video, audio: media.audio, silentAudioAdded: noAudio, copyAudio });
      log('in onda verso ' + target.host + ' · ' + (copyVideo ? 'video copiato' : 'video ricodificato') + (copyAudio ? ', audio copiato' : ', audio ricodificato'));
      write(buf);
    }
    function write(buf) {
      if (!ff) return;
      if (ff.stdin.writableLength > cfg.maxPending) { fail('Il convertitore non riesce a stare dietro al video: abbassa la qualità.', false); return; }
      ff.stdin.write(buf);
    }

    async function onText(text) {
      let m; try { m = JSON.parse(text); } catch (e) { return; }
      if (m.k === 'stop') { close(1000); return; }
      if (m.k !== 'start' || state !== 'new') return;
      clearTimeout(startTimer);
      state = 'auth';
      if (!safeEqual(m.token, cfg.token)) {
        log('codice di accesso errato da ' + who);
        await new Promise((r) => setTimeout(r, 1000));
        fail('Codice di accesso non valido.', true, 1008); return;
      }
      if (active.size >= cfg.maxSessions) { fail('C\'è già una diretta in corso su questo convertitore.', true, 1013); return; }
      const t = validateTarget(m.url, m.key, cfg.hosts);
      if (!t.ok) { fail(t.error, true, 1008); return; }
      secrets.push(t.key, t.out, cfg.token);
      target = t; bitrate = Number(m.bitrate) || bitrate; compat = m.compat === true;
      active.add(id); counted = true; startedAt = Date.now();
      state = 'head';
      send({ k: 'ready' });
      log('avvio da ' + who + ' verso ' + t.host);
      headTimer = setTimeout(() => fail('Dal telefono non arriva video (la registrazione per la diretta non è partita).', false), cfg.noDataMs);   // il primo pezzo può farsi attendere
      watchdog = setInterval(() => { if (Date.now() - lastData > cfg.idleMs) fail('Dal telefono non arriva più video.', false); }, 5000);
    }
    ws.on('message', (data, isBinary) => {
      if (!isBinary) { onText(data.toString()); return; }
      if (state === 'new' || state === 'auth') { close(1008); return; }
      lastData = Date.now();
      if (state === 'head') {
        const first = headLen === 0;
        head.push(Buffer.from(data)); headLen += data.length;
        // da qui si aspetta ancora poco: o c'è abbastanza video, o l'MP4 ha già tutta l'intestazione (ftyp + moov), o passa il tempo
        if (headLen >= cfg.headBytes || mp4InitComplete(Buffer.concat(head))) begin();
        else if (first) { clearTimeout(headTimer); headTimer = setTimeout(begin, cfg.headWaitMs); }
        return;
      }
      if (state === 'live') write(Buffer.from(data));
    });
    ws.on('close', () => close(1000));
    ws.on('error', () => close(1011));
  }

  return new Promise((resolve) => {
    server.listen(cfg.port, () => resolve({
      port: server.address().port, active, ffmpeg: ffOk, tls: !!cfg.tls,
      close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); server.close(r); }),
    }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  try {
    // TLS_CERT e TLS_KEY (percorsi dei file PEM): il convertitore risponde in https/wss da solo, senza reverse proxy
    let tls = null;
    if (env.TLS_CERT || env.TLS_KEY) {
      if (!env.TLS_CERT || !env.TLS_KEY) throw new Error('TLS_CERT e TLS_KEY vanno scritti insieme.');
      try { tls = { cert: fs.readFileSync(env.TLS_CERT), key: fs.readFileSync(env.TLS_KEY) }; }
      catch (e) { throw new Error('Non riesco a leggere il certificato (' + env.TLS_CERT + ', ' + env.TLS_KEY + '): ' + e.code + '. Controlla la cartella certs e che i file siano leggibili.'); }
    }
    // certificato pubblico della CA (make-cert.sh lo copia accanto a quello del server): si scarica da /ca.crt
    let caCert = null;
    const caPath = env.CA_FILE || (env.TLS_CERT ? path.join(path.dirname(env.TLS_CERT), 'volleylive-ca.crt') : '');
    if (caPath) { try { caCert = fs.readFileSync(caPath); } catch (e) { /* non c'è: /ca.crt non viene offerto */ } }
    const r = await startStream({
      tls, caCert, port: +env.PORT || 8080, token: env.STREAM_TOKEN, origins: parseList(env.ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, '')),
      hosts: [...DEFAULT_HOSTS, ...parseList(env.ALLOWED_HOSTS)], maxSessions: +env.MAX_SESSIONS || 1, mode: env.MODE, log: (m) => console.log(new Date().toISOString() + ' ' + m),
    });
    console.log('Convertitore in ascolto sulla porta ' + r.port + (r.tls ? ' (https/wss)' : ' (http/ws: dalla pagina https serve un certificato, vedi README)') + (r.ffmpeg ? '' : ' (ffmpeg MANCANTE)'));
    const bye = () => r.close().then(() => process.exit(0));
    process.on('SIGTERM', bye); process.on('SIGINT', bye);
  } catch (e) { console.error(e.message); process.exit(1); }
}
