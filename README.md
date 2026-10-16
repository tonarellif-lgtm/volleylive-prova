# VolleyLive web

Pagina che gira nel browser (Safari su iPhone): riprende la partita con la camera o analizza un video registrato,
riconosce chi sta alla battuta e assegna i punti da sola. Nessun server: tutto resta sul telefono.

## Come funziona

0. **Tutto schermo**: «Avvia la camera» apre subito la ripresa a tutto schermo, con i tasti sopra l'immagine:
   +1 per squadra ai lati, Via / Contesa / Annulla in basso, REC, «⋯» (punteggio del set, punti automatici,
   registrazione salvata, chiudi la partita) e ✕ per tornare alla pagina. Funziona in orizzontale e in verticale.
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
