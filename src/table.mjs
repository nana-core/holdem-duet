// The table: one match at a time between the human (the page) and the AI (tools), kept in a JSON file.
//   - the human's side: view / start / next / act / show / say / end (server.mjs serves them to the page);
//   - the AI's side: its tools (poker_start / poker_look / poker_act), and the letter that tells it what happened and
//     what it may do when it is its turn. The letter reaches it either through poker_wait (MCP mode: the AI asks and
//     waits) or through autoplay.mjs (auto mode: the server calls the AI itself);
//   - the records: the table in table.json, every finished hand (both hands, every step) in hands.jsonl.
// The AI never sees the human's cards before a showdown (engine.mjs viewFor); the human's page never sees the AI's.
import {appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomInt} from 'node:crypto';
import {act, cardsText, endMatch, newMatch, PokerError, showCards, startHand, viewFor} from './engine.mjs';

export const TALK_MAX = 300;
const TALK_KEEP = 2000; // a whole match's talk: the page shows all of it
const PAST_KEEP = 100;

export const TOOL_DESC = {
  poker_start: '开一场德扑（单挑无限注德州）：对方问你玩不玩、你想玩了，就自己开。上一场没打完开不了。开了马上发第一手，结果里写着规矩和你的牌；' +
    '轮到你就用 poker_act 出手，轮到对方就等。say：开的时候想对对方说的话，显示在牌桌上（可不填）。',
  poker_look: '再看一眼德扑的局面：这一手你的牌、公共牌、筹码、这一手到现在每个人做了什么、现在能做什么，还有这一场到现在的比分。',
  poker_act: '和对方打德扑时出手。action：fold 弃牌 / check 过牌 / call 跟注 / raise 加注（amount 填加注到多少，是这一轮你下注的总数）/ allin 全下。' +
    'say：想对对方说的话，会显示在牌桌上（可不填）；只写 say 不出手也行，比如一场打完了说两句。出完手又轮到你（比如翻牌了），结果里会写，接着出就行。',
  poker_wait: '等到轮到你（或者有新消息、一场打完）再返回，返回的信里写着发生了什么、你的牌和现在能做什么。轮到你就用 poker_act 出手，出完再调用 poker_wait 等下一次。' +
    '返回 waiting 说明这次没等到，接着调用就行；返回 idle 说明现在没有在打的牌局。',
};

const STREET = {preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌'};
const name = (p, me) => (p === me ? '你' : '对方');

/** One step of a hand as words, for `me` ('ai' in its letters). */
function stepText(e, me) {
  const who = name(e.who, me), all = e.allin ? '（全下）' : '';
  switch (e.action) {
    case 'sb': return `${who}小盲 ${e.amount}${all}`;
    case 'bb': return `${who}大盲 ${e.amount}${all}`;
    case 'fold': return `${who}弃牌`;
    case 'check': return `${who}过牌`;
    case 'call': return `${who}跟 ${e.amount}${all}`;
    case 'bet': return `${who}下注 ${e.amount}${all}`;
    case 'raise': return `${who}加注到 ${e.amount}${all}`;
    case 'return': return `${who}多下的 ${e.amount} 退回`;
    default: return `${who}${e.action}`;
  }
}
/** 翻牌前 对方小盲 10，你大盲 20，对方跟 10，你过牌｜翻牌 你过牌，对方下注 40 */
export function handSteps(log, me = 'ai') {
  const parts = [];
  for (const e of log) {
    const last = parts.at(-1);
    if (last?.street === e.street) last.steps.push(stepText(e, me));
    else parts.push({street: e.street, steps: [stepText(e, me)]});
  }
  return parts.map((p) => `${STREET[p.street]} ${p.steps.join('，')}`).join('｜');
}

/** What the AI may do, as words with the names it passes. */
export function legalText(L) {
  if (!L) return null;
  const out = ['弃牌 fold'];
  if (L.check) out.push('过牌 check');
  if (L.call !== null) out.push(`跟 ${L.call} call`);
  if (L.raise) out.push(L.raise.min === L.raise.max ? `全下 allin（${L.raise.max}）` : `加注 raise（amount 填加注到多少：${L.raise.min}～${L.raise.max}，${L.raise.max} 是全下）`);
  return out.join(' / ');
}

/** A finished hand in one line, for `me`. shown: the hole cards `me` may see. */
export function resultText(r, no, me = 'ai', shown = {}) {
  const other = me === 'ai' ? 'human' : 'ai';
  const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
  if (r.how === 'fold') {
    const turned = shown[other] ? `（${name(other, me)}亮了牌：${cardsText(shown[other])}）` : '';
    return r.winner === me ? `第 ${no} 手：${name(other, me)}弃牌，你收了 ${r.won}（${sign(r.net[me])}）${turned}。` : `第 ${no} 手：你弃牌，${name(other, me)}收了 ${r.won}${turned}。`;
  }
  const h = (p) => `${name(p, me)} ${cardsText(r.hands[p].holeCards ?? r.hands[p].hole ?? [])}（${r.hands[p].name}）`;
  const end = r.winner === null ? `平分 ${r.won}` : `${name(r.winner, me)}赢 ${r.won}（你 ${sign(r.net[me])}）`;
  return `第 ${no} 手摊牌：${h(other)}，${h(me)}，${end}。`;
}

const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
function writeJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + '\n', {mode: 0o600});
  renameSync(tmp, path);
}

/**
 * dir: where table.json and hands.jsonl live. aiName: how the page calls the AI. onChange(): something moved.
 * State: {version, match (engine.mjs), meta (the current match's: who opened it, what the AI has been told),
 * talk (this match's table talk), call (how reaching the AI goes, for the page), past (finished matches, newest last)}.
 */
export function createTable({dir, aiName = 'AI', mode = 'mcp', now = () => Date.now(), log = () => {}, onChange = () => {}, rnd = randomInt}) {
  const file = join(dir, 'table.json'), handsFile = join(dir, 'hands.jsonl');
  const t = readJson(file, null) ?? {version: 0, match: null, meta: null, talk: [], call: {state: 'idle'}, past: []};
  const waiters = new Set();
  let listening = 0; // poker_wait calls now waiting (MCP mode): the page says whether the AI is at the table

  function save() {
    t.version++;
    mkdirSync(dir, {recursive: true, mode: 0o700});
    writeJson(file, t);
    for (const w of [...waiters]) w();
    try { onChange(); } catch (e) { log(`onChange failed: ${e?.message ?? e}`); }
  }
  const m = () => t.match;
  const live = () => !!m()?.hand && !m().hand.result;
  const need = () => { if (!m()) throw new PokerError('NO_MATCH', '现在没有在打的牌局'); return m(); };
  /** Wait until the version is past `since` (or ms passes). */
  const wait = (since, ms = 25000) => {
    if (t.version > since) return Promise.resolve();
    return new Promise((ok) => { const done = () => { clearTimeout(timer); waiters.delete(done); ok(); }; const timer = setTimeout(done, ms); timer.unref?.(); waiters.add(done); });
  };

  /** A hand just ended: its record, and the match's end when it was the last. */
  function afterAct(before) {
    const h = m().hand;
    if (h.result && before !== h.no + ':done') {
      if (h.result.hands) for (const p of ['human', 'ai']) h.result.hands[p].holeCards = [...h.hole[p]];
      try {
        mkdirSync(dir, {recursive: true, mode: 0o700});
        appendFileSync(handsFile, JSON.stringify({match: m().id, no: h.no, at: now(), button: h.button, hole: h.hole, board: h.board, log: h.log, result: h.result}) + '\n', {mode: 0o600});
      } catch (e) { log(`hand not recorded: ${e?.message ?? e}`); }
    }
    if (m().over && !t.meta.endedAt) t.meta.endedAt = now();
  }
  const mark = () => (live() ? 'live' : m()?.hand ? `${m().hand.no}:done` : 'none');

  function ledger() {
    const done = t.past.concat(m()?.over ? [summary()] : []);
    const net = done.reduce((n, x) => n + (x.stacks.human - x.startStack), 0);
    return {matches: done.length, human: done.filter((x) => x.winner === 'human').length, ai: done.filter((x) => x.winner === 'ai').length, humanNet: net};
  }
  function summary() {
    const x = m();
    return {id: x.id, startedAt: t.meta.startedAt, startedBy: t.meta.startedBy, endedAt: t.meta.endedAt ?? null, hands: x.handNo, winner: x.winner,
      endedEarly: !!x.endedEarly, stacks: {...x.stacks}, startStack: x.startStack, said: t.talk.filter((s) => s.who === 'ai').length};
  }

  /** The AI's situation, as its letters and poker_look say it. */
  function situation() {
    const x = m(), v = viewFor(x, 'ai'), h = v.hand;
    if (!h) return '这一场还没发牌。';
    const lines = [];
    lines.push(`第 ${h.no} 手，${h.button === 'ai' ? '你是庄家、小盲' : '你是大盲（对方是庄家、小盲）'}。`);
    lines.push(`你的牌：${cardsText(h.hole.ai)}`);
    lines.push(`公共牌：${h.board.length ? `${cardsText(h.board)}（${STREET[h.street === 'showdown' ? 'river' : h.street]}）` : '还没发（翻牌前）'}`);
    const middle = h.pot + h.bets.human + h.bets.ai;
    if (h.result) lines.push(`筹码：你 ${v.stacks.ai}，对方 ${v.stacks.human}`);
    else lines.push(`桌上 ${middle}${h.bets.human || h.bets.ai ? `（这一轮对方下了 ${h.bets.human}，你下了 ${h.bets.ai}）` : ''}，你剩 ${v.stacks.ai}，对方剩 ${v.stacks.human}`);
    lines.push(`这一手：${handSteps(h.log, 'ai')}`);
    if (h.result) lines.push(resultText(h.result, h.no, 'ai', h.hole));
    else if (h.toAct === 'ai') lines.push(`轮到你：${legalText(h.legal)}`);
    else lines.push('现在轮到对方。');
    return lines.join('\n');
  }
  const score = () => { const x = m(); return `这一场：第 ${x.handNo} 手，对方 ${x.stacks.human}，你 ${x.stacks.ai}（开始各 ${x.startStack}）。`; };
  const intro = () => `${t.meta.startedBy === 'ai' ? '你' : '对方'}开了一场德扑：单挑无限注德州，各 ${m().startStack} 分，盲注 ${m().blinds.sb}/${m().blinds.bb}，` +
    '每手换庄家（庄家下小盲，翻牌前先说话，翻牌后后说话），打到一方输光或者对方说结束。用 poker_act 出手；想对对方说话写在 say 里，牌桌上会显示。';
  /** The result of the hand before this one, when the AI has not seen it yet. */
  function untoldResult() {
    const x = m(), last = x.results.at(-1);
    if (!last || last.no <= (t.meta.toldResultOf ?? 0)) return null;
    if (x.hand && x.hand.no !== last.no && !x.hand.result) return {no: last.no, text: `上一手：${resultText(last, last.no, 'ai')}`};
    return null;
  }
  const humanTalk = () => t.talk.filter((s) => s.who === 'human' && !s.told);

  const table = {
    get version() { return t.version; },
    wait,
    /** For the page: the human's view of the match, the talk, how reaching the AI goes, the totals. */
    view() {
      const x = m();
      return {version: t.version, aiName, mode, listening: listening > 0,
        match: x ? {...viewFor(x, 'human'), startStack: x.startStack, startedAt: t.meta.startedAt, startedBy: t.meta.startedBy, results: x.results.map((r) => ({no: r.no, how: r.how, winner: r.winner, won: r.won}))} : null,
        talk: t.talk, call: t.call, ledger: ledger(), past: t.past.slice(-10)};
    },

    // ---- both sides ----
    start(by = 'human') {
      if (m() && !m().over) throw new PokerError('MATCH_LIVE', '这一场还没打完');
      if (m()) { t.meta.overTold = true; t.past.push(summary()); if (t.past.length > PAST_KEEP) t.past.splice(0, t.past.length - PAST_KEEP); }
      const at = now();
      t.match = newMatch({id: `m${at.toString(36)}`, firstButton: rnd(2) ? 'ai' : 'human', startedAt: at});
      t.meta = {startedAt: at, startedBy: by, endedAt: null, introTold: by === 'ai' /* the rules are in poker_start's result */, overTold: false, toldResultOf: 0};
      t.talk = [];
      t.call = {state: 'idle'};
      startHand(t.match, {rnd});
      log(`match ${t.match.id} opened by ${by}; first button: ${t.match.hand.button}`);
      save();
      return table.view();
    },
    say(p, text) {
      const s = String(text ?? '').trim().slice(0, TALK_MAX);
      if (!s) throw new PokerError('EMPTY', '没有字');
      need();
      t.talk.push({who: p, text: s, at: now(), hand: m().handNo, ...(p === 'human' ? {told: false} : {})});
      if (t.talk.length > TALK_KEEP) t.talk.splice(0, t.talk.length - TALK_KEEP);
      save();
      return table.view();
    },

    // ---- the human's page ----
    next() { startHand(need(), {rnd}); save(); return table.view(); },
    act(p, args) { const x = need(), before = mark(); act(x, p, args); afterAct(before); save(); return table.view(); },
    show() { showCards(need(), 'human'); save(); return table.view(); },
    end() { const x = need(); endMatch(x); if (!t.meta.endedAt) t.meta.endedAt = now(); save(); return table.view(); },
    setCall(state, reason = null) { t.call = {state, at: now(), ...(reason ? {reason} : {})}; save(); },

    // ---- reaching the AI ----
    /** Whether the AI has something to hear now: {kind: 'turn'|'over', key}; the key changes whenever there is something new. */
    due() {
      const x = m();
      if (!x) return null;
      if (live() && x.hand.toAct === 'ai') return {kind: 'turn', key: `${x.id}:${x.hand.no}:${x.hand.log.length}`};
      if (x.over && !t.meta.overTold) return {kind: 'over', key: `${x.id}:over`};
      return null;
    },
    /** The letter for `due`. Nothing is marked told until told() says it went. */
    letter(due) {
      const x = m(), parts = [];
      if (!t.meta.introTold) parts.push(intro());
      const prev = untoldResult();
      if (prev) parts.push(prev.text);
      const talk = humanTalk();
      if (talk.length) parts.push(`对方在牌桌上说：${talk.map((s) => `「${s.text}」`).join('')}`);
      if (due.kind === 'over') {
        const last = x.results.at(-1);
        // only what the AI may see: the human's cards when shown (viewFor), never the raw hand
        if (last && last.no > (t.meta.toldResultOf ?? 0)) parts.push(resultText(last, last.no, 'ai', viewFor(x, 'ai').hand?.hole ?? {}));
        const L = ledger();
        const who = x.winner === 'ai' ? '你赢了' : x.winner === 'human' ? '对方赢了' : '打平了';
        parts.push(`这一场打完了${x.endedEarly ? '（对方说先到这）' : ''}：一共 ${x.handNo} 手，${who}（对方 ${x.stacks.human}，你 ${x.stacks.ai}）。` +
          `总账：打了 ${L.matches} 场，对方赢 ${L.human} 场，你赢 ${L.ai} 场。想说什么用 poker_act 只写 say。`);
      } else parts.push(situation());
      return parts.join('\n');
    },
    /** The letter went: what was in it counts as told. */
    told(due) {
      const x = m();
      t.meta.introTold = true;
      const last = x.results.at(-1);
      if (last && (due.kind === 'over' || untoldResult())) t.meta.toldResultOf = last.no;
      for (const s of t.talk) if (s.who === 'human') s.told = true;
      if (due.kind === 'over') t.meta.overTold = true;
      save();
    },
    /** poker_wait (MCP mode): until there is something for the AI, or ms passes. Marks the letter told. */
    async waitTurn(ms = 50000) {
      const until = now() + ms;
      listening++;
      if (listening === 1) save(); // the page shows the AI is at the table
      try {
        for (;;) {
          const due = table.due();
          if (due) { const letter = table.letter(due); table.told(due); return {kind: 'poker_wait', status: due.kind === 'over' ? 'match_over' : 'your_turn', letter}; }
          const left = until - now();
          if (left <= 0) return {kind: 'poker_wait', status: m() && !m().over ? 'waiting' : 'idle', ...(m() && !m().over ? {now: situation()} : {})};
          await wait(t.version, left);
        }
      } finally {
        listening--;
        if (listening === 0) save();
      }
    },

    // ---- the AI's tools ----
    call(toolName, args = {}) {
      if (toolName === 'poker_start') {
        if (m() && !m().over) return {kind: toolName, error: '这一场还没打完，接着打就行', now: situation(), score: score()};
        table.start('ai');
        if (typeof args.say === 'string' && args.say.trim()) table.say('ai', args.say);
        return {kind: toolName, started: true, rules: intro(), now: situation()};
      }
      const x = m();
      if (toolName === 'poker_look') return x ? {kind: toolName, now: situation(), score: score()} : {kind: toolName, error: '现在没有在打的牌局'};
      if (toolName !== 'poker_act') return {kind: toolName, error: `没有 ${toolName} 这个工具`};
      if (!x) return {kind: toolName, error: '现在没有在打的牌局'};
      const out = {kind: toolName};
      if (typeof args.say === 'string' && args.say.trim()) { table.say('ai', args.say); out.said = true; }
      if (args.action) {
        const before = mark(), no = x.hand?.no;
        try { act(x, 'ai', {action: args.action, amount: args.amount}); }
        catch (e) {
          if (!(e instanceof PokerError)) throw e;
          return {...out, error: e.message, now: situation()};
        }
        afterAct(before);
        const h = x.hand;
        out.did = stepText(h.log.findLast((e) => e.who === 'ai' && e.action !== 'return') ?? {who: 'ai', action: args.action}, 'ai');
        if (h.result && h.no === no) t.meta.toldResultOf = h.no; // it sees how it ended right here
        out.now = situation();
        if (h.result && x.over) out.matchOver = true;
        save();
      } else if (!out.said) out.error = '没有出手也没有说话：action 和 say 至少给一个';
      return out;
    },
  };
  return table;
}
