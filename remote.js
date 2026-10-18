// Telecomando: codice, cifratura e collegamento al relay. Funziona nel browser e in Node (prove).
// I messaggi tra i due telefoni sono cifrati con una chiave ricavata dal codice (AES-GCM): il relay vede solo testo illeggibile
// e un nome di stanza ricavato dal codice, non il codice.

// Indirizzo del relay usato se non se ne scrive uno nella pagina. Dopo aver installato relay/ si può mettere qui, per esempio
// 'wss://volleylive-relay.nome.workers.dev', e i link del telecomando non richiedono altro.
export const DEFAULT_RELAY = '';

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // senza 0 O 1 I L: si legge e si detta senza errori
export const CODE_LEN = 8;                             // 31^8 ≈ 40 bit

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u8) => [...u8].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Codice casuale uniforme (campionamento con scarto, niente distorsione). */
export function makeCode() {
  let out = '';
  while (out.length < CODE_LEN) {
    const buf = crypto.getRandomValues(new Uint8Array(16));
    for (const x of buf) if (x < 248 && out.length < CODE_LEN) out += ALPHABET[x % 31];   // 248 = 8·31
  }
  return out;
}
export const showCode = (c) => c.slice(0, 4) + '-' + c.slice(4);
/** Normalizza ciò che l'utente scrive; null se non è un codice valido. */
export function normalizeCode(text) {
  const c = String(text || '').toUpperCase().replace(/[\s-]/g, '');
  return c.length === CODE_LEN && [...c].every((x) => ALPHABET.includes(x)) ? c : null;
}

/** Dal codice: nome della stanza (32 caratteri esadecimali) e chiave AES-GCM. */
export async function deriveKeys(code) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: new TextEncoder().encode('volleylive-relay-v1') }, base, 384));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, room: hex(bits.slice(32, 48)) };
}
export async function encrypt(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64(out);
}
/** Oggetto, oppure null se il messaggio non è cifrato con questa chiave o è rovinato. */
export async function decrypt(key, text) {
  try {
    const u = unb64(text);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, key, u.slice(12));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (e) { return null; }
}

/** Indirizzo del relay in forma wss://host (accetta anche https://host). null se non valido. */
export function normalizeRelay(text) {
  let s = String(text || '').trim().replace(/\/+$/, '');
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = 'wss://' + s;
  s = s.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
  try { const u = new URL(s); return (u.protocol === 'wss:' || u.protocol === 'ws:') && u.host ? u.protocol + '//' + u.host + u.pathname.replace(/\/+$/, '') : null; } catch (e) { return null; }
}
/** Link da dare al telecomando: porta con sé codice e indirizzo del relay (nella parte dopo il #, che non va ai server). */
export function joinUrl(pageUrl, code, relay) {
  const u = new URL('telecomando.html', pageUrl);
  u.search = ''; u.hash = 'c=' + code + '&r=' + encodeURIComponent(relay);
  return u.toString();
}
export function parseJoin(hash) {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  return { code: normalizeCode(p.get('c')), relay: normalizeRelay(p.get('r')) };
}

/** Chi riceve i comandi scarta quelli già visti (un messaggio rimandato dal relay non deve contare due volte). */
export class ReplayGuard {
  constructor(max = 20) { this.max = max; this.seen = new Map(); }
  accept(sid, seq) {
    if (typeof sid !== 'string' || !Number.isInteger(seq)) return false;
    const last = this.seen.get(sid);
    if (last !== undefined && seq <= last) return false;
    this.seen.delete(sid); this.seen.set(sid, seq);
    if (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value);
    return true;
  }
}

/**
 * Collegamento al relay con riconnessione automatica. I telefoni mobili perdono la connessione senza avvisare:
 * ogni `pingMs` si manda un ping e, se per `deadMs` non arriva nulla, si chiude e si riprova.
 * onMessage(obj, { replay })  replay=true: è l'ultimo stato conservato dal relay, non un messaggio nuovo
 * onStatus({ connected, peers })    onOpen()  a ogni (ri)collegamento
 */
export class Link {
  constructor({ relay, room, key, WS = globalThis.WebSocket, onMessage = () => {}, onStatus = () => {}, onOpen = () => {}, pingMs = 20000, deadMs = 50000, backoff = [500, 1000, 2000, 4000, 8000] }) {
    Object.assign(this, { relay, room, key, WS, onMessage, onStatus, onOpen, pingMs, deadMs, backoff });
    this.ws = null; this.status = { connected: false, peers: 0 }; this.tries = 0; this.closed = true; this.lastRx = 0;
  }
  open() {
    if (!this.closed) return;
    this.closed = false; this._connect();
  }
  close() {
    this.closed = true; clearTimeout(this.retry); clearInterval(this.beat);
    if (this.ws) { try { this.ws.close(1000); } catch (e) { /* già chiuso */ } }
    this.ws = null; this._set({ connected: false, peers: 0 });
  }
  _set(s) { this.status = { ...this.status, ...s }; this.onStatus(this.status); }
  _connect() {
    clearTimeout(this.retry);
    let ws;
    try { ws = new this.WS(this.relay + '/r/' + this.room); } catch (e) { this._again(); return; }
    this.ws = ws; this.lastRx = Date.now();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.tries = 0; this.lastRx = Date.now(); this._set({ connected: true });
      clearInterval(this.beat);
      this.beat = setInterval(() => {
        if (Date.now() - this.lastRx > this.deadMs) { try { ws.close(); } catch (e) { /* idem */ } return; }
        try { ws.send('{"t":"ping"}'); } catch (e) { /* idem */ }
      }, this.pingMs);
      this.onOpen();
    };
    ws.onmessage = async (ev) => {
      if (this.ws !== ws) return;
      this.lastRx = Date.now();
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'hello' || m.t === 'peers') this._set({ peers: m.n });
      if (m.t === 'hello' && m.last) { const o = await decrypt(this.key, m.last); if (o) this.onMessage(o, { replay: true }); }
      if (m.t === 'm') { const o = await decrypt(this.key, m.d); if (o) this.onMessage(o, { replay: false }); }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearInterval(this.beat); this.ws = null;
      this._set({ connected: false, peers: 0 });
      if (!this.closed) this._again();
    };
    ws.onerror = () => {};
  }
  _again() {
    const wait = this.backoff[Math.min(this.tries++, this.backoff.length - 1)];
    this.retry = setTimeout(() => { if (!this.closed) this._connect(); }, wait);
  }
  /** Cifra e manda. keep=true: il relay tiene l'ultimo, per chi si collega dopo. Restituisce false se non è collegato. */
  async send(obj, keep = false) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    const d = await encrypt(this.key, obj);
    try { ws.send(JSON.stringify({ t: 'm', d, keep })); return true; } catch (e) { return false; }
  }
}
