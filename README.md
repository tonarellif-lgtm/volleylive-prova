# VolleyLive web

Pagina che gira nel browser (Safari su iPhone): riprende la partita con la camera o analizza un video registrato,
riconosce chi sta alla battuta e assegna i punti da sola. Nessun server: tutto resta sul telefono.

## Come funziona

0. **Tutto schermo**: «Avvia la camera» apre subito la ripresa a tutto schermo, con i tasti sopra l'immagine:
   +1 per squadra ai lati (con un piccolo −1 sotto), Via / Punteggio / Annulla / Fine partita in basso, REC, «⋯» (punteggio
   del set, punti automatici, registrazione salvata) e ✕ per tornare alla pagina. «Punteggio» (accanto a Via, Annulla e Fine partita)
   serve a risincronizzarsi al volo: si scrive il punteggio del tabellone dell'arbitro, per esempio 12-9. Funziona in orizzontale e in verticale.
   Su iPhone Safari non esiste lo schermo intero vero per le pagine web: la pagina riempie l'area visibile e nasconde
   la propria interfaccia; per far sparire anche la barra di Safari: Condividi → «Aggiungi alla schermata Home» e
   aprirla da lì. Dove il browser lo permette (Android, iPad, computer) compare anche ⛶ per lo schermo intero.
1. **Sorgente**: camera, oppure un video già registrato (il video registrato si usa nella pagina normale).
2. **Il campo**: si toccano i 4 angoli del campo (prima i due del fondo «lato 1», poi i due del fondo opposto).
   Da lì la pagina ricava la posizione delle due zone di battuta. «Misura le persone» ricava l'altezza attesa
   delle giocatrici in ogni punto dell'immagine, quindi non serve una posizione di camera particolare.
3. **Partita**: nomi, colori, chi batte per prima. «Via» a ogni set dice alla pagina che si comincia.
4. **Punto automatico**: la battuta segue il punto, quindi ogni nuova battuta avvistata da un lato dà il punto alla
   squadra di quel lato. La prima battuta del set non è un punto. Se l'azione si ripete (contesa) e il punto è già stato dato, si toglie con −1.
5. **Correzioni**: +1, −1 (toglie l'ultimo punto di quella squadra nel set; se era un punto automatico, nella revisione
   risulta «tolto»), Annulla, «Imposta il punteggio del set» e, a fine partita, la tabella di revisione
   (▶︎ rivede il momento, ⇄ inverte il punto, ✕ lo toglie). **Fine partita** (con conferma) chiude la partita, cancella
   punteggio e revisione (prima copia il rapporto, se ti serve) e, se si sta registrando, ferma il video e lo presenta da salvare. Restano il campo, le squadre e il collegamento del telecomando.

6. **Telecomando**: un secondo telefono comanda la partita senza Wi-Fi (basta la rete dati). Sul telefono con la camera:
   «⋯ Altro» → Telecomando → indirizzo del servizio → «Collega un telecomando» → «Condividi il link». Sull'altro telefono il link
   apre `telecomando.html`: punteggio, chi batte, ultimi punti, +1 e −1, Via, Punteggio, Annulla, Fine partita (chiede conferma) e Punti automatici.
   Il telefono con la camera resta quello che tiene il punteggio e fa girare il riconoscimento; il telecomando manda comandi
   e riceve lo stato, quindi non ci sono conflitti. I messaggi passano da un piccolo relay e sono cifrati (vedi `relay/README.md`).
   Il link contiene il codice (8 caratteri) dopo il `#`, che non va ai server: chi ha il link comanda la partita, «Nuovo codice»
   lo annulla. I comandi ripetuti dal relay vengono scartati. Se il collegamento cade si riprende da solo; se il telefono con la
   camera non manda lo stato per 13 s il telecomando lo segnala e spegne i tasti.

## Come riconosce la battuta

Rilevatore di persone YOLOX-nano (3,6 MB) con onnxruntime-web, solo sui due ritagli delle zone di battuta,
circa 2-3 campioni al secondo. Una persona conta se ha i piedi nella zona e l'altezza compatibile con quel punto
(distanza dalla linea dell'orizzonte del campo). Due presenze vicine sullo stesso lato (la giocatrice entra con la
palla, poi batte) sono la stessa battuta.

## Misurare la precisione

La camera parte a 1080p (le giocatrici lontane hanno più pixel; il costo del riconoscimento è lo stesso perché i ritagli
delle due zone di battuta hanno sempre la stessa dimensione; la calibrazione dei 4 angoli va rifatta una volta se prima
si usava 720p). Nella partita:

- Ogni punto automatico ha un numero. A fine partita la tabella di revisione dice che fine ha fatto: **lasciato**,
  **invertito** (⇄), **tolto** (✕), tolto dalla **contesa**; i punti dati a mano sono quelli che il riconoscimento non ha visto.
- I punti con ⚠ sono quelli meno sicuri: avvistamento a meno di 4 s dall'altro, oppure persona vista meno di 1 s
  (solo con campioni fitti: con un campione ogni secondo o più la durata non si giudica). Se il punto è giusto si tocca ✓.
  Le soglie sono provvisorie (tarate a occhio su una sola partita): servono le partite corrette a mano per sistemarle.
- «Ho riguardato tutti i punti» + «Copia il rapporto» dà un rapporto (versione 2) con l'etichetta di ogni punto
  (`etichette`), il conteggio (`riepilogo`), le risincronizzazioni fatte col tasto Punteggio (`risincronizzazioni`:
  dopo una risincronizzazione le etichette sono meno sicure, perché togliere i punti «in più» non dice quali fossero
  sbagliati) e, per ogni punto, quanto era vicino all'altro avvistamento e quanto è durata la presenza.
- Un punto «lasciato» ma mai riguardato non è un punto giusto: il numero di precisione vale solo se la spunta c'è.

## Limiti noti

- Il riconoscimento non è perfetto: a 768×432 il lato lontano è rumoroso, e cambiando di poco le soglie o il
  momento in cui si campiona il punteggio di un set cambia di diversi punti. Va usato con revisione.
- Non riconosce i gesti dell'arbitro né le contese: il punto dato per errore si toglie con −1.
- Provato in Chromium senza interfaccia con un video reale e con una camera finta; **non ancora provato su iPhone**.
  Il telecomando è provato con due pagine nel browser e un relay locale, e il Worker con workerd in locale; **non è stato
  provato su rete mobile vera né con il Worker installato su Cloudflare**.
- Dal telecomando non si fa ancora la revisione dei punti (⇄, ✕, ✓): quella resta sul telefono con la camera.
- La pagina deve restare aperta e il telefono acceso; con lo schermo bloccato Safari ferma camera e riconoscimento.
- Niente diretta su YouTube: dal browser serve un server che converta il flusso.

## Prove

```bash
cd web
node --test tests/engine.test.mjs tests/vision.test.mjs
(cd relay && npm install) && node --test tests/relay.test.mjs   # telecomando e relay
```

I test del motore includono la partita reale (presenze al secondo estratte dal video): `tests/v3-occupancy.json`.
