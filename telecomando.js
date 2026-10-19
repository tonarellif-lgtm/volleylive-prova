// Pagina del telecomando: mostra lo stato del telefono con la camera e gli manda i comandi (vedi remote.js e app.js).
import { deriveKeys, normalizeCode, normalizeRelay, parseJoin, showCode, DEFAULT_RELAY, Link } from './remote.js';

const $ = (id) => document.getElementById(id);
const KEY = 'vl-telecomando-v1';
const STALE_MS = 13000;     // il telefono con la camera manda lo stato almeno ogni 5 s
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
const save = (o) => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* memoria non disponibile */ } };

const R = { link: null, state: null, stateAt: 0, replay: false, pending: null, seq: 0, sid: Math.random().toString(36).slice(2, 10), toastTimer: null, wake: null };

// ---------------------------------------------------------------- avvisi e comandi
function toast(t) {
  const el = $('toast'); el.textContent = t; el.classList.add('show');
  clearTimeout(R.toastTimer); R.toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
const online = () => !!(R.link && R.link.status.connected && R.state && Date.now() - R.stateAt < STALE_MS);

function send(c, extra = {}) {
  if (!online()) { toast('Non sono collegato al telefono con la camera'); return; }
  if (R.pending) return;
  const seq = ++R.seq;
  R.pending = { seq, timer: setTimeout(() => { if (R.pending && R.pending.seq === seq) { R.pending = null; toast('Nessuna risposta dal telefono con la camera'); render(); } }, 4000) };
  if (navigator.vibrate) navigator.vibrate(25);
  R.link.send({ k: 'cmd', sid: R.sid, seq, c, ...extra }).then((ok) => { if (!ok) { clearTimeout(R.pending.timer); R.pending = null; toast('Non inviato: connessione persa'); render(); } });
  render();
}
function onMessage(m, info) {
  if (m.k === 'state') {
    R.state = m; R.replay = !!info.replay;
    R.stateAt = info.replay ? Math.min(Date.now(), m.ts || 0) : Date.now();   // un vecchio stato conservato dal relay non dimostra che la camera sia viva
    render();
  } else if (m.k === 'toast' && !info.replay) toast(m.text);
  else if (m.k === 'ack' && m.sid === R.sid && R.pending && R.pending.seq === m.seq) {
    clearTimeout(R.pending.timer); R.pending = null;
    if (!m.ok && m.msg) toast(m.msg);
    render();
  }
}

// ---------------------------------------------------------------- disegno
const nm = (t, d) => (t && t.name) || d;
function render() {
  const s = R.state, up = online(), linked = !!R.link;
  $('join').hidden = linked;
  const conn = $('conn');
  if (!linked) { conn.dataset.s = 'warn'; $('connTxt').textContent = 'Non collegato'; }
  else if (!R.link.status.connected) { conn.dataset.s = 'bad'; $('connTxt').textContent = 'Connessione persa, riprovo…'; }
  else if (!s) { conn.dataset.s = 'warn'; $('connTxt').textContent = 'Aspetto il telefono con la camera…'; }
  else if (!up) { conn.dataset.s = 'warn'; $('connTxt').textContent = 'La camera non risponde (ultimo dato ' + Math.round((Date.now() - R.stateAt) / 1000) + ' s fa)'; }
  else { conn.dataset.s = 'ok'; $('connTxt').textContent = 'Collegato alla camera'; }

  const started = !!(s && s.started);
  $('board').hidden = !started; $('pad').hidden = !started; $('recent').hidden = !started; $('status').hidden = !started;
  const emp = $('empty');
  emp.hidden = !linked || started;
  if (emp.hidden === false) emp.textContent = !s ? 'In attesa del telefono con la camera. Aprilo sulla pagina di VolleyLive e premi «Collega un telecomando» nella scheda «⋯ Altro».' : 'La partita non è ancora cominciata sul telefono con la camera.';
  if (!started) { $('setTxt').textContent = ''; return; }

  document.documentElement.style.setProperty('--teamA', (s.a && s.a.color) || '#2f6fed');
  document.documentElement.style.setProperty('--teamB', (s.b && s.b.color) || '#e8590c');
  $('tA').style.setProperty('--c', (s.a && s.a.color) || '#2f6fed'); $('tB').style.setProperty('--c', (s.b && s.b.color) || '#e8590c');
  $('nA').textContent = nm(s.a, 'Squadra A'); $('nB').textContent = nm(s.b, 'Squadra B');
  $('pA').textContent = s.pa; $('pB').textContent = s.pb;
  $('sA').textContent = 'set vinti ' + s.sa + (s.serving === 'a' ? ' · batte' : ''); $('sB').textContent = 'set vinti ' + s.sb + (s.serving === 'b' ? ' · batte' : '');
  $('sA').classList.toggle('srv', s.serving === 'a'); $('sB').classList.toggle('srv', s.serving === 'b');
  $('setTxt').textContent = s.finished ? 'Partita finita' : 'Set ' + s.set;
  $('status').textContent = s.status || '';
  const rc = $('recent'); rc.textContent = '';
  (s.recent || []).forEach((r) => {
    const c = document.createElement('span'); c.className = 'chip' + (r.doubt ? ' doubt' : '');
    c.style.setProperty('--c', r.side === 'a' ? (s.a && s.a.color) || '#2f6fed' : (s.b && s.b.color) || '#e8590c');
    c.textContent = r.a + '–' + r.b + (r.auto ? ' auto' : '') + (r.doubt ? ' ⚠' : '');
    rc.appendChild(c);
  });
  $('bAn').textContent = nm(s.a, 'A'); $('bBn').textContent = nm(s.b, 'B');
  const busy = !!R.pending || !up;
  $('bA').disabled = busy || s.finished; $('bB').disabled = busy || s.finished;
  $('bVia').disabled = busy || s.finished; $('bScore').disabled = busy || s.finished;
  $('bSubA').disabled = busy || s.finished || !s.pa; $('bSubB').disabled = busy || s.finished || !s.pb;
  $('bEnd').disabled = busy;
  $('bUndo').disabled = busy || !s.canUndo;
  $('auto').disabled = busy; if (!R.pending) $('auto').checked = !!s.auto;
}

// ---------------------------------------------------------------- collegamento
async function connect(code, relay) {
  if (R.link) R.link.close();
  const { key, room } = await deriveKeys(code);
  R.state = null; R.stateAt = 0; R.pending = null;
  R.link = new Link({ relay, room, key, onMessage, onStatus: () => render() });
  R.link.open();
  save({ code, relay });
  history.replaceState(null, '', location.pathname + '#c=' + code + '&r=' + encodeURIComponent(relay));
  render();
}
$('join').onsubmit = async (e) => {
  e.preventDefault();
  const code = normalizeCode($('jCode').value), relay = normalizeRelay($('jRelay').value || DEFAULT_RELAY);
  if (!code) { $('jErr').textContent = 'Il codice ha 8 caratteri (lettere e cifre, senza 0, 1, O, I, L).'; return; }
  if (!relay) { $('jErr').textContent = 'Serve anche l\'indirizzo del servizio (wss://…).'; return; }
  $('jErr').textContent = '';
  await connect(code, relay);
};
$('jCode').oninput = () => { $('jCode').value = $('jCode').value.toUpperCase(); };
$('bA').onclick = () => send('addA');
$('bB').onclick = () => send('addB');
$('bUndo').onclick = () => send('undo');
$('bVia').onclick = () => send('via');
$('bSubA').onclick = () => send('subA');
$('bSubB').onclick = () => send('subB');
$('bEnd').onclick = () => {
  if (online() && !confirm('Terminare la partita? Sul telefono con la camera il punteggio e la revisione dei punti vengono cancellati e l\'eventuale registrazione si ferma (resta da salvare lì) e l\'eventuale diretta si interrompe.')) return;
  send('end');
};
$('auto').onchange = () => send('auto', { on: $('auto').checked });
$('bScore').onclick = () => {
  const s = R.state; if (!s || !online()) return;
  const r = prompt('Punteggio del set, come sul tabellone (' + nm(s.a, 'A') + ' – ' + nm(s.b, 'B') + '), es. 12-9', s.pa + '-' + s.pb);
  if (r === null) return;
  const m = r.match(/(\d+)\D+(\d+)/);
  if (!m) { toast('Scrivi due numeri, per esempio 12-9'); return; }
  send('score', { a: parseInt(m[1], 10), b: parseInt(m[2], 10) });
};

// "camera non risponde" va aggiornato anche quando non arriva niente
setInterval(() => { if (R.link) render(); }, 2000);
// schermo acceso finché si usa il telecomando
const wake = async () => { try { if ('wakeLock' in navigator && document.visibilityState === 'visible') R.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* non disponibile */ } };
document.addEventListener('visibilitychange', wake); wake();

(function start() {
  const fromLink = parseJoin(location.hash), saved = load();
  const code = fromLink.code || saved.code, relay = fromLink.relay || saved.relay || normalizeRelay(DEFAULT_RELAY);
  if (saved.relay) $('jRelay').value = saved.relay;
  if (fromLink.relay || saved.relay) $('jRelayRow').hidden = true;
  if (code && relay) { connect(code, relay); return; }
  if (code) $('jCode').value = showCode(code);
  render();
})();
window.__tc = R;
