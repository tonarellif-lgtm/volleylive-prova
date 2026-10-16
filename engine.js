// Motore del punteggio e della battuta. Nessuna dipendenza: gira nel browser e in Node.
// Porta in JavaScript le regole di ScoreKit (app Swift) e aggiunge:
//  - ServeTracker: da "c'è qualcuno in posizione di battuta in fondo al campo" a "battuta avvistata"
//  - AutoScorer: da battuta avvistata a punto (la battuta segue il punto), con "Via" per ogni set e contesa.

export const other = (side) => (side === 'a' ? 'b' : 'a');

export function defaultRules(over = {}) {
  return Object.assign({
    pointsPerSet: 25, decidingSetPoints: 15, minimumLead: 2,
    setsToWin: 3, decidingSetSwitchAt: 8, timeoutsPerSet: 2,
  }, over);
}
export const totalSets = (r) => r.setsToWin * 2 - 1;
export const isDecidingSet = (r, n) => totalSets(r) > 1 && n === totalSets(r);
export const targetPoints = (r, n) => (isDecidingSet(r, n) ? r.decidingSetPoints : r.pointsPerSet);

export function defaultConfig(over = {}) {
  const c = Object.assign({
    teamAName: 'Casa', teamBName: 'Ospiti',
    teamAColor: '#1E6FD9', teamBColor: '#E0452B',
    firstServer: 'a',
    // true = la squadra A sta nel lato 1 del campo (il lato dei primi due angoli toccati nella calibrazione)
    teamAStartsOnLeft: true,
  }, over);
  c.rules = defaultRules(over.rules || {});
  return c;
}

// ---------------------------------------------------------------- stato

export class MatchState {
  constructor(config) {
    this.config = config;
    this.currentSet = 1;
    this.pointsA = 0; this.pointsB = 0;
    this.setsWonA = 0; this.setsWonB = 0;
    this.completedSets = [];
    this.serving = config.firstServer;
    this.teamAOnLeft = config.teamAStartsOnLeft;
    this.timeoutsUsedA = 0; this.timeoutsUsedB = 0;
    this.substitutionsA = 0; this.substitutionsB = 0;
    this.winner = null;
    this._firstServerOfSet = config.firstServer;
    this._decidingSwapDone = false;
  }
  clone() {
    const s = Object.assign(Object.create(MatchState.prototype), this);
    s.completedSets = this.completedSets.map((x) => ({ ...x }));
    return s;
  }
  get isFinished() { return this.winner !== null; }
  points(side) { return side === 'a' ? this.pointsA : this.pointsB; }
  setsWon(side) { return side === 'a' ? this.setsWonA : this.setsWonB; }
  timeoutsUsed(side) { return side === 'a' ? this.timeoutsUsedA : this.timeoutsUsedB; }
  timeoutsLeft(side) { return Math.max(0, this.config.rules.timeoutsPerSet - this.timeoutsUsed(side)); }
  substitutions(side) { return side === 'a' ? this.substitutionsA : this.substitutionsB; }
  get leftSide() { return this.teamAOnLeft ? 'a' : 'b'; }
  get rightSide() { return other(this.leftSide); }
  get isDecidingSet() { return isDecidingSet(this.config.rules, this.currentSet); }
  get targetPoints() { return targetPoints(this.config.rules, this.currentSet); }
  get isAtStartOfSet() { return this.pointsA === 0 && this.pointsB === 0; }

  get setPointSide() {
    if (this.isFinished) return null;
    const r = this.config.rules;
    const c = ['a', 'b'].filter((s) => {
      const mine = this.points(s) + 1, theirs = this.points(other(s));
      return mine >= this.targetPoints && mine - theirs >= r.minimumLead;
    });
    return c.length === 1 ? c[0] : null;
  }
  get matchPointSide() {
    const s = this.setPointSide;
    return s && this.setsWon(s) + 1 >= this.config.rules.setsToWin ? s : null;
  }

  /** Applica un evento. Restituisce false (senza cambiare nulla) se non è valido. */
  apply(ev) {
    if (this.isFinished) return false;
    switch (ev.type) {
      case 'point': this._addPoint(ev.side); return true;
      case 'timeout':
        if (this.timeoutsLeft(ev.side) <= 0) return false;
        if (ev.side === 'a') this.timeoutsUsedA++; else this.timeoutsUsedB++;
        return true;
      case 'substitution':
        if (ev.side === 'a') this.substitutionsA++; else this.substitutionsB++;
        return true;
      case 'setServing':
        if (!this.isAtStartOfSet) return false;
        this.serving = ev.side; this._firstServerOfSet = ev.side;
        return true;
      case 'swapSides': this.teamAOnLeft = !this.teamAOnLeft; return true;
      default: return false;
    }
  }

  _addPoint(side) {
    if (side === 'a') this.pointsA++; else this.pointsB++;
    this.serving = side;                                  // rally point: chi vince l'azione batte
    const r = this.config.rules;
    const mine = this.points(side), theirs = this.points(other(side));
    if (mine >= this.targetPoints && mine - theirs >= r.minimumLead) {
      this._finishSet(side);
    } else if (this.isDecidingSet && !this._decidingSwapDone && Math.max(this.pointsA, this.pointsB) >= r.decidingSetSwitchAt) {
      this.teamAOnLeft = !this.teamAOnLeft;               // set decisivo: cambio campo a 8
      this._decidingSwapDone = true;
    }
  }

  _finishSet(side) {
    this.completedSets.push({ number: this.currentSet, pointsA: this.pointsA, pointsB: this.pointsB });
    if (side === 'a') this.setsWonA++; else this.setsWonB++;
    if (this.setsWon(side) >= this.config.rules.setsToWin) { this.winner = side; return; }
    this.currentSet++;
    this.pointsA = 0; this.pointsB = 0;
    this.timeoutsUsedA = 0; this.timeoutsUsedB = 0;
    this.substitutionsA = 0; this.substitutionsB = 0;
    this._decidingSwapDone = false;
    this.teamAOnLeft = !this.teamAOnLeft;                 // cambio campo tra i set
    this._firstServerOfSet = other(this._firstServerOfSet);
    this.serving = this._firstServerOfSet;
  }
}

// ---------------------------------------------------------------- motore a registro eventi

/** Registro eventi + stato derivato. Ogni evento ha un "meta": { time, auto } (secondi dall'inizio della ripresa). */
export class ScoreEngine {
  constructor(config, snapshot = null) {
    this.config = config;
    this.events = [];
    this.meta = [];
    this.state = new MatchState(config);
    if (snapshot) {
      snapshot.events.forEach((ev, i) => {
        const m = snapshot.meta && snapshot.meta.length === snapshot.events.length ? snapshot.meta[i] : null;
        this.apply(ev, m || undefined);
      });
    }
  }
  get canUndo() { return this.events.length > 0; }
  get snapshot() { return { config: this.config, events: this.events.map((e) => ({ ...e })), meta: this.meta.map((m) => ({ ...m })) }; }

  apply(ev, meta = { time: null, auto: false }) {
    const next = this.state.clone();
    if (!next.apply(ev)) return false;
    this.state = next;
    this.events.push({ ...ev });
    this.meta.push({ time: meta.time ?? null, auto: !!meta.auto });
    return true;
  }
  /** Annulla l'ultimo evento; restituisce { event, meta } oppure null. */
  undo() {
    if (!this.events.length) return null;
    const event = this.events.pop(), meta = this.meta.pop();
    this._rebuild();
    return { event, meta };
  }
  _rebuild() {
    const s = new MatchState(this.config);
    for (const e of this.events) s.apply(e);
    this.state = s;
  }
  /** Sostituisce la lista eventi solo se tutti restano validi (altrimenti non cambia nulla). */
  _tryReplace(events, meta) {
    const s = new MatchState(this.config);
    for (const e of events) if (!s.apply(e)) return false;
    this.events = events; this.meta = meta; this.state = s;
    return true;
  }
  removeEvent(i) {
    if (i < 0 || i >= this.events.length) return false;
    const ev = this.events.slice(), mt = this.meta.slice();
    ev.splice(i, 1); mt.splice(i, 1);
    return this._tryReplace(ev, mt);
  }
  replaceEvent(i, event) {
    if (i < 0 || i >= this.events.length) return false;
    const ev = this.events.slice(), mt = this.meta.slice();
    ev[i] = { ...event };
    return this._tryReplace(ev, mt);
  }
  insertEvent(i, event, meta = { time: null, auto: false }) {
    if (i < 0 || i > this.events.length) return false;
    const ev = this.events.slice(), mt = this.meta.slice();
    ev.splice(i, 0, { ...event }); mt.splice(i, 0, { time: meta.time ?? null, auto: !!meta.auto });
    return this._tryReplace(ev, mt);
  }
  /**
   * Porta il punteggio del set in corso a a–b (per risincronizzarsi con il tabellone dell'arbitro).
   * Toglie gli ultimi punti in più di una squadra e aggiunge in fondo quelli che mancano. Non cambia set.
   */
  setScore(a, b, meta = { time: null, auto: false }) {
    if (this.state.isFinished || a < 0 || b < 0) return false;
    const snapEv = this.events.slice(), snapMeta = this.meta.slice();
    const setStart = () => {
      let st = new MatchState(this.config), start = 0;
      for (let i = 0; i < this.events.length; i++) { const before = st.currentSet; st.apply(this.events[i]); if (st.currentSet !== before) start = i + 1; }
      return start;
    };
    const start = setStart();
    for (const side of ['a', 'b']) {
      const want = side === 'a' ? a : b;
      while (this.state.points(side) > want) {
        let idx = -1;
        for (let i = this.events.length - 1; i >= start; i--) if (this.events[i].type === 'point' && this.events[i].side === side) { idx = i; break; }
        if (idx < 0 || !this.removeEvent(idx)) { this.events = snapEv; this.meta = snapMeta; this._rebuild(); return false; }
      }
    }
    for (const side of ['a', 'b']) {
      const want = side === 'a' ? a : b;
      while (this.state.points(side) < want) {
        const before = this.state.currentSet;
        if (!this.apply({ type: 'point', side }, meta) || this.state.currentSet !== before) {
          this.events = snapEv; this.meta = snapMeta; this._rebuild(); return false;   // il set finirebbe: usa i punti normali
        }
      }
    }
    return this.state.pointsA === a && this.state.pointsB === b;
  }
  /** Inverte chi ha vinto il punto numero i (solo se è un punto). */
  flipPoint(i) {
    const e = this.events[i];
    if (!e || e.type !== 'point') return false;
    return this.replaceEvent(i, { type: 'point', side: other(e.side) });
  }
  /** Punteggio dopo ogni evento, per la schermata di revisione. */
  timeline() {
    const s = new MatchState(this.config), out = [];
    this.events.forEach((e, i) => {
      const setNo = s.currentSet;
      s.apply(e);
      const done = s.completedSets.length && s.completedSets[s.completedSets.length - 1].number === setNo;
      const last = done ? s.completedSets[s.completedSets.length - 1] : null;
      out.push({
        index: i, event: e, meta: this.meta[i], set: setNo,
        a: last ? last.pointsA : s.pointsA, b: last ? last.pointsB : s.pointsB,
        setEnded: !!last, serving: s.serving,
      });
    });
    return out;
  }
}

// ---------------------------------------------------------------- battuta avvistata

export const FIRST = 'first';     // lato 1 del campo (angoli 1-2 della calibrazione)
export const SECOND = 'second';   // lato 2

/**
 * Da presenze a "battuta avvistata".
 * Ogni lato ha una presenza (c'è una persona in zona di battuta) campionata a 1-2 Hz.
 * Una battuta è composta da due momenti vicini: la giocatrice entra con la palla (preparazione),
 * poi il fischio, poi la battuta vera e propria. Le presenze a meno di `mergeGap` secondi
 * dall'ultima sullo stesso lato sono la stessa battuta: un avvistamento solo.
 * L'avvistamento è emesso (con l'orario del primo momento) quando c'è conferma: la presenza dura almeno
 * `confirmSec` oppure ricompare una seconda volta entro `mergeGap` (preparazione + battuta). Un passaggio isolato
 * di un secondo non conta.
 */
export class ServeTracker {
  constructor(opts = {}) {
    this.mergeGap = opts.mergeGap ?? 12;
    this.confirmSec = opts.confirmSec ?? 1;
    this.dropoutSec = opts.dropoutSec ?? 2.5;
    this.reset();
  }
  reset() {
    this.ends = { [FIRST]: this._fresh(), [SECOND]: this._fresh() };
  }
  _fresh() { return { anchor: null, cand: null, contStart: null, emitted: true }; }

  /** @param {number} t secondi  @param {{first:boolean, second:boolean}} occ  @returns {Array<{end:string,time:number}>} */
  observe(t, occ) {
    const out = [];
    for (const end of [FIRST, SECOND]) {
      if (!occ[end]) continue;
      const st = this.ends[end];
      if (st.anchor === null || t - st.anchor > this.mergeGap) {
        // presenza nuova: comincia un possibile avvistamento
        st.cand = t; st.contStart = t; st.emitted = this.confirmSec <= 0;
        if (st.emitted) out.push({ end, time: t });
      } else if (!st.emitted) {
        if (t - st.anchor > this.dropoutSec) {
          // seconda presenza (preparazione + battuta) dentro la finestra: conferma
          st.emitted = true; out.push({ end, time: st.cand });
        } else if (t - st.contStart >= this.confirmSec) {
          st.emitted = true; out.push({ end, time: st.cand });   // presenza continua abbastanza a lungo
        }
      }
      st.anchor = t;
    }
    return out;
  }
}

// ---------------------------------------------------------------- da avvistamento a punto

/**
 * Regola di base: dopo ogni azione batte chi ha fatto il punto. Quindi una nuova battuta avvistata
 * da un lato significa "ha fatto il punto la squadra che sta in quel lato" (anche se è la stessa che batteva).
 * Eccezioni gestite qui:
 *  - la prima battuta del set non è un punto: si parte con "Via" (arm), che dice anche chi batte;
 *  - la contesa (azione da ripetere): la battuta che segue non vale un punto;
 *  - dopo la fine di un set o della partita il riconoscimento si ferma finché non si preme "Via".
 */
export class AutoScorer {
  constructor(opts = {}) {
    this.tracker = new ServeTracker(opts);
    this.mode = 'idle';              // idle | awaitingFirst | tracking
    this.pendingContesa = false;
    this.lastAutoCount = null;       // numero eventi del motore subito dopo l'ultimo punto automatico
    this.log = [];                   // { time, end, action, side, note }
    this.mismatches = 0;
    this.autoApply = opts.autoApply ?? true;   // false: l'avvistamento viene solo registrato come proposta
  }
  /** Lato della squadra che sta in un lato del campo adesso. */
  static sideAt(end, state) { return end === FIRST ? state.leftSide : state.rightSide; }
  static endOf(side, state) { return state.leftSide === side ? FIRST : SECOND; }

  /** "Via": il set sta per cominciare. `firstServer` (a|b) opzionale: se dato, si registra sul motore. */
  arm(engine, firstServer = null, time = null) {
    if (engine.state.isFinished) return false;
    if (firstServer && firstServer !== engine.state.serving && engine.state.isAtStartOfSet) {
      engine.apply({ type: 'setServing', side: firstServer }, { time, auto: false });
    }
    this.tracker.reset();
    this.mode = 'awaitingFirst';
    this.pendingContesa = false;
    this.lastAutoCount = null;
    this.mismatches = 0;
    this._log(time, null, 'via', engine.state.serving, 'Set ' + engine.state.currentSet + ': in attesa della prima battuta');
    return true;
  }
  disarm(time = null) { this.mode = 'idle'; this._log(time, null, 'stop', null, ''); }

  /** Un campione di presenza. Restituisce le decisioni prese (da mostrare in interfaccia). */
  observe(t, occ, engine) {
    const decisions = [];
    for (const s of this.tracker.observe(t, occ)) {
      const d = this._onServe(s, engine);
      if (d) decisions.push(d);
    }
    return decisions;
  }

  _onServe(s, engine) {
    const st = engine.state;
    if (this.mode === 'idle' || st.isFinished) return null;
    const side = AutoScorer.sideAt(s.end, st);

    if (this.mode === 'awaitingFirst') {
      if (side !== st.serving) {                // non è chi dovrebbe battare: rumore o battuta indicata male
        this.mismatches++;
        return this._log(s.time, s.end, 'ignorata', side, 'prima battuta dal lato sbagliato (' + this.mismatches + ')');
      }
      this.mode = 'tracking';
      return this._log(s.time, s.end, 'prima-battuta', side, 'si parte');
    }

    // tracking
    if (this.pendingContesa) {
      this.pendingContesa = false;
      return this._log(s.time, s.end, 'contesa', side, 'azione da ripetere: nessun punto');
    }
    if (!this.autoApply) return this._log(s.time, s.end, 'proposta', side, 'punto automatico spento');
    const before = st.currentSet, beforeFinished = st.isFinished;
    if (!engine.apply({ type: 'point', side }, { time: s.time, auto: true })) return null;
    this.lastAutoCount = engine.events.length;
    const ns = engine.state;
    let note = '';
    if (ns.isFinished && !beforeFinished) { this.mode = 'idle'; note = 'partita finita'; }
    else if (ns.currentSet !== before) { this.mode = 'idle'; note = 'set finito: premi Via per il prossimo'; }
    return this._log(s.time, s.end, 'punto', side, note);
  }

  /**
   * Tasto "Contesa". Se l'ultimo evento del motore è proprio l'ultimo punto automatico, la battuta
   * della contesa è già stata contata come punto: lo si toglie. Altrimenti si ignora la prossima battuta.
   */
  contesa(engine, time = null) {
    if (this.mode === 'tracking' && this.lastAutoCount !== null && engine.events.length === this.lastAutoCount) {
      const undone = engine.undo();
      this.lastAutoCount = null;
      this._log(time, null, 'contesa', undone && undone.event.side, 'tolto l\'ultimo punto automatico');
      return 'tolto';
    }
    this.pendingContesa = true;
    this._log(time, null, 'contesa', null, 'la prossima battuta non vale un punto');
    return 'in-attesa';
  }

  _log(time, end, action, side, note) {
    const e = { time, end, action, side, note };
    this.log.push(e);
    return e;
  }
}
