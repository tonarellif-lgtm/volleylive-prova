// Prova del relay installato: node smoke.mjs wss://indirizzo [origine]
// Due collegati nella stessa stanza di prova: ultimo stato conservato, conteggio, inoltro nei due sensi, origine non ammessa.
import WS from 'ws';
import { randomBytes } from 'node:crypto';

const [relay, origin = process.env.SMOKE_ORIGIN || 'https://tonarellif-lgtm.github.io'] = process.argv.slice(2);
if (!relay) { console.error('uso: node smoke.mjs wss://indirizzo [origine]'); process.exit(2); }
const room = randomBytes(16).toString('hex');
const url = relay.replace(/\/+$/, '') + '/r/' + room;
const fail = (m) => { console.error('ERRORE: ' + m); process.exit(1); };
const timer = setTimeout(() => fail('nessuna risposta entro 20 s'), 20000);

function open(name, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WS(url, { headers });
    const got = [];
    ws.on('message', (d) => got.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, got, name }));
    ws.on('unexpected-response', (q, s) => { q.destroy(); reject(Object.assign(new Error('HTTP ' + s.statusCode), { status: s.statusCode })); });
    ws.on('error', (e) => reject(e));
  });
}
const until = async (f, what) => { const t = Date.now(); while (Date.now() - t < 8000) { if (f()) return; await new Promise((r) => setTimeout(r, 25)); } fail('manca: ' + what); };
const send = (c, o) => c.ws.send(JSON.stringify(o));

const a = await open('A', { origin });
await until(() => a.got.some((m) => m.t === 'hello' && m.n === 1 && m.last === null), 'hello del primo collegato');
send(a, { t: 'm', d: 'stato-prova', keep: true });
await new Promise((r) => setTimeout(r, 300));
const b = await open('B', { origin });
await until(() => b.got.some((m) => m.t === 'hello' && m.n === 2 && m.last === 'stato-prova'), 'ultimo stato conservato dato a chi arriva dopo');
await until(() => a.got.some((m) => m.t === 'peers' && m.n === 2), 'il primo vede il secondo');
send(b, { t: 'm', d: 'comando-prova' });
await until(() => a.got.some((m) => m.t === 'm' && m.d === 'comando-prova'), 'messaggio da B ad A');
send(a, { t: 'm', d: 'risposta-prova' });
await until(() => b.got.some((m) => m.t === 'm' && m.d === 'risposta-prova'), 'messaggio da A a B');
send(a, { t: 'ping' });
await until(() => a.got.some((m) => m.t === 'pong'), 'pong');
a.ws.close(); b.ws.close();
console.log('OK: inoltro, ultimo stato, conteggio e ping funzionano su ' + relay);

// una pagina di un altro indirizzo deve essere rifiutata (se ALLOWED_ORIGINS è impostata)
try {
  const c = await open('C', { origin: 'https://non-ammesso.invalid' });
  c.ws.close();
  console.log('ATTENZIONE: una pagina di un altro indirizzo è stata accettata (ALLOWED_ORIGINS vuota?)');
} catch (e) {
  if (e.status === 403) console.log('OK: le pagine di altri indirizzi sono rifiutate (403)');
  else fail('prova dell\'origine: ' + e.message);
}
clearTimeout(timer);
process.exit(0);
