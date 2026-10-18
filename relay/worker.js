// Relay su Cloudflare Workers (piano gratuito): ogni stanza è un Durable Object con le sue connessioni WebSocket.
// Rotta: wss://<nome>.<account>.workers.dev/r/<id stanza di 32 caratteri esadecimali>
// ALLOWED_ORIGINS (variabile in wrangler.toml, separata da virgole): se non è vuota accetta solo pagine di quegli indirizzi.
import { RoomCore, ROOM_ID, LIMITS } from './room.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = /^\/r\/([^/]+)$/.exec(url.pathname);
    if (!m) return new Response('volleylive relay ok\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (!ROOM_ID.test(m[1])) return new Response('stanza non valida', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('serve WebSocket', { status: 426 });
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin');
    if (allowed.length && !(origin && allowed.includes(origin))) return new Response('origine non ammessa', { status: 403 });
    return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(request);
  },
};

export class Room {
  constructor() { this.core = new RoomCore(); }
  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const peer = { send: (t) => server.send(t), close: (c, r) => server.close(c, r) };
    if (!this.core.join(peer)) return new Response(null, { status: 101, webSocket: client });
    server.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') { server.close(1003, 'solo testo'); return; }
      this.core.message(peer, e.data);
    });
    const gone = () => this.core.leave(peer);
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }
}
