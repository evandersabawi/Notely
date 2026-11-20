// Notemon: the monster battle game mode.
//
// Each turn: the monster shows what it plans to do (its intent), you pick a move, then answer a question.
// A right answer lands your move; a wrong one makes it miss. Then the monster acts.
// Moves chain into combos, monsters each have their own personality, and wild events shake things up.
//
// The rules (Engine) are plain functions with no DOM, so they can be simulated in Node to tune balance:
//   node -e "global.window={};require('./js/notemon.js');console.log(window.NotemonEngine.simulate(0.8))"
(() => {
  // ---------------- rules ----------------
  const MOVES = {
    strike:   { name: 'Strike',   icon: 'swords', lo: 14, hi: 20, desc: 'Steady damage.' },
    blast:    { name: 'Blast',    icon: 'zap',    lo: 6,  hi: 36, desc: 'Wild damage. Could be huge.' },
    guard:    { name: 'Guard',    icon: 'shield', lo: 0,  hi: 0,  desc: 'Block most of the next hit and heal a little.' },
    finisher: { name: 'Finisher', icon: 'star',   lo: 38, hi: 48, desc: 'Needs 3 energy. Huge damage that can’t be dodged or blocked.' },
  };
  const MAX_ENERGY = 3;

  // Checked longest first. `seq` is the end of your chain of landed moves.
  const COMBOS = [
    { id: 'triple',  name: 'Triple Strike', seq: ['strike', 'strike', 'strike'], desc: 'Double damage.' },
    { id: 'counter', name: 'Counter',       seq: ['guard', 'strike'],            desc: 'Extra damage, and you take no damage this turn.' },
    { id: 'thunder', name: 'Thunderclap',   seq: ['strike', 'blast'],            desc: 'Stuns the monster for a turn.' },
    { id: 'overload', name: 'Overload',     seq: ['blast', 'blast'],             desc: 'Double damage, with a little recoil.' },
    { id: 'ricochet', name: 'Ricochet',     seq: ['guard', 'blast'],             desc: 'Hits twice.' },
    { id: 'wind',    name: 'Second Wind',   seq: ['guard', 'guard'],             desc: 'Heal 20 HP and gain energy.' },
  ];
  function comboFor(chain, move) {
    const c = [...chain, move];
    return COMBOS.find(k => k.seq.length <= c.length && k.seq.every((m, i) => c[c.length - k.seq.length + i] === m)) || null;
  }

  // What each monster likes to do. Index = the monster's place in the line-up (and its sprite).
  const INTENTS = {
    jab:    { label: 'Attack',      icon: 'swords' },
    double: { label: 'Double hit',  icon: 'layers' },
    charge: { label: 'Charging up', icon: 'timer' },
    mega:   { label: 'Mega attack', icon: 'zap' },
    shield: { label: 'Shield up',   icon: 'shield' },
    heal:   { label: 'Heal',        icon: 'heart' },
    screech:{ label: 'Screech',     icon: 'volume' },
    vanish: { label: 'Vanish',      icon: 'eyeOff' },
    drain:  { label: 'Energy drain', icon: 'target' },
    fire:   { label: 'Fire breath', icon: 'flame' },
    roar:   { label: 'Roar',        icon: 'dizzy' },
  };
  const SPECIES = [
    { jab: 5, heal: 2, shield: 1 },                       // slime: tanky, patches itself up
    { double: 4, jab: 2, screech: 2 },                    // bat: quick double bites, ear-splitting screech
    { charge: 3, jab: 3, shield: 2 },                     // cyclops: winds up huge beams
    { jab: 3, vanish: 3, drain: 2 },                      // ghost: slippery, sometimes hides what it's doing
    { fire: 3, jab: 3, charge: 2, roar: 1 },              // dragon boss: burns, roars, gets angry at half HP
  ];
  const HIDDEN_CHANCE = [0, 0, 0, 0.45, 0.15];

  const EVENTS = [
    { id: 'lucky',  w: 3, text: 'Lucky star! Your next hit is a sure crit.' },
    { id: 'berry',  w: 3, text: 'Healing berry! +10 HP.' },
    { id: 'surge',  w: 3, text: 'Energy surge! +1 energy.' },
    { id: 'trip',   w: 2, text: '{name} tripped! It loses its next turn.' },
    { id: 'double', w: 2, text: 'Double trouble! Your next hit deals double damage.' },
  ];
  const EVENT_CHANCE = 0.18;

  function mkRng(rand = Math.random) {
    return {
      f: rand,
      int: (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)),
      chance: p => rand() < p,
      pick: weights => { const e = Object.entries(weights).filter(([, w]) => w > 0); let r = rand() * e.reduce((s, [, w]) => s + w, 0); for (const [k, w] of e) { if ((r -= w) < 0) return k; } return e[e.length - 1][0]; },
    };
  }

  function newBattle(names, rand) {
    const S = {
      rng: mkRng(rand), names,
      you: { hp: 100, max: 100, energy: 0, burn: 0, weak: false, lucky: false, double: false },
      mon: null, mi: 0, chain: [], streak: 0, caught: [], answered: 0, correct: 0, combos: 0, bestHit: 0, turn: 0,
    };
    startMonster(S);
    return S;
  }
  function startMonster(S) {
    const max = 60 + S.mi * 25;
    S.mon = { hp: max, max, shield: 0, stun: false, charged: false, vanish: false, enraged: false, roared: false, phase2: false, intent: null, hidden: false };
    rollIntent(S);
  }
  const monLo = S => Math.round(4 + 1.5 * S.mi), monHi = S => Math.round(7 + 2.5 * S.mi);
  const CATCH_HEAL = 40;

  function rollIntent(S) {
    const m = S.mon, r = S.rng;
    if (m.charged) { m.intent = 'mega'; m.hidden = false; return; }
    const w = Object.assign({}, SPECIES[S.mi % SPECIES.length]);
    if (m.roared) w.roar = 0;
    if (m.hp >= m.max) w.heal = 0;
    if (m.shield > 0) w.shield = 0;
    if (S.you.energy === 0) w.drain = 0;
    if (S.mon.intent && S.mon.intent !== 'jab') w[S.mon.intent] = Math.min(w[S.mon.intent] || 0, 1); // rarely the same trick twice
    m.intent = r.pick(w);
    m.hidden = r.chance(HIDDEN_CHANCE[S.mi % HIDDEN_CHANCE.length]);
  }

  // A wild event that may happen at the start of a turn. Returns the event or null.
  function rollEvent(S) {
    if (S.turn < 2 || !S.rng.chance(EVENT_CHANCE)) return null;
    const w = {}; EVENTS.forEach(e => { w[e.id] = e.w; });
    if (S.you.hp >= S.you.max) w.berry = 0;
    if (S.you.energy >= MAX_ENERGY) w.surge = 0;
    const id = S.rng.pick(w), ev = EVENTS.find(e => e.id === id);
    if (ev.id === 'lucky') S.you.lucky = true;
    if (ev.id === 'berry') S.you.hp = Math.min(S.you.max, S.you.hp + 10);
    if (ev.id === 'surge') S.you.energy = Math.min(MAX_ENERGY, S.you.energy + 1);
    if (ev.id === 'trip') S.mon.stun = true;
    if (ev.id === 'double') S.you.double = true;
    return ev;
  }

  // What the screen needs to draw the fight at one moment, so steps can be shown in order.
  function snapshot(S) {
    const y = S.you, m = S.mon;
    return {
      name: S.names[Math.min(S.mi, S.names.length - 1)], mi: S.mi, streak: S.streak, caught: S.caught.length,
      you: { hp: y.hp, max: y.max, energy: y.energy, burn: y.burn, weak: y.weak, lucky: y.lucky, double: y.double },
      mon: { hp: m.hp, max: m.max, shield: m.shield, enraged: m.enraged, vanish: m.vanish, stun: m.stun },
    };
  }

  const canUse = (S, move) => move !== 'finisher' || S.you.energy >= MAX_ENERGY;

  // Play one turn. Returns a list of steps for the screen to show one at a time:
  // { who: 'you'|'mon', log, dmg?, heal?, crit?, combo?, fx? } plus a final { end: 'caught'|'won'|'lost' } when relevant.
  function playTurn(S, move, correct) {
    const r = S.rng, you = S.you, m = S.mon, name = S.names[S.mi], steps = [];
    const add = st => { st.snap = snapshot(S); steps.push(st); return st; };
    S.turn++; S.answered++;
    let guardMult = 1, noDamage = false;

    if (!correct) {
      S.streak = 0; S.chain = [];
      add({ who: 'you', fx: 'miss', log: 'Wrong answer! Your move missed.' });
    } else {
      S.correct++; S.streak++;
      const combo = comboFor(S.chain, move);
      S.chain = combo ? [] : [...S.chain, move].slice(-2);
      if (combo) S.combos++;
      if (move !== 'finisher') you.energy = Math.min(MAX_ENERGY, you.energy + 1);

      if (move === 'guard') {
        guardMult = 0.25;
        const heal = Math.min(you.max - you.hp, combo && combo.id === 'wind' ? 20 : 6);
        you.hp += heal;
        if (combo && combo.id === 'wind') { you.energy = Math.min(MAX_ENERGY, you.energy + 1); add({ who: 'you', combo, heal, fx: 'heal', log: 'Combo! You recover {n} HP.', n: heal }); }
        else add({ who: 'you', heal, fx: 'guard', log: heal ? 'You brace yourself and recover {n} HP.' : 'You brace yourself.', n: heal });
      } else {
        if (move === 'finisher') you.energy = 0;
        const hits = combo && combo.id === 'ricochet' ? 2 : 1;
        const pierce = move === 'finisher' || !!combo;
        for (let h = 0; h < hits && m.hp > 0; h++) {
          const mv = MOVES[move];
          let dmg = r.int(combo && combo.id === 'thunder' ? 20 : mv.lo, mv.hi);
          const crit = you.lucky || r.chance(0.08 + 0.04 * Math.min(S.streak, 5));
          if (crit) { dmg *= 1.5; you.lucky = false; }
          if (combo && (combo.id === 'triple' || combo.id === 'overload')) dmg *= 2;
          if (combo && combo.id === 'counter') dmg += 12;
          if (you.double) { dmg *= 2; you.double = false; }
          if (you.weak) { dmg *= 0.5; you.weak = false; }
          dmg = Math.round(dmg);
          if (m.vanish && !pierce && r.chance(0.5)) { m.vanish = false; add({ who: 'mon', fx: 'dodge', log: '{name} dodged your attack!' }); continue; }
          m.vanish = false;
          let absorbed = 0;
          if (m.shield > 0 && move !== 'finisher') { absorbed = Math.min(m.shield, dmg); m.shield -= absorbed; dmg -= absorbed; }
          m.hp = Math.max(0, m.hp - dmg);
          S.bestHit = Math.max(S.bestHit, dmg);
          const log = combo && h === 0 ? 'Combo! {name} takes {n}!' : crit ? 'Critical hit! {name} takes {n}!' : 'You hit {name} for {n}!';
          if (dmg > 0 || !absorbed) add({ who: 'you', dmg, crit, combo: h === 0 ? combo : null, fx: 'hit', log, n: dmg });
          if (absorbed) add({ who: 'mon', fx: 'shield', combo: dmg > 0 || h > 0 ? null : combo, log: '{name}’s shield absorbed {n}.', n: absorbed });
        }
        if (combo && combo.id === 'thunder' && m.hp > 0) m.stun = true;
        if (combo && combo.id === 'counter') noDamage = true;
        if (combo && combo.id === 'overload') { const rec = 8; you.hp = Math.max(1, you.hp - rec); add({ who: 'you', fx: 'hurt', self: true, log: 'Recoil! You take {n}.', n: rec, dmgYou: rec }); }
      }
    }

    // Monster knocked out: caught.
    if (m.hp <= 0) {
      S.caught.push({ name, index: S.mi });
      you.hp = Math.min(you.max, you.hp + CATCH_HEAL); you.burn = 0; you.weak = false;
      add({ who: 'mon', fx: 'caught', log: 'You caught {name}! +{n} HP.', n: CATCH_HEAL });
      S.mi++;
      if (S.mi >= S.names.length) { add({ end: 'won' }); return steps; }
      S.chain = [];
      startMonster(S);
      add({ who: 'mon', fx: 'appear', log: '{name} appears!', newMonster: true });
      return steps;
    }

    // Boss gets angry at half HP, once.
    if (S.mi === 4 && !m.phase2 && m.hp <= m.max / 2) {
      m.phase2 = true; m.enraged = true; m.stun = false; m.shield = 0;
      const heal = Math.round(m.max * 0.1); m.hp += heal;
      add({ who: 'mon', fx: 'roar', log: '{name} is furious! Phase two!' });
    }

    // Monster's action.
    const dmgRoll = mult => Math.round(r.int(monLo(S), monHi(S)) * mult * (m.enraged ? 1.25 : 1));
    const hurtYou = (raw, log, extra = {}) => {
      let dmg = noDamage ? 0 : Math.round(raw * guardMult);
      const blocked = raw - dmg;
      you.hp = Math.max(0, you.hp - dmg);
      add(Object.assign({ who: 'mon', fx: 'attack', log: noDamage ? '{name} attacks, but you dodge!' : log, n: dmg, dmgYou: dmg }, extra));
      if (blocked > 0) add({ who: 'you', fx: 'guard', log: 'You blocked {n} damage.', n: blocked });
    };
    if (m.stun) {
      m.stun = false;
      add({ who: 'mon', fx: 'stunned', log: '{name} is stunned and can’t move!' });
      if (m.intent === 'mega') m.charged = true; // still holding the charge
    } else {
      const it = m.intent;
      if (it === 'jab') hurtYou(dmgRoll(1), '{name} hits you for {n}.');
      else if (it === 'double') hurtYou(dmgRoll(0.65) + dmgRoll(0.65), '{name} hits twice for {n}!');
      else if (it === 'charge') { m.charged = true; add({ who: 'mon', fx: 'charge', log: '{name} is charging up a big attack!' }); }
      else if (it === 'mega') { m.charged = false; hurtYou(dmgRoll(2.4), '{name} unleashes a mega attack for {n}!'); }
      else if (it === 'shield') { m.shield = 15 + 6 * S.mi; add({ who: 'mon', fx: 'shieldUp', log: '{name} raises a shield.' }); }
      else if (it === 'heal') { const h = Math.min(m.max - m.hp, 12 + 4 * S.mi); m.hp += h; add({ who: 'mon', fx: 'monHeal', log: '{name} heals {n} HP.', n: h }); }
      else if (it === 'screech') { you.weak = true; add({ who: 'mon', fx: 'screech', log: '{name} screeches! Your next move is weakened.' }); }
      else if (it === 'vanish') { m.vanish = true; add({ who: 'mon', fx: 'vanish', log: '{name} vanishes! Your next attack may miss.' }); }
      else if (it === 'drain') { you.energy = Math.max(0, you.energy - 1); hurtYou(dmgRoll(0.6), '{name} drains your energy and hits for {n}.'); }
      else if (it === 'fire') { hurtYou(dmgRoll(0.9), '{name} breathes fire for {n}! You’re burned.'); if (!noDamage && guardMult === 1) you.burn = 2; }
      else if (it === 'roar') { m.roared = true; m.enraged = true; add({ who: 'mon', fx: 'roar', log: '{name} roars and becomes enraged!' }); }
    }

    if (you.burn > 0 && you.hp > 0) { you.burn--; const b = 4; you.hp = Math.max(0, you.hp - b); add({ who: 'you', fx: 'hurt', log: 'The burn deals {n} damage.', n: b, dmgYou: b }); }
    if (you.hp <= 0) { add({ end: 'lost' }); return steps; }
    rollIntent(S);
    return steps;
  }

  // Rough balance check: a player who answers right with probability `acc` and picks moves sensibly.
  function simulate(acc, runs = 4000) {
    let wins = 0, caught = 0, turns = 0, combos = 0;
    const names = ['A', 'B', 'C', 'D', 'E'];
    for (let i = 0; i < runs; i++) {
      const S = newBattle(names, Math.random);
      let over = false;
      while (!over && S.turn < 400) {
        rollEvent(S);
        let move;
        const c = ['strike', 'blast', 'guard'].map(mv => [mv, comboFor(S.chain, mv)]).filter(([, k]) => k);
        if (canUse(S, 'finisher')) move = 'finisher';
        else if (['mega', 'charge'].includes(S.mon.intent) && S.mon.intent === 'mega') move = 'guard';
        else if (c.length && Math.random() < 0.7) move = c[0][0];
        else move = ['strike', 'strike', 'blast', 'guard'][Math.floor(Math.random() * 4)];
        const steps = playTurn(S, move, Math.random() < acc);
        const e = steps.find(s => s.end); if (e) { over = true; if (e.end === 'won') wins++; }
      }
      caught += S.caught.length; turns += S.turn; combos += S.combos;
    }
    return { acc, winRate: +(wins / runs).toFixed(2), avgCaught: +(caught / runs).toFixed(2), avgTurns: Math.round(turns / runs), avgCombos: +(combos / runs).toFixed(1) };
  }

  const Engine = { MOVES, COMBOS, INTENTS, MAX_ENERGY, comboFor, newBattle, rollEvent, playTurn, canUse, snapshot, simulate, monLo, monHi };
  window.NotemonEngine = Engine;
  if (typeof Games === 'undefined') return; // Node simulation

  // ---------------- screen ----------------
  const { buildMC, choicesHTML, askChoices, endScreen, esc, wait, pct } = Games._kit;
  const I = Icons.icon;
  const fillName = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

  function notemon(root, c, ctx) {
    const names = (c.monsters && c.monsters.length ? c.monsters : []).slice(0, 5).map(m => m.name);
    while (names.length < 5) names.push('Wild Notemon ' + (names.length + 1));
    let pool = buildMC(c), qi = 0, alive = true;
    const nextQ = () => { if (qi >= pool.length) { pool = buildMC(c); qi = 0; } return pool[qi++]; };
    const S = newBattle(names);

    const monName = () => names[Math.min(S.mi, names.length - 1)];
    const intentHTML = () => {
      const m = S.mon;
      if (m.hidden) return `<div class="intent hidden" title="It’s hiding what it will do">${I('eyeOff')}<span>???</span></div>`;
      const it = INTENTS[m.intent];
      const range = ['jab', 'double', 'mega', 'drain', 'fire'].includes(m.intent) ? (() => {
        const k = { jab: 1, double: 1.3, mega: 2.4, drain: 0.6, fire: 0.9 }[m.intent] * (m.enraged ? 1.25 : 1);
        return ` <b>${Math.round(Engine.monLo(S) * k)}–${Math.round(Engine.monHi(S) * k)}</b>`;
      })() : '';
      return `<div class="intent ${m.intent === 'mega' || m.intent === 'charge' ? 'danger' : ''}" title="What it will do next">${I(it.icon)}<span>${it.label}</span>${range}</div>`;
    };
    const badge = (on, cls, label, extra = '') => on ? `<span class="badge ${cls}"><span>${label}</span>${extra}</span>` : '';
    const monBadges = (m = S.mon) => {
      return badge(m.shield > 0, 'shield', 'Shield', ` <b>${m.shield}</b>`) + badge(m.enraged, 'bad', 'Enraged') + badge(m.vanish, '', 'Vanished') + badge(m.stun, 'ok', 'Stunned');
    };
    const youBadges = (y = S.you) => {
      return badge(y.burn > 0, 'bad', 'Burned') + badge(y.weak, 'bad', 'Weakened') + badge(y.lucky, 'gold', 'Lucky') + badge(y.double, 'gold', 'Double damage');
    };
    const energyHTML = (e = S.you.energy) => `<div class="energy" title="Energy">${Array.from({ length: MAX_ENERGY }, (_, i) => `<i class="${i < e ? 'on' : ''}"></i>`).join('')}</div>`;
    const chainHTML = () => S.chain.length
      ? `<div class="chain"><span>Chain</span>${S.chain.map(mv => `<span class="chip">${I(MOVES[mv].icon)}</span>`).join('')}</div>` : '<div class="chain"></div>';

    function frame() {
      root.innerHTML = `
        <div class="game-top"><span>Monster ${S.mi + 1}/${names.length}</span><span>${I('flame')} <span id="t-streak">streak ${S.streak}</span></span><span>${I('box')} <span id="t-caught">${S.caught.length} caught</span></span></div>
        <div class="arena nm">
          <div class="fighter player">
            <div class="badges" id="y-badges">${youBadges()}</div>
            <div class="sprite" id="p-sprite">${ctx.player()}</div>
            <div class="hpbar"><i id="p-hp" style="width:${pct(S.you.hp, S.you.max)}%"></i></div>
            <div class="hpnum" id="p-num">You ${S.you.hp}/${S.you.max}</div>
            <div id="y-energy">${energyHTML()}</div>
          </div>
          <div class="vs">VS</div>
          <div class="fighter monster">
            <div id="m-intent">${intentHTML()}</div>
            <div class="badges" id="m-badges">${monBadges()}</div>
            <div class="sprite ${S.mi === 4 ? 'boss' : ''}" id="m-sprite">${Icons.monster(S.mi)}</div>
            <div class="hpbar mon"><i id="m-hp" style="width:${pct(S.mon.hp, S.mon.max)}%"></i></div>
            <div class="hpnum" id="m-num">${esc(monName())} ${S.mon.hp}/${S.mon.max}</div>
          </div>
          <div class="float" id="float-me"></div><div class="float" id="float-mon"></div>
          <div class="combo-pop" id="combo-pop"></div>
        </div>
        <div class="battle-log" id="log"></div>
        <div id="panel"></div>`;
    }
    const $ = sel => root.querySelector(sel);
    function refresh(sn = snapshot(S)) {
      if (!alive || !$('#p-hp')) return;
      const set = (sel, html) => { const e = $(sel); if (e && e.innerHTML !== html) e.innerHTML = html; };
      $('#p-hp').style.width = pct(sn.you.hp, sn.you.max) + '%';
      $('#m-hp').style.width = pct(sn.mon.hp, sn.mon.max) + '%';
      set('#p-num', `You ${sn.you.hp}/${sn.you.max}`);
      set('#m-num', esc(`${sn.name} ${sn.mon.hp}/${sn.mon.max}`));
      set('#y-energy', energyHTML(sn.you.energy));
      set('#y-badges', youBadges(sn.you));
      set('#m-badges', monBadges(sn.mon));
      set('#t-streak', `streak ${sn.streak}`);
      set('#t-caught', `${sn.caught} caught`);
    }
    const say = (text, vars = {}) => { const l = $('#log'); if (l) l.classList.remove('event'); if (l) l.textContent = fillName(text, Object.assign({ name: monName() }, vars)); };
    function floatNum(which, text, cls) {
      const f = $(which === 'me' ? '#float-me' : '#float-mon'); if (!f) return;
      f.textContent = text; f.className = 'float ' + (which === 'me' ? 'me ' : 'mon ') + cls;
      void f.offsetWidth; f.classList.add('show');
    }
    function flash(el, cls) { const e = $(el); if (!e) return; e.classList.remove(cls); void e.offsetWidth; e.classList.add(cls); }

    // Step 1: choose a move.
    function chooseMove(msg) {
      if (!alive) return;
      $('#m-intent').innerHTML = intentHTML();
      refresh();
      say(msg || 'Pick a move, then answer to land it.');
      const moves = ['strike', 'blast', 'guard', 'finisher'];
      $('#panel').innerHTML = `
        ${chainHTML()}
        <div class="moves">${moves.map(mv => {
          const M = MOVES[mv], ok = canUse(S, mv), combo = ok ? comboFor(S.chain, mv) : null;
          return `<button class="move ${mv} ${combo ? 'has-combo' : ''}" data-mv="${mv}" ${ok ? '' : 'disabled'}>
            <span class="move-name">${I(M.icon)}<b>${M.name}</b></span>
            <small>${M.desc}</small>
            ${combo ? `<span class="combo-tag"><span>Combo</span> <b>${combo.name}</b></span>` : ''}
          </button>`;
        }).join('')}</div>
        <details class="combo-book"><summary>${I('layers')} <span>Combos</span></summary>
          <ul>${COMBOS.map(k => `<li><span class="seq">${k.seq.map(mv => `<span class="chip" title="${MOVES[mv].name}">${I(MOVES[mv].icon)}</span>`).join('')}</span><b>${k.name}</b><span class="cdesc">${k.desc}</span></li>`).join('')}</ul>
        </details>`;
      root.querySelectorAll('.move').forEach(b => b.onclick = () => ask(b.dataset.mv));
    }

    // Step 2: answer to land it.
    function ask(move) {
      const item = nextQ(), M = MOVES[move];
      $('#panel').innerHTML = `<div class="qpanel"><div class="using">${I(M.icon)}<span>Your move</span> <b>${M.name}</b></div><p class="qtext">${esc(item.q)}</p>${choicesHTML(item)}<div id="after"></div></div>`;
      say('Answer correctly to land your move.');
      askChoices(root, item).then(async ({ correct }) => {
        if (!alive) return;
        if (!correct) {
          const after = $('#after');
          after.innerHTML = `<div class="explain"><p class="qtext">${esc(item.explanation || '')}</p><button class="btn primary" id="cont">${I('arrowRight')} Continue</button></div>`;
          if (!item.explanation) after.querySelector('p').remove();
          say('Wrong! The answer was "{answer}".', { answer: item.choices[item.answer] });
          await new Promise(res => { after.querySelector('#cont').onclick = res; });
        } else await wait(350);
        if (!alive) return;
        $('#panel').innerHTML = '';
        await play(playTurn(S, move, correct));
      });
    }

    // Step 3: show what happened, one step at a time.
    async function play(steps) {
      for (const st of steps) {
        if (!alive) return;
        if (st.end === 'won') return win();
        if (st.end === 'lost') { await wait(500); return lose(); }
        if (st.newMonster) { frame(); refresh(); }
        if (st.combo) {
          const p = $('#combo-pop');
          p.innerHTML = `<span>Combo!</span> <b>${st.combo.name}</b>`;
          p.classList.remove('show'); void p.offsetWidth; p.classList.add('show');
        }
        if (st.fx === 'hit') { flash('#m-sprite', 'hit'); floatNum('mon', (st.crit ? '★ ' : '') + '-' + st.dmg, st.crit || st.combo ? 'big' : ''); }
        if (st.dmgYou) { flash('#p-sprite', 'hit'); floatNum('me', '-' + st.dmgYou, ''); }
        if (st.dmgYou === 0 && st.fx === 'attack') floatNum('me', '0', 'ok');
        if (st.heal && st.fx !== 'caught') floatNum('me', '+' + st.heal, 'ok');
        if (st.fx === 'dodge') { flash('#m-sprite', 'dodge'); floatNum('mon', 'Miss', ''); }
        if (st.fx === 'miss') flash('#p-sprite', 'hit');
        if (st.fx === 'caught') flash('#m-sprite', 'caught');
        if (st.fx === 'roar' || st.fx === 'charge') flash('#m-sprite', 'pulse');
        if (st.fx === 'monHeal') floatNum('mon', '+' + st.n, 'ok');
        say(st.log, { n: st.n, name: st.snap.name });
        refresh(st.snap);
        await wait(st.fx === 'caught' ? 1300 : st.combo ? 1200 : 950);
      }
      if (!alive) return;
      const ev = rollEvent(S);
      if (ev) { refresh(); say(ev.text); flash('#log', 'event'); await wait(1400); }
      chooseMove();
    }

    const caughtHTML = () => `<div class="caught">${S.caught.map(m => `<span title="${esc(m.name)}">${Icons.monster(m.index)}</span>`).join('')}</div>`;
    const result = won => ({ type: 'notemon', caught: S.caught.length, won, accuracy: pct(S.correct, S.answered), combos: S.combos, bestHit: S.bestHit });
    function win() {
      ctx.done(result(true));
      endScreen(root, {
        title: 'You caught them all!', icon: 'trophy',
        stats: [['caught', S.caught.length], ['accuracy', pct(S.correct, S.answered) + '%'], ['HP left', S.you.hp], ['combos', S.combos], ['best hit', S.bestHit]],
        again: ctx.restart, extra: caughtHTML(),
      });
    }
    function lose() {
      ctx.done(result(false));
      endScreen(root, {
        title: 'You fainted', icon: 'dizzy',
        stats: [['caught', S.caught.length], ['accuracy', pct(S.correct, S.answered) + '%'], ['combos', S.combos], ['best hit', S.bestHit]],
        again: ctx.restart, extra: S.caught.length ? caughtHTML() : '',
      });
    }

    frame();
    chooseMove(fillName('A wild {name} appears! Pick a move.', { name: monName() }));
    return () => { alive = false; };
  }

  Games.notemon = notemon;
})();
