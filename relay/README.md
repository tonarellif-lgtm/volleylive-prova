# Relay del telecomando

Piccolo servizio che inoltra i messaggi tra il telefono con la camera e il telecomando, quando non c'è Wi-Fi e tutti e due
usano la rete dati. **Non vede niente**: i messaggi sono cifrati dai telefoni (AES-GCM) con una chiave ricavata dal codice,
e la stanza si chiama con un valore ricavato dal codice, non col codice. Il relay tiene in memoria solo l'ultimo messaggio
cifrato, per dare lo stato a un telecomando che si collega dopo.

## Installazione su Cloudflare (piano gratuito)

1. Crea un account gratuito su <https://dash.cloudflare.com>.
2. Da questa cartella: `npm install`, poi `npx wrangler login`.
3. In `wrangler.toml` metti in `ALLOWED_ORIGINS` l'indirizzo della tua pagina, senza barra finale
   (per esempio `https://nome.github.io`). Le pagine di altri indirizzi vengono rifiutate; con la riga vuota passano tutte.
4. `npx wrangler deploy`. Alla fine stampa l'indirizzo, del tipo `https://volleylive-relay.NOME.workers.dev`.
5. Nella pagina di VolleyLive: «⋯ Altro» → Telecomando → «Indirizzo del servizio»: scrivi lo stesso indirizzo con `wss://`
   davanti al posto di `https://`. Si scrive una volta sola. In alternativa lo si mette in `DEFAULT_RELAY` dentro `remote.js`.

Una partita usa poche centinaia di messaggi, molto sotto i limiti del piano gratuito (i limiti attuali sono sul sito Cloudflare).

## Su un server proprio

`npm install && PORT=8787 ALLOWED_ORIGINS="https://nome.github.io" node server.mjs`. Dalle pagine https il browser accetta solo
`wss://`, quindi il server va messo dietro HTTPS (Caddy, nginx, Cloudflare Tunnel…).

## Protocollo

WebSocket su `/r/<stanza di 32 caratteri esadecimali>`. Messaggi in JSON:
- dal telefono: `{"t":"m","d":"<cifrato>","keep":true|false}` (inoltra; con `keep` il relay tiene l'ultimo per chi arriva dopo) e `{"t":"ping"}`;
- verso il telefono: `{"t":"hello","n":<collegati>,"last":<ultimo|null>}`, `{"t":"peers","n":<collegati>}`, `{"t":"m","d":"<cifrato>"}`, `{"t":"pong"}`.

Limiti: 8 collegati per stanza, messaggi fino a 16 KB, 40 messaggi al secondo per collegato. La logica è in `room.js` e la usano
sia `server.mjs` sia `worker.js`.

## Prove

- `node --test ../tests/relay.test.mjs` (dopo `npm install`): stanza, cifratura, riconnessione, server vero.
- Il Worker si prova in locale con `npx wrangler dev --local --port 8788`, con lo stesso motore (workerd) dell'hosting.
