// Logica di una stanza del relay, uguale per il server Node (server.mjs) e per il Worker Cloudflare (worker.js).
// Il relay non capisce i messaggi: li inoltra agli altri collegati nella stanza. Il contenuto (`d`) è già cifrato dai telefoni.
//
// Messaggi dal telefono:   {"t":"m","d":"<cifrato>","keep":true|false}   inoltra; con keep l'ultimo viene dato a chi arriva dopo
//                          {"t":"ping"}                                    risponde {"t":"pong"}
// Messaggi verso il telefono: {"t":"hello","n":<collegati>,"last":<ultimo o null>}   appena collegato
//                             {"t":"peers","n":<collegati>}                           quando qualcuno entra o esce
//                             {"t":"m","d":"<cifrato>"}                               messaggio di un altro

export const LIMITS = {
  maxPeers: 8,          // collegati per stanza
  maxBytes: 16384,      // dimensione massima di un messaggio
  perSecond: 40,        // messaggi al secondo per collegato, oltre si chiude
};

export const ROOM_ID = /^[a-f0-9]{32}$/;

export class RoomCore {
  constructor(limits = {}) {
    this.limits = { ...LIMITS, ...limits };
    this.peers = new Set();
    this.last = null;
  }
  get size() { return this.peers.size; }

  /** `peer`: oggetto con send(testo) e close(codice, motivo). */
  join(peer) {
    if (this.peers.size >= this.limits.maxPeers) { peer.close(1013, 'stanza piena'); return false; }
    peer._rate = { start: 0, n: 0 };
    this.peers.add(peer);
    peer.send(JSON.stringify({ t: 'hello', n: this.peers.size, last: this.last }));
    this._peers(peer);
    return true;
  }

  message(peer, text, now = Date.now()) {
    if (!this.peers.has(peer)) return;
    if (typeof text !== 'string' || text.length > this.limits.maxBytes) { peer.close(1009, 'messaggio troppo grande'); return; }
    const r = peer._rate;
    if (now - r.start >= 1000) { r.start = now; r.n = 0; }
    if (++r.n > this.limits.perSecond) { peer.close(1008, 'troppi messaggi'); return; }
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'ping') { peer.send('{"t":"pong"}'); return; }
    if (m.t !== 'm' || typeof m.d !== 'string' || m.d.length > this.limits.maxBytes) return;
    if (m.keep === true) this.last = m.d;
    const out = JSON.stringify({ t: 'm', d: m.d });
    for (const p of this.peers) if (p !== peer) { try { p.send(out); } catch (e) { /* collegato chiuso: lo toglie leave() */ } }
  }

  leave(peer) {
    if (!this.peers.delete(peer)) return;
    this._peers(null);
  }

  _peers(except) {
    const out = JSON.stringify({ t: 'peers', n: this.peers.size });
    for (const p of this.peers) if (p !== except) { try { p.send(out); } catch (e) { /* idem */ } }
  }
}
