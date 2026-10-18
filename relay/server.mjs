// Relay in Node: node server.mjs   (porta con PORT, default 8787)
// Serve per le prove e per chi preferisce un proprio server; sul Cloudflare si usa worker.js (stessa logica).
// ALLOWED_ORIGINS="https://nome.github.io,http://localhost:8123": se impostato, accetta solo pagine di quegli indirizzi.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { RoomCore, ROOM_ID, LIMITS } from './room.js';

export function startRelay({ port = +process.env.PORT || 8787, origins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean), limits = {}, idleMs = 30 * 60 * 1000 } = {}) {
  const rooms = new Map();           // id -> { core, timer }
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('volleylive relay ok\n');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxBytes || LIMITS.maxBytes });
  server.on('upgrade', (req, socket, head) => {
    const m = /^\/r\/([^/?#]+)/.exec(req.url || '');
    const origin = req.headers.origin;
    if (!m || !ROOM_ID.test(m[1])) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    if (origins.length && !(origin && origins.includes(origin))) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, m[1]));
  });
  function attach(ws, id) {
    let room = rooms.get(id);
    if (!room) { room = { core: new RoomCore(limits), timer: null }; rooms.set(id, room); }
    clearTimeout(room.timer);
    const peer = { send: (t) => { if (ws.readyState === 1) ws.send(t); }, close: (c, r) => ws.close(c, r) };
    if (!room.core.join(peer)) return;
    ws.on('message', (data, isBinary) => { if (isBinary) { ws.close(1003, 'solo testo'); return; } room.core.message(peer, data.toString()); });
    ws.on('close', () => {
      room.core.leave(peer);
      if (room.core.size === 0) { room.timer = setTimeout(() => { if (room.core.size === 0) rooms.delete(id); }, idleMs); room.timer.unref(); }
    });
    ws.on('error', () => {});
  }
  return new Promise((resolve) => server.listen(port, () => resolve({
    port: server.address().port, rooms,
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); rooms.forEach((x) => clearTimeout(x.timer)); server.close(r); }),
  })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await startRelay();
  console.log('relay in ascolto sulla porta ' + r.port);
}
