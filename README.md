# VolleyLive web

Pagina che gira nel browser (Safari su iPhone): riprende la partita con la camera o analizza un video registrato,
riconosce chi sta alla battuta e assegna i punti da sola. Nessun server: tutto resta sul telefono.

## Come funziona

0. **Tutto schermo**: «Avvia la camera» apre subito la ripresa a tutto schermo, con i tasti sopra l'immagine:
   +1 per squadra ai lati, Via / Contesa / Annulla in basso, REC, «⋯» (punteggio del set, punti automatici,
   registrazione salvata, chiudi la partita) e ✕ per tornare alla pagina. «Punteggio» (accanto a Via, Contesa e Annulla)
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
   squadra di quel lato. La prima battuta del set non è un punto. «Contesa» dice che l'azione si ripete.
5. **Correzioni**: +1, Annulla, «Imposta il punteggio del set» e, a fine partita, la tabella di revisione
   (▶︎ rivede il momento, ⇄ inverte il punto, ✕ lo toglie).

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
- Non riconosce i gesti dell'arbitro. La contesa si segnala col tasto.
- Provato in Chromium senza interfaccia con un video reale e con una camera finta; **non ancora provato su iPhone**.
- La pagina deve restare aperta e il telefono acceso; con lo schermo bloccato Safari ferma camera e riconoscimento.
- Niente diretta su YouTube: dal browser serve un server che converta il flusso.

## Prove

```bash
cd web
node --test tests/engine.test.mjs tests/vision.test.mjs
```

I test del motore includono la partita reale (presenze al secondo estratte dal video): `tests/v3-occupancy.json`.
