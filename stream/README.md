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

1. In **File Station** crea la cartella `docker/volleylive_stream` e copia dentro il contenuto di `web/stream/` (`Dockerfile`, `docker-compose.yml`, `package.json`, `package-lock.json`, `lib.js`, `server.mjs`, `healthcheck.mjs`, `make-cert.sh`, `.env.example` e la cartella vuota `certs`). Non servono `node_modules`.
2. Copia `.env.example` in un file chiamato `.env` (stessa cartella) e scrivi un **codice di accesso lungo e casuale** al posto di `scrivi-qui-un-codice-lungo-e-casuale`. Per generarlo: `openssl rand -hex 16`, oppure il generatore del tuo gestore di password. Lo stesso codice va poi nella pagina VolleyLive.
3. **Container Manager → Progetto → Crea**: nome `volleylive_stream`, percorso `/volume1/docker/volleylive_stream`, «Usa docker-compose.yml esistente». Avvia il progetto: la prima volta costruisce l'immagine (qualche minuto, scarica Node e ffmpeg).
   Da SSH, in alternativa: `cd /volume1/docker/volleylive_stream && sudo docker compose up -d --build`.
4. Prova: apri `http://IP-DEL-NAS:8090/health` (`https://…` se hai attivato il certificato). Deve rispondere `{"ok":true,"ffmpeg":true,"sessions":0}`. `ffmpeg:false` vuol dire che dentro l'immagine ffmpeg non c'è (la costruzione non è andata a buon fine).

La porta del NAS è `8090` (si cambia nella riga `ports` di `docker-compose.yml`).

## Come ci arriva il telefono (la parte che conta)

La pagina VolleyLive è su `https://` e anche la camera del telefono vuole `https://`. Una pagina https **non può** aprire un `ws://` normale (il browser lo blocca come «contenuto misto»): serve un indirizzo **`wss://` con un certificato che il telefono considera valido** per quell'indirizzo. Due strade.

### A) Con la VPN, dall'indirizzo IP (il caso più semplice se ci arrivi già così)

Nessuna autorità pubblica rilascia certificati per un indirizzo privato, quindi ne fai una tua, piccola, che vale **solo per quell'indirizzo** e che installi una volta sul telefono. Il convertitore parla poi https/wss da solo, senza reverse proxy.

1. **Crea il certificato.** In SSH sul NAS (oppure su un Mac/Linux, o da WSL/Git Bash su Windows), dalla cartella del progetto:
   ```
   cd /volume1/docker/volleylive_stream
   sh make-cert.sh 10.8.0.1
   ```
   al posto di `10.8.0.1` scrivi l'indirizzo con cui raggiungi il NAS **dalla VPN** (se lo raggiungi anche con un altro indirizzo, per esempio quello di casa, scrivili tutti: `sh make-cert.sh 10.8.0.1 192.168.1.20`). Se lo fai su un altro computer, copia poi sul NAS la cartella `certs` (e tieni da parte `ca`).
   Lo script crea `certs/server.crt` e `certs/server.key` per il convertitore, e `ca/volleylive-ca.crt` da installare sul telefono. La CA ha un vincolo di nome: anche se qualcuno ne rubasse la chiave non potrebbe certificare altri siti. Il certificato dura 825 giorni (circa 2 anni e 3 mesi).
2. **Dillo al convertitore.** Nel file `.env` togli il `#` dalle due righe `TLS_CERT=/certs/server.crt` e `TLS_KEY=/certs/server.key`, poi ferma e riavvia il progetto.
3. **Installa la CA sul telefono, una volta sola.**
   - **iPhone**: porta `ca/volleylive-ca.crt` sul telefono (AirDrop, una mail a te stesso, oppure scaricalo da File Station con Safari). Toccalo: «Profilo scaricato». Poi **Impostazioni → in alto «Profilo scaricato» → Installa**. Infine **Impostazioni → Generali → Info → Impostazioni attendibilità certificati** e attiva l'interruttore del certificato «VolleyLive CA». Senza quest'ultimo passaggio Safari non si fida.
   - **Android**: Impostazioni → Sicurezza (o «Crittografia e credenziali») → Installa un certificato → Certificato CA, e scegli il file.
4. **Controlla**: con la VPN accesa, apri nel browser del telefono `https://10.8.0.1:8090/health` (con il tuo indirizzo). Se vedi `{"ok":true,…}` senza avvisi, il certificato è a posto.
5. Nella pagina VolleyLive: «Indirizzo del convertitore» → `wss://10.8.0.1:8090`.
6. Quando hai finito sposta `ca/ca.key` in un posto sicuro (o cancellala): serve solo per rinnovare il certificato rilanciando lo script, e finché la CA è la stessa il telefono non deve reinstallare nulla. Se cambi gli indirizzi la CA è nuova e va reinstallata.

### B) Con un nome vero e un certificato pubblico (anche senza VPN)

Serve un nome raggiungibile da Internet e un certificato Let's Encrypt. Con un Synology (i nomi dei menu possono cambiare un po' tra le versioni di DSM):

1. **Nome**: Pannello di controllo → Accesso esterno → DDNS: registra un nome `tuonome.synology.me`.
2. **Certificato**: Pannello di controllo → Sicurezza → Certificato → Aggiungi → «Ottieni un certificato da Let's Encrypt» per quel nome. (Serve che la porta 80 raggiunga il NAS durante il rilascio.)
3. **Reverse proxy**: Pannello di controllo → Portale di accesso → Avanzate → Reverse Proxy → Crea.
   - Origine: HTTPS, host `stream.tuonome.synology.me`, porta `443` (o un'altra, per esempio `8443`)
   - Destinazione: HTTP, `localhost`, porta `8090`
   - Scheda «Intestazione personalizzata» → Crea → **WebSocket** (aggiunge le intestazioni `Upgrade`/`Connection`, senza non funziona)
   - Assegna il certificato di Let's Encrypt a questa regola (Impostazioni → Certificato).
4. **Router**: inoltra la porta scelta (443 o 8443) verso il NAS.
5. Nella pagina: `wss://stream.tuonome.synology.me` (con `:8443` in fondo se non usi la 443).

Se hai un dominio tuo, c'è una variante senza aprire porte: un record DNS `stream.tuodominio.it` che punta all'IP privato del NAS (per la VPN) e un certificato Let's Encrypt ottenuto con la verifica DNS (per esempio con `acme.sh`). Metti `fullchain.pem` e `privkey.pem` nella cartella `certs` (il file della chiave deve essere leggibile dall'utente del contenitore), scrivili in `TLS_CERT`/`TLS_KEY` e usa `wss://stream.tuodominio.it:8090`: nessuna CA da installare.

### Sicurezza

Non esporre la porta `8090` su Internet senza certificato. Il convertitore si difende da solo: vuole il codice di accesso (confronto a tempo costante, e una pausa di 1 secondo a ogni codice sbagliato), accetta solo collegamenti dalla pagina indicata in `ALLOWED_ORIGINS` e solo server YouTube/Facebook (più quelli che aggiungi tu), e una sola diretta alla volta. `certs/`, `ca/` e `.env` non finiscono nell'immagine Docker né in Git.

## Impostazioni (file `.env`)

| Variabile | Cosa fa | Predefinito |
|---|---|---|
| `STREAM_TOKEN` | codice di accesso, **obbligatorio**: senza, il servizio non parte | — |
| `ALLOWED_ORIGINS` | pagine autorizzate (senza barra finale, separate da virgola). Se lo svuoti qualunque pagina può collegarsi, resta solo il codice | `https://tonarellif-lgtm.github.io` |
| `ALLOWED_HOSTS` | server RTMP oltre a YouTube e Facebook | vuoto |
| `MODE` | `auto` copia H.264/AAC; `transcode` ricodifica sempre | `auto` |
| `MAX_SESSIONS` | dirette contemporanee | `1` |
| `TLS_CERT`, `TLS_KEY` | percorsi (dentro il contenitore) del certificato e della chiave: il convertitore risponde in https/wss da solo | vuoti (http/ws) |

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
| «Non riesco a collegarmi al convertitore…» | indirizzo sbagliato; VPN spenta; certificato non valido (con l'IP: CA non installata o non resa attendibile in Impostazioni → Generali → Info → Impostazioni attendibilità certificati, oppure il tuo indirizzo non è tra quelli scritti con `make-cert.sh`: prova `https://INDIRIZZO:8090/health` nel browser del telefono); manca l'intestazione WebSocket nel reverse proxy; porta non inoltrata; oppure la pagina non è in `ALLOWED_ORIGINS` (nel registro compare «collegamento rifiutato: la pagina … non è in ALLOWED_ORIGINS») |
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
