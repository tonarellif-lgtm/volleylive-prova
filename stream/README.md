# Convertitore di diretta (YouTube, Facebook)

Il browser non sa parlare con YouTube e Facebook (usano RTMP, che una pagina web non può aprire). Questo piccolo servizio fa da ponte:

```
telefono con la camera ──(WebSocket cifrato, wss://)──► convertitore (Docker sul NAS) ──(RTMPS)──► YouTube / Facebook
 immagine col tabellone                                  ffmpeg
```

Il telefono manda l'immagine che si registra (col tabellone disegnato sopra) a pezzi da mezzo secondo; il convertitore li passa a ffmpeg, che li gira al servizio scelto. Se il telefono manda già H.264 + AAC (Safari su iPhone) ffmpeg **copia** senza ricodificare: quasi nessuna CPU. Se manda altro (Chrome, Android: WebM o VP9/Opus) ricodifica in H.264 + AAC con un fotogramma chiave ogni 2 secondi.

Non serve alcun account o servizio a pagamento: gira sul tuo NAS. La chiave della diretta va solo al convertitore che indichi tu e non viene mai scritta nel registro né rimandata al telefono.

## Che cosa serve

- Un NAS Synology con **Container Manager** (DSM 7.2) oppure il pacchetto Docker. Qualunque altro computer con Docker va bene lo stesso.
- Banda: la diretta passa due volte da una rete. Dal telefono al NAS (rete dati o Wi-Fi della palestra) e dal NAS a YouTube/Facebook (la linea di casa, in **upload**). Con la qualità «Media» servono circa 3 Mbit/s su tutti e due i tratti, con margine.
- CPU: in modalità «copia» è trascurabile. Se ricodifica (Chrome/Android) in una prova con un video semplice un 1080p a 3 Mbit/s è costato circa mezzo core di un normale processore Intel; con immagini più complesse e CPU lente (NAS ARM economici) può essere molto di più. Se il NAS non regge, la pagina te lo dice («il convertitore non riesce a stare dietro al video»): usa un iPhone (copia senza ricodificare) o abbassa la qualità.

## Installazione sul Synology

1. In **File Station** crea la cartella `docker/volleylive_stream` e copia dentro il contenuto di `web/stream/` (`Dockerfile`, `docker-compose.yml`, `package.json`, `package-lock.json`, `lib.js`, `server.mjs`, `.env.example`). Non servono `node_modules`.
2. Copia `.env.example` in un file chiamato `.env` (stessa cartella) e scrivi un **codice di accesso lungo e casuale** al posto di `scrivi-qui-un-codice-lungo-e-casuale`. Per generarlo: `openssl rand -hex 16`, oppure il generatore del tuo gestore di password. Lo stesso codice va poi nella pagina VolleyLive.
3. **Container Manager → Progetto → Crea**: nome `volleylive_stream`, percorso `/volume1/docker/volleylive_stream`, «Usa docker-compose.yml esistente». Avvia il progetto: la prima volta costruisce l'immagine (qualche minuto, scarica Node e ffmpeg).
   Da SSH, in alternativa: `cd /volume1/docker/volleylive_stream && sudo docker compose up -d --build`.
4. Prova: apri `http://IP-DEL-NAS:8090/health`. Deve rispondere `{"ok":true,"ffmpeg":true,"sessions":0}`. `ffmpeg:false` vuol dire che dentro l'immagine ffmpeg non c'è (la costruzione non è andata a buon fine).

La porta del NAS è `8090` (si cambia nella riga `ports` di `docker-compose.yml`).

## Come ci arriva il telefono (la parte che conta)

La pagina VolleyLive è su `https://` e anche la camera del telefono vuole `https://`. Una pagina https **non può** aprire un `ws://` normale (il browser lo blocca come «contenuto misto»): serve un indirizzo **`wss://` con un certificato valido** per quel nome. Quindi `ws://192.168.1.20:8090` non funziona; serve un nome vero, per esempio `wss://stream.tuonome.synology.me`.

Strada più semplice con un Synology (i nomi dei menu possono cambiare un po' tra le versioni di DSM):

1. **Nome**: Pannello di controllo → Accesso esterno → DDNS: registra un nome `tuonome.synology.me`.
2. **Certificato**: Pannello di controllo → Sicurezza → Certificato → Aggiungi → «Ottieni un certificato da Let's Encrypt» per quel nome. (Serve che la porta 80 raggiunga il NAS durante il rilascio.)
3. **Reverse proxy**: Pannello di controllo → Portale di accesso → Avanzate → Reverse Proxy → Crea.
   - Origine: HTTPS, host `stream.tuonome.synology.me`, porta `443` (o un'altra, per esempio `8443`)
   - Destinazione: HTTP, `localhost`, porta `8090`
   - Scheda «Intestazione personalizzata» → Crea → **WebSocket** (aggiunge le intestazioni `Upgrade`/`Connection`, senza non funziona)
   - Assegna il certificato di Let's Encrypt a questa regola (Impostazioni → Certificato).
4. **Router**: inoltra la porta scelta (443 o 8443) verso il NAS.
5. Nella pagina VolleyLive → «⋯ Altro» → Diretta → «Indirizzo del convertitore»: `wss://stream.tuonome.synology.me` (con `:8443` in fondo se non usi la 443).

Con una **VPN** (come per le altre tue app) il discorso cambia poco: il telefono raggiunge il NAS, ma il browser vuole comunque un nome con certificato valido. Con la VPN accesa il nome DDNS deve arrivare al NAS (DNS interno o un nome dedicato) e il certificato deve valere per quel nome. Con l'indirizzo IP e senza certificato non si apre. Se ti trovi in palestra senza VPN, la diretta funziona solo se il nome è raggiungibile da Internet come sopra.

Non esporre mai la porta `8090` così com'è su Internet: passa dal reverse proxy con il certificato. Anche così il convertitore si difende da solo: vuole il codice di accesso (confronto a tempo costante, e una pausa di 1 secondo a ogni codice sbagliato), accetta solo collegamenti dalla pagina indicata in `ALLOWED_ORIGINS` e solo server YouTube/Facebook (più quelli che aggiungi tu), e una sola diretta alla volta.

## Impostazioni (file `.env`)

| Variabile | Cosa fa | Predefinito |
|---|---|---|
| `STREAM_TOKEN` | codice di accesso, **obbligatorio**: senza, il servizio non parte | — |
| `ALLOWED_ORIGINS` | pagine autorizzate (senza barra finale, separate da virgola). Se lo svuoti qualunque pagina può collegarsi, resta solo il codice | `https://tonarellif-lgtm.github.io` |
| `ALLOWED_HOSTS` | server RTMP oltre a YouTube e Facebook | vuoto |
| `MODE` | `auto` copia H.264/AAC; `transcode` ricodifica sempre | `auto` |
| `MAX_SESSIONS` | dirette contemporanee | `1` |

Dopo ogni modifica del `.env`: Container Manager → Progetto → ferma e avvia (oppure `docker compose up -d`).

## Usarlo

1. **YouTube**: YouTube Studio → Crea → Vai in diretta → «Stream»: copia la **chiave stream**. La diretta parte quando il video arriva (tieni aperta la pagina di YouTube Studio).
2. **Facebook**: Video in diretta → «Software di streaming»: copia la **chiave di streaming** (vale per una sola diretta).
3. Nella pagina VolleyLive: apri la camera, «⋯ Altro» → **Diretta** → scegli dove, incolla la chiave, scrivi indirizzo e codice del convertitore, scegli la qualità → **Vai in diretta**. In alto compare il tasto viola col tempo di diretta; toccalo per aprire i dettagli.
4. **Fine partita** ferma anche la diretta (chiede conferma e lo dice). Con «Ferma la diretta» si ferma solo la diretta.

Se la rete cade, la pagina riprova da sola con attese crescenti (2, 4, 8, 16, 30 secondi) e riparte con un nuovo inizio del file; chi guarda vede un salto ma la diretta riprende. Se la coda dei dati da spedire cresce troppo (più di circa 12 secondi) riparte da capo invece di accumulare ritardo: in quel caso scegli una qualità più bassa.

**Facebook** vuole un fotogramma chiave ogni 2 secondi o meno. Il video copiato direttamente dal telefono potrebbe averne meno spesso: se Facebook segnala problemi, attiva «Ricodifica sempre» nella pagina (oppure `MODE=transcode`).

## Se qualcosa non va

I messaggi del convertitore si leggono in Container Manager → Contenitore → `volleylive-stream` → Registro (oppure `docker logs volleylive-stream`). Le chiavi non compaiono mai.

| Messaggio nella pagina | Causa probabile |
|---|---|
| «Non riesco a collegarmi al convertitore…» | indirizzo sbagliato; VPN spenta; certificato non valido o non per quel nome; manca l'intestazione WebSocket nel reverse proxy; porta non inoltrata; oppure la pagina non è in `ALLOWED_ORIGINS` (nel registro compare «collegamento rifiutato: la pagina … non è in ALLOWED_ORIGINS») |
| «Codice di accesso non valido» | il codice nella pagina non è quello del `.env` (dopo averlo cambiato va riavviato il progetto) |
| «Questo convertitore non può trasmettere verso …» | server RTMP diverso da YouTube/Facebook: aggiungilo in `ALLOWED_HOSTS` |
| «C'è già una diretta in corso» | un'altra sessione (o una caduta di rete non ancora scaduta: attendi 20 secondi) |
| «… ha chiuso il collegamento: controlla server e chiave» | chiave sbagliata o scaduta, oppure la diretta non è ancora creata sul servizio |
| «Il convertitore non riesce a raggiungere …» | il NAS non esce verso Internet (DNS, firewall) |
| «Dal telefono non arriva video» | il telefono non ha avviato la registrazione (schermo bloccato, scheda in secondo piano) |

## Senza Docker, e prove

```
cd web/stream && npm ci
STREAM_TOKEN=un-codice node server.mjs        # serve ffmpeg installato; ascolta sulla porta 8080 (PORT per cambiarla)
cd .. && node --test tests/stream.test.mjs    # prove, con un ricevitore RTMP locale (serve ffmpeg)
```
