# Relay del telecomando

Piccolo servizio che inoltra i messaggi tra il telefono con la camera e il telecomando, quando non c'è Wi-Fi e tutti e due
usano la rete dati. **Non vede niente**: i messaggi sono cifrati dai telefoni (AES-GCM) con una chiave ricavata dal codice,
e la stanza si chiama con un valore ricavato dal codice, non col codice. Il relay tiene in memoria solo l'ultimo messaggio
cifrato, per dare lo stato a un telecomando che si collega dopo.

## Installazione da GitHub (consigliata)

Il repository della pagina contiene `.github/workflows/deploy-relay.yml`: installa il relay su Cloudflare e, da allora,
ogni modifica alla cartella `relay/` si installa da sola. Il token resta nei segreti di GitHub e nessuno lo vede.

1. Account gratuito su <https://dash.cloudflare.com>. La prima volta Cloudflare chiede di scegliere il sottodominio
   `workers.dev` (nella sezione Workers & Pages; il nome della voce può cambiare): senza, l'installazione si ferma con un errore.
2. Token: My Profile → API Tokens → Create Token → modello «Edit Cloudflare Workers», scegli il tuo account, crea e copia il
   token (si vede una volta sola).
3. Id dell'account: Workers & Pages → Overview, a destra («Account ID»).
4. Su GitHub, nel repository della pagina: Settings → Secrets and variables → Actions → New repository secret. Ne servono due,
   con questi nomi: `CLOUDFLARE_API_TOKEN` (il token) e `CLOUDFLARE_ACCOUNT_ID` (l'id).
5. Actions → «Installa il relay del telecomando» → Run workflow. A fine lavoro il riepilogo mostra l'indirizzo da usare,
   già con `wss://` davanti: va scritto nel campo «Indirizzo del servizio» del telefono con la camera (una volta sola).
6. Controlla `ALLOWED_ORIGINS` in `wrangler.toml`: deve essere l'indirizzo della tua pagina (ora `https://tonarellif-lgtm.github.io`).

Il token del modello «Edit Cloudflare Workers» permette di modificare i Worker dell'account: tienilo solo nei segreti e
revocalo dal pannello Cloudflare se non serve più. Senza i segreti il lavoro finisce senza errori e dice cosa manca.

## Installazione dal tuo computer

1. Crea un account gratuito su <https://dash.cloudflare.com> (e scegli il sottodominio `workers.dev`, vedi sopra).
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
