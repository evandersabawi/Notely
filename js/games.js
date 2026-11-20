// Game modes + quiz. Each game is a function (root, creation, ctx) that renders
// into `root` and returns a cleanup function. ctx = { done(result), player(), restart() }.
const Games = (() => {
  const I = Icons.icon;
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const pct = (a, b) => b ? Math.round(a / b * 100) : 0;

  // Build a pool of multiple-choice questions from Claude's questions + the flash cards.
  function buildMC(c) {
    const fromQ = (c.questions || [])
      .filter(q => Array.isArray(q.choices) && q.choices.length >= 2 && q.answer >= 0 && q.answer < q.choices.length)
      .map(q => ({ q: q.question, choices: q.choices, answer: q.answer, explanation: q.explanation || '' }));
    const backs = [...new Set((c.cards || []).map(k => k.back))];
    const fromCards = (c.cards || []).map(k => {
      const distractors = shuffle(backs.filter(b => b !== k.back)).slice(0, 3);
      if (distractors.length < 2) return null;
      const choices = shuffle([k.back, ...distractors]);
      return { q: k.front, choices, answer: choices.indexOf(k.back), explanation: '' };
    }).filter(Boolean);
    return shuffle([...fromQ, ...fromCards]);
  }

  function choicesHTML(item) {
    return `<div class="choices">${item.choices.map((ch, i) =>
      `<button class="choice" data-i="${i}"><span class="letter">${'ABCD'[i] || i + 1}</span><span>${esc(ch)}</span></button>`).join('')}</div>`;
  }
  // Wire choice buttons; resolves with {correct, picked}. Shows feedback.
  function askChoices(panel, item) {
    return new Promise(resolve => {
      const btns = [...panel.querySelectorAll('.choice')];
      btns.forEach(b => b.onclick = () => {
        const i = +b.dataset.i;
        btns.forEach(x => x.disabled = true);
        btns[item.answer].classList.add('correct');
        if (i !== item.answer) b.classList.add('wrong');
        resolve({ correct: i === item.answer, picked: i });
      });
    });
  }

  // ---------- short written answers ----------
  // Lenient marking: ignores case, accents, punctuation, extra spaces and a leading "the/a/an", and
  // allows a small typo (more for longer answers). Numbers must match exactly.
  const ARTICLES = /^(the|a|an|el|la|los|las|le|les|l|der|die|das|il|lo|gli|o|os|as|un|une|una|uno|ein|eine)\s+/;
  function norm(s) {
    let t = String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    t = t.replace(ARTICLES, '');
    return t;
  }
  function editDistance(a, b) {
    if (a === b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  // Variants of an answer worth accepting: the whole thing, the part before a bracket, and the part inside it
  // ("RuBP (ribulose bisphosphate)" accepts either), and each side of " / ".
  function variants(ans) {
    const out = [ans];
    const m = String(ans).match(/^(.*?)\s*\((.+)\)\s*$/);
    if (m) out.push(m[1], m[2]);
    if (/\s\/\s/.test(ans)) out.push(...ans.split(/\s\/\s/));
    return out;
  }
  function markWritten(typed, item) {
    const t = norm(typed);
    if (!t) return false;
    const digits = x => (x.match(/\d+/g) || []).join(' ');
    return [item.answer, ...(item.accepted || [])].flatMap(variants).map(norm).filter(Boolean).some(a => {
      if (a === t) return true;
      if (digits(a) !== digits(t)) return false;
      const len = [...a].length;
      const tol = len <= 4 ? 0 : len <= 12 ? 1 : 2;
      return editDistance([...a], [...t]) <= tol;
    });
  }
  function writtenHTML() {
    return `<form class="written" autocomplete="off">
      <input class="input" id="typed" type="text" placeholder="Type your answer" aria-label="Your answer" autocapitalize="off" spellcheck="false" enterkeyhint="done">
      <div class="row"><button class="btn primary" type="submit">${I('check')} Check</button><button class="btn ghost" type="button" id="idk">I don't know</button></div>
    </form>`;
  }
  // Wire the answer box; resolves with {correct, typed}.
  function askWritten(panel, item) {
    return new Promise(resolve => {
      const form = panel.querySelector('.written'), input = form.querySelector('#typed');
      const finish = typed => {
        form.querySelectorAll('input, button').forEach(x => x.disabled = true);
        form.querySelector('.row').hidden = true;
        const correct = markWritten(typed, item);
        input.classList.add(correct ? 'correct' : 'wrong');
        resolve({ correct, typed });
      };
      form.onsubmit = e => { e.preventDefault(); if (!input.value.trim()) return input.focus(); finish(input.value.trim()); };
      form.querySelector('#idk').onclick = () => finish('');
      setTimeout(() => input.focus(), 0);
    });
  }
  // Up to about a quarter of the quiz as written questions: Claude's own first, then flash cards whose
  // answer is short enough to type (older sets have no written questions).
  function buildWritten(c, want) {
    const authored = (c.written || []).filter(q => q && q.question && q.answer)
      .map(q => ({ kind: 'written', q: q.question, answer: q.answer, accepted: q.accepted || [], explanation: q.explanation || '' }));
    if (authored.length) return shuffle(authored).slice(0, want);
    const short = (c.cards || []).filter(k => k.back.split(/\s+/).length <= 3 && k.back.length <= 30 && !/,|\band\b/.test(k.back))
      .map(k => ({ kind: 'written', q: k.front, answer: k.back, accepted: [], explanation: '' }));
    return shuffle(short).slice(0, want);
  }

  function endScreen(root, { title, icon, stats, again, extra = '' }) {
    root.innerHTML = `<div class="end">
      <div class="end-ico">${I(icon)}</div>
      <h2>${esc(title)}</h2>
      <div class="stat-row">${stats.map(([k, v]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>
      ${extra}
      <div class="row center"><button class="btn primary" id="again">${I('repeat')} Play again</button><a class="btn ghost" href="#creations">Back to creations</a></div>
    </div>`;
    root.querySelector('#again').onclick = again;
  }

  // ---------------- Flash Cards ----------------
  function flash(root, c, ctx) {
    let queue = shuffle(c.cards), total = queue.length, done = 0, again = 0, flipped = false;
    function render() {
      if (!queue.length) return end();
      const card = queue[0];
      root.innerHTML = `
        <div class="game-top"><span>${done}/${total} learned</span><span>${again} repeat${again === 1 ? '' : 's'}</span></div>
        <div class="progress"><i style="width:${pct(done, total)}%"></i></div>
        <div class="flashcard ${flipped ? 'flipped' : ''}" id="fc" role="button" tabindex="0">
          <div class="fc-inner">
            <div class="fc-face fc-front"><small>PROMPT</small><p>${esc(card.front)}</p><em>tap to flip</em></div>
            <div class="fc-face fc-back"><small>ANSWER</small><p>${esc(card.back)}</p></div>
          </div>
        </div>
        <div class="row"><button class="btn bad" id="again">${I('repeat')} Again</button><button class="btn ok" id="got">${I('check')} Got it</button></div>`;
      const fc = root.querySelector('#fc');
      const flip = () => { flipped = !flipped; fc.classList.toggle('flipped', flipped); };
      fc.onclick = flip;
      fc.onkeydown = e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } };
      root.querySelector('#again').onclick = () => { queue.push(queue.shift()); again++; flipped = false; render(); };
      root.querySelector('#got').onclick = () => { queue.shift(); done++; flipped = false; render(); };
    }
    function end() {
      ctx.done({ type: 'flash', cards: total, repeats: again });
      endScreen(root, { title: 'Deck complete', icon: 'award', stats: [['cards', total], ['repeats', again]], again: ctx.restart });
    }
    render();
    return () => {};
  }

  // ---------------- Notemon (battle) ----------------
  function notemon(root, c, ctx) {
    const monsters = (c.monsters && c.monsters.length ? c.monsters : []).slice(0, 5);
    while (monsters.length < 5) monsters.push({ name: 'Wild Notemon ' + (monsters.length + 1) });
    let pool = buildMC(c), qi = 0;
    const maxHP = 100;
    let hp = maxHP, mi = 0, mhp = 0, mmax = 0, streak = 0, caught = [], answered = 0, correctCount = 0;
    const nextQ = () => { if (qi >= pool.length) { pool = buildMC(c); qi = 0; } return pool[qi++]; };
    function startMonster() { mmax = 60 + mi * 25; mhp = mmax; }
    startMonster();

    function arenaHTML(m) {
      return `
      <div class="arena">
        <div class="fighter player">
          <div class="sprite" id="p-sprite">${ctx.player()}</div>
          <div class="hpbar"><i id="p-hp" style="width:${pct(hp, maxHP)}%"></i></div>
          <div class="hpnum">You ${hp}/${maxHP}</div>
        </div>
        <div class="vs">VS</div>
        <div class="fighter monster">
          <div class="sprite" id="m-sprite">${Icons.monster(mi)}</div>
          <div class="hpbar mon"><i id="m-hp" style="width:${pct(mhp, mmax)}%"></i></div>
          <div class="hpnum">${esc(m.name)} ${mhp}/${mmax}</div>
        </div>
        <div class="float" id="float"></div>
      </div>`;
    }

    function render(msg) {
      const m = monsters[mi];
      const item = nextQ();
      root.innerHTML = `
        <div class="game-top"><span>Monster ${mi + 1}/${monsters.length}</span><span>${I('flame')} streak ${streak}</span><span>${I('box')} ${caught.length} caught</span></div>
        ${arenaHTML(m)}
        <div class="battle-log" id="log">${esc(msg || `A wild ${m.name} appears! Answer to attack.`)}</div>
        <div class="qpanel"><p class="qtext">${esc(item.q)}</p>${choicesHTML(item)}</div>`;
      askChoices(root, item).then(async ({ correct }) => {
        answered++;
        const log = root.querySelector('#log');
        const fl = root.querySelector('#float');
        if (correct) {
          correctCount++; streak++;
          const crit = streak >= 3;
          const dmg = Math.round((20 + 5 * Math.min(streak, 4)) * (crit ? 1.5 : 1));
          mhp = Math.max(0, mhp - dmg);
          root.querySelector('#m-sprite').classList.add('hit');
          root.querySelector('#m-hp').style.width = pct(mhp, mmax) + '%';
          fl.textContent = (crit ? 'CRIT ' : '') + '-' + dmg; fl.className = 'float show mon';
          log.textContent = crit ? `Critical hit! ${m.name} takes ${dmg} damage!` : `Direct hit! ${m.name} takes ${dmg} damage.`;
          await wait(1000);
          if (mhp <= 0) {
            caught.push({ ...m, index: mi });
            hp = Math.min(maxHP, hp + 15);
            mi++;
            if (mi >= monsters.length) return win();
            startMonster();
            return render(`You caught ${m.name}! You recover 15 HP. ${monsters[mi].name} appears!`);
          }
          render(`${m.name} has ${mhp} HP left. Keep going!`);
        } else {
          streak = 0;
          const dmg = 12 + mi * 4;
          hp = Math.max(0, hp - dmg);
          root.querySelector('#p-sprite').classList.add('hit');
          root.querySelector('#p-hp').style.width = pct(hp, maxHP) + '%';
          fl.textContent = '-' + dmg; fl.className = 'float show me';
          log.textContent = `Wrong! The answer was "${item.choices[item.answer]}". ${m.name} hits you for ${dmg}.` + (item.explanation ? ' ' + item.explanation : '');
          await wait(item.explanation ? 2600 : 1600);
          if (hp <= 0) return lose();
          render(`Shake it off. ${m.name} still has ${mhp} HP.`);
        }
      });
    }
    const caughtHTML = () => `<div class="caught">${caught.map(m => `<span title="${esc(m.name)}">${Icons.monster(m.index)}</span>`).join('')}</div>`;
    function win() {
      ctx.done({ type: 'notemon', caught: caught.length, won: true, accuracy: pct(correctCount, answered) });
      endScreen(root, {
        title: 'You caught them all!', icon: 'trophy',
        stats: [['caught', caught.length], ['accuracy', pct(correctCount, answered) + '%'], ['HP left', hp]],
        again: ctx.restart, extra: caughtHTML(),
      });
    }
    function lose() {
      ctx.done({ type: 'notemon', caught: caught.length, won: false, accuracy: pct(correctCount, answered) });
      endScreen(root, {
        title: 'You fainted', icon: 'dizzy',
        stats: [['caught', caught.length], ['accuracy', pct(correctCount, answered) + '%']],
        again: ctx.restart, extra: caught.length ? caughtHTML() : '',
      });
    }
    render();
    return () => {};
  }

  // ---------------- Match (memory pairs) ----------------
  function match(root, c, ctx) {
    const pairs = c.cards.slice().sort((a, b) => (a.front.length + a.back.length) - (b.front.length + b.back.length)).slice(0, 8);
    const tiles = shuffle(pairs.flatMap((p, i) => [{ id: i, text: p.front, side: 'front' }, { id: i, text: p.back, side: 'back' }]));
    let open = [], matched = new Set(), moves = 0, lock = false, start = Date.now(), timer;
    root.innerHTML = `
      <div class="game-top"><span id="moves">0 moves</span><span id="time">0:00</span><span id="left">${pairs.length} pairs left</span></div>
      <div class="match-grid ${tiles.length <= 12 ? 'small' : ''}">${tiles.map((t, i) =>
        `<button class="mtile ${t.side}" data-i="${i}"><span class="tile-back">?</span><span class="tile-front">${esc(t.text)}</span></button>`).join('')}</div>`;
    const fmt = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    timer = setInterval(() => { const t = root.querySelector('#time'); if (t) t.textContent = fmt(Math.floor((Date.now() - start) / 1000)); }, 500);
    const btns = [...root.querySelectorAll('.mtile')];
    btns.forEach(b => b.onclick = async () => {
      const i = +b.dataset.i;
      if (lock || open.includes(i) || matched.has(i)) return;
      b.classList.add('open'); open.push(i);
      if (open.length < 2) return;
      moves++; root.querySelector('#moves').textContent = moves + ' moves';
      const [a, z] = open;
      if (tiles[a].id === tiles[z].id && tiles[a].side !== tiles[z].side) {
        matched.add(a); matched.add(z);
        btns[a].classList.add('matched'); btns[z].classList.add('matched');
        open = [];
        root.querySelector('#left').textContent = (pairs.length - matched.size / 2) + ' pairs left';
        if (matched.size === tiles.length) {
          clearInterval(timer);
          const secs = Math.floor((Date.now() - start) / 1000);
          ctx.done({ type: 'match', moves, secs });
          await wait(500);
          endScreen(root, { title: 'All matched', icon: 'grid', stats: [['moves', moves], ['time', fmt(secs)], ['pairs', pairs.length]], again: ctx.restart });
        }
      } else {
        lock = true;
        await wait(750);
        btns[a].classList.remove('open'); btns[z].classList.remove('open');
        btns[a].classList.add('shake'); btns[z].classList.add('shake');
        setTimeout(() => { btns[a].classList.remove('shake'); btns[z].classList.remove('shake'); }, 400);
        open = []; lock = false;
      }
    });
    return () => clearInterval(timer);
  }

  // ---------------- Blitz (timed) ----------------
  function blitz(root, c, ctx) {
    const DURATION = 60;
    let pool = buildMC(c), qi = 0, score = 0, streak = 0, answered = 0, correct = 0, left = DURATION, timer, over = false;
    const nextQ = () => { if (qi >= pool.length) { pool = buildMC(c); qi = 0; } return pool[qi++]; };
    root.innerHTML = `
      <div class="game-top"><span>${I('star')} <b id="score">0</b></span><span id="mult">x1</span><span>${I('timer')} <b id="left">${DURATION}</b>s</span></div>
      <div class="progress timer"><i id="bar" style="width:100%"></i></div>
      <div id="q"></div>`;
    const bar = root.querySelector('#bar');
    timer = setInterval(() => {
      left--;
      const l = root.querySelector('#left'); if (l) l.textContent = left;
      bar.style.width = pct(left, DURATION) + '%';
      if (left <= 0) finish();
    }, 1000);
    function mult() { return Math.min(4, 1 + Math.floor(streak / 3)); }
    function ask() {
      if (over) return;
      const item = nextQ();
      const q = root.querySelector('#q');
      q.innerHTML = `<div class="qpanel"><p class="qtext">${esc(item.q)}</p>${choicesHTML(item)}</div>`;
      askChoices(q, item).then(async r => {
        if (over) return;
        answered++;
        if (r.correct) { correct++; streak++; score += 100 * mult(); }
        else streak = 0;
        root.querySelector('#score').textContent = score;
        root.querySelector('#mult').textContent = 'x' + mult() + (streak ? ` (${streak} streak)` : '');
        await wait(r.correct ? 350 : 900);
        ask();
      });
    }
    function finish() {
      over = true; clearInterval(timer);
      ctx.done({ type: 'blitz', score, answered, correct });
      endScreen(root, { title: "Time's up", icon: 'zap', stats: [['score', score], ['answered', answered], ['accuracy', pct(correct, answered) + '%']], again: ctx.restart });
    }
    ask();
    return () => { over = true; clearInterval(timer); };
  }

  // ---------------- Quiz (normal) ----------------
  function quiz(root, c, ctx) {
    let items = buildMC(c).filter(i => i.choices.length === 4);
    // Prefer Claude-written questions (they have explanations); top up with card questions to at least 10.
    const authored = items.filter(i => i.explanation);
    const extra = items.filter(i => !i.explanation);
    items = [...authored, ...extra.slice(0, Math.max(0, 10 - authored.length))];
    if (!items.length) items = buildMC(c);
    // Mix in short written answers: about one question in four.
    const written = buildWritten(c, Math.max(2, Math.round(items.length / 3)));
    const usedQ = new Set(written.map(w => w.q));
    items = shuffle([...items.filter(i => !usedQ.has(i.q)), ...written]);
    const total = items.length;
    let idx = 0, score = 0, missed = [];
    function render() {
      if (idx >= total) return end();
      const item = items[idx], isWritten = item.kind === 'written';
      root.innerHTML = `
        <div class="game-top"><span>Question ${idx + 1}/${total}</span><span>${I('check')} ${score}</span></div>
        <div class="progress"><i style="width:${pct(idx, total)}%"></i></div>
        <div class="qpanel">${isWritten ? '<p class="qkind">Type the answer</p>' : ''}<p class="qtext">${esc(item.q)}</p>${isWritten ? writtenHTML() : choicesHTML(item)}
          <div class="feedback" id="fb" hidden></div>
          <div class="row right"><button class="btn ghost" id="override" hidden>${I('check')} I was right</button><button class="btn primary" id="next" hidden>${idx + 1 === total ? 'See results' : 'Next'} ${I('arrowRight')}</button></div>
        </div>`;
      const asked = isWritten ? askWritten(root, item) : askChoices(root, item);
      asked.then(({ correct, picked, typed }) => {
        const miss = isWritten ? { ...item, typed } : { ...item, picked };
        if (correct) score++; else missed.push(miss);
        const fb = root.querySelector('#fb');
        const answerText = isWritten ? item.answer : item.choices[item.answer];
        fb.hidden = false;
        fb.className = 'feedback ' + (correct ? 'good' : 'bad');
        fb.innerHTML = (correct
          ? '<b>Correct.</b> ' + (isWritten && norm(typed) !== norm(item.answer) ? `The answer is <b class="ans">${esc(answerText)}</b>. ` : '')
          : `<b>Not quite.</b> The answer is <b class="ans">${esc(answerText)}</b>. `) + esc(item.explanation || '');
        const n = root.querySelector('#next');
        n.hidden = false; n.focus();
        n.onclick = () => { idx++; render(); };
        // Marking is automatic, so let the student overrule it when they typed a right answer in other words.
        const o = root.querySelector('#override');
        if (isWritten && !correct && typed) {
          o.hidden = false;
          o.onclick = () => {
            score++; missed.splice(missed.indexOf(miss), 1);
            fb.className = 'feedback good';
            fb.innerHTML = `<b>Counted as correct.</b> The answer is <b class="ans">${esc(answerText)}</b>. ` + esc(item.explanation || '');
            root.querySelector('#typed').classList.replace('wrong', 'correct');
            root.querySelector('.game-top span:last-child').innerHTML = `${I('check')} ${score}`;
            o.hidden = true; n.focus();
          };
        }
      });
    }
    function end() {
      const p = pct(score, total);
      ctx.done({ type: 'quiz', score, total, pct: p });
      const yours = m => m.kind === 'written' ? (m.typed ? `You: ${esc(m.typed)}` : 'No answer') : `You: ${esc(m.choices[m.picked])}`;
      const right = m => esc(m.kind === 'written' ? m.answer : m.choices[m.answer]);
      const review = missed.length ? `<div class="review"><h3>Review (${missed.length})</h3>${missed.map(m =>
        `<div class="review-item"><p>${esc(m.q)}</p><div><span class="pill bad">${yours(m)}</span> <span class="pill good">Answer: ${right(m)}</span></div>${m.explanation ? `<small>${esc(m.explanation)}</small>` : ''}</div>`).join('')}</div>` : '';
      endScreen(root, {
        title: p >= 90 ? 'Outstanding' : p >= 70 ? 'Nice work' : 'Keep studying',
        icon: p >= 90 ? 'trophy' : p >= 70 ? 'award' : 'book',
        stats: [['score', `${score}/${total}`], ['percent', p + '%']],
        again: ctx.restart, extra: review,
      });
    }
    render();
    return () => {};
  }

  return { flash, notemon, match, blitz, quiz };
})();
