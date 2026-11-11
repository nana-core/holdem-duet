// Heads-up no-limit Texas hold'em between a human (on the table page) and an AI (through tools).
// This file is the game alone: deck, blinds, betting rounds, showdown. No files, no clock, no network: table.mjs
// keeps the state (plain JSON) and tells the AI when it is its turn.
// Heads-up rules: the button posts the small blind and acts first before the flop, last after it; the button moves
// every hand. With two players there are no side pots: a bet the other cannot cover goes back.
import {randomInt} from 'node:crypto';

export const PLAYERS = Object.freeze(['human', 'ai']);
export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc';
export const STREETS = Object.freeze(['preflop', 'flop', 'turn', 'river']);
const SUIT_MARK = {s: '♠', h: '♥', d: '♦', c: '♣'};
const RANK_MARK = {T: '10'};
export const CATEGORY_NAMES = Object.freeze(['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺']);
export const DEFAULT_STACK = 2000;
export const DEFAULT_BLINDS = Object.freeze({sb: 10, bb: 20});

export class PokerError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const opp = (p) => (p === 'human' ? 'ai' : 'human');
const rank = (c) => RANKS.indexOf(c[0]);
/** 'Ts' → '10♠' */
export const cardText = (c) => `${RANK_MARK[c[0]] ?? c[0]}${SUIT_MARK[c[1]]}`;
export const cardsText = (cs) => cs.map(cardText).join(' ');

export function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return d;
}
/** Fisher–Yates with crypto.randomInt: neither side can steer the deal. */
export function shuffle(deck, rnd = randomInt) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) { const j = rnd(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

// ---- hand values ----

/** Five cards → [category, ...tiebreak ranks], compared element by element. */
function score5(cs) {
  const rs = cs.map(rank).sort((a, b) => b - a);
  const flush = cs.every((c) => c[1] === cs[0][1]);
  const uniq = [...new Set(rs)];
  let high = -1;
  if (uniq.length === 5) {
    if (rs[0] - rs[4] === 4) high = rs[0];
    else if (rs[0] === 12 && rs[1] === 3) high = 3; // A-2-3-4-5: the five is high
  }
  if (high >= 0) return [flush ? 8 : 4, high];
  if (flush) return [5, ...rs];
  const counts = new Map();
  for (const r of rs) counts.set(r, (counts.get(r) ?? 0) + 1);
  // groups by size, then rank: quads first, then trips, pairs, singles
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map((g) => g[1]).join('');
  const order = groups.map((g) => g[0]);
  const cat = {41: 7, 32: 6, 311: 3, 221: 2, 2111: 1, 11111: 0}[shape];
  return [cat, ...order];
}

export function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** The best five of five to seven cards: {score, cards, name}. */
export function bestHand(cards) {
  if (cards.length < 5) throw new PokerError('TOO_FEW_CARDS', '不到五张牌');
  let best = null;
  const n = cards.length;
  const pick = (start, chosen) => {
    if (chosen.length === 5) {
      const score = score5(chosen);
      if (!best || compareScores(score, best.score) > 0) best = {score, cards: [...chosen]};
      return;
    }
    for (let i = start; i <= n - (5 - chosen.length); i++) { chosen.push(cards[i]); pick(i + 1, chosen); chosen.pop(); }
  };
  pick(0, []);
  return {...best, name: handName(best.score)};
}

export function handName(score) {
  if (score[0] === 8 && score[1] === 12) return '皇家同花顺';
  return CATEGORY_NAMES[score[0]];
}

// ---- a match (一场): two stacks, many hands ----

/**
 * A new match. firstButton: who has the button in hand 1 (the table picks at random).
 * Everything in it is plain JSON, so the table can save and load it as it is.
 */
export function newMatch({id, stack = DEFAULT_STACK, blinds = DEFAULT_BLINDS, firstButton = 'human', startedAt = null} = {}) {
  if (!PLAYERS.includes(firstButton)) throw new PokerError('BAD_PLAYER', `没有 ${firstButton} 这个人`);
  return {id: id ?? null, startedAt, blinds: {...blinds}, startStack: stack, stacks: {human: stack, ai: stack},
    handNo: 0, nextButton: firstButton, hand: null, over: false, winner: null, results: []};
}

const live = (m) => m.hand && !m.hand.result;

/** Deal the next hand: shuffle, blinds, hole cards. deck: a fixed order for tests (top card first). */
export function startHand(m, {deck = null, rnd = randomInt} = {}) {
  if (m.over) throw new PokerError('MATCH_OVER', '这一场已经打完了');
  if (live(m)) throw new PokerError('HAND_LIVE', '这一手还没打完');
  const button = m.nextButton, other = opp(button);
  const d = deck ? [...deck] : shuffle(newDeck(), rnd);
  const h = {
    no: m.handNo + 1, button, deck: d, board: [],
    hole: {[button]: [], [other]: []},
    street: 'preflop', pot: 0, bets: {human: 0, ai: 0}, acted: {human: false, ai: false},
    currentBet: 0, minRaise: m.blinds.bb, toAct: null, folded: null,
    startStacks: {...m.stacks}, log: [], result: null, shown: [],
  };
  // two cards each, one at a time, starting with the player who is not the button
  for (let i = 0; i < 2; i++) { h.hole[other].push(d.shift()); h.hole[button].push(d.shift()); }
  m.hand = h;
  m.handNo = h.no;
  m.nextButton = other;
  post(m, button, m.blinds.sb, 'sb');
  post(m, other, m.blinds.bb, 'bb');
  h.currentBet = Math.max(h.bets.human, h.bets.ai);
  beginBetting(m);
  return h;
}

function post(m, p, amount, kind) {
  const n = Math.min(amount, m.stacks[p]);
  m.stacks[p] -= n;
  m.hand.bets[p] += n;
  m.hand.log.push({street: 'preflop', who: p, action: kind, amount: n, ...(m.stacks[p] === 0 ? {allin: true} : {})});
}

/** Does p still have to do something this street? */
function needsAction(m, p) {
  const h = m.hand, o = opp(p);
  if (h.folded || m.stacks[p] === 0) return false;
  if (m.stacks[o] === 0 && h.bets[p] >= h.bets[o]) return false; // the other is all-in and covered: nothing to decide
  return !h.acted[p] || h.bets[p] < h.currentBet;
}

/** Start (or skip) the betting of the current street. */
function beginBetting(m) {
  const h = m.hand;
  const first = h.street === 'preflop' ? h.button : opp(h.button);
  if (needsAction(m, first)) h.toAct = first;
  else if (needsAction(m, opp(first))) h.toAct = opp(first);
  else closeStreet(m);
}

/** What p may do now (null when it is not p's turn). Amounts are chips; raise.min/max are "raise to" totals for this street. */
export function legalActions(m, p) {
  const h = m.hand;
  if (!live(m) || h.toAct !== p) return null;
  const diff = h.currentBet - h.bets[p];
  const stack = m.stacks[p];
  const out = {fold: true, check: diff === 0, call: diff > 0 ? Math.min(diff, stack) : null, raise: null};
  if (m.stacks[opp(p)] > 0 && stack > diff) {
    const max = h.bets[p] + stack;
    out.raise = {min: Math.min(h.currentBet + h.minRaise, max), max};
  }
  return out;
}

/**
 * p acts: {action: 'fold'|'check'|'call'|'raise'|'bet'|'allin', amount?} (amount: raise to this much in total this street).
 * Lenient where it cannot be misread: call with nothing to call is a check; bet is raise. A wrong move throws PokerError
 * with a line that says why and what is possible, and changes nothing.
 */
export function act(m, p, {action, amount} = {}) {
  if (!PLAYERS.includes(p)) throw new PokerError('BAD_PLAYER', `没有 ${p} 这个人`);
  if (!live(m)) throw new PokerError('NO_HAND', '现在没有在打的牌');
  const h = m.hand;
  if (h.toAct !== p) throw new PokerError('NOT_YOUR_TURN', '还没轮到你');
  const L = legalActions(m, p);
  let a = String(action ?? '').toLowerCase().trim();
  if (a === 'bet') a = 'raise';
  if (a === 'call' && L.call === null) a = 'check';
  if (a === 'allin' || a === 'all-in' || a === 'all_in') {
    if (L.raise) { a = 'raise'; amount = L.raise.max; } else if (L.call !== null) a = 'call'; else a = 'check';
  }
  const record = (entry) => h.log.push({street: h.street, who: p, ...entry, ...(m.stacks[p] === 0 && entry.action !== 'fold' && entry.action !== 'check' ? {allin: true} : {})});
  if (a === 'fold') {
    h.folded = p;
    record({action: 'fold'});
    finishFold(m);
    return h;
  }
  if (a === 'check') {
    if (!L.check) throw new PokerError('CANNOT_CHECK', `现在不能过牌：要跟 ${L.call}，或者弃牌${L.raise ? `、加注到 ${L.raise.min}～${L.raise.max}` : ''}`);
    h.acted[p] = true;
    record({action: 'check'});
  } else if (a === 'call') {
    const n = L.call;
    m.stacks[p] -= n; h.bets[p] += n; h.acted[p] = true;
    record({action: 'call', amount: n});
  } else if (a === 'raise') {
    if (!L.raise) throw new PokerError('CANNOT_RAISE', `现在不能加注${L.call !== null ? `：只能跟 ${L.call} 或弃牌` : '：只能过牌'}`);
    const to = Number(amount);
    if (!Number.isInteger(to)) throw new PokerError('BAD_AMOUNT', `加注要给一个整数：加注到多少（${L.raise.min}～${L.raise.max}）`);
    if (to > L.raise.max) throw new PokerError('TOO_MUCH', `最多加注到 ${L.raise.max}（全下）`);
    if (to < L.raise.min) throw new PokerError('TOO_LITTLE', `加注至少到 ${L.raise.min}${L.raise.min < L.raise.max ? `，最多 ${L.raise.max}` : ''}`);
    const opened = h.currentBet === 0; // nothing to raise yet: a bet (after the flop; before it the blinds are there)
    const n = to - h.bets[p];
    m.stacks[p] -= n; h.bets[p] = to;
    if (to - h.currentBet >= h.minRaise) h.minRaise = to - h.currentBet; // a short all-in does not change the step
    h.currentBet = to;
    h.acted[p] = true;
    h.acted[opp(p)] = false;
    record({action: opened ? 'bet' : 'raise', amount: to});
  } else throw new PokerError('BAD_ACTION', `不认识的动作「${action}」：fold / check / call / raise / allin`);
  const o = opp(p);
  if (needsAction(m, o)) h.toAct = o;
  else if (needsAction(m, p)) h.toAct = p;
  else closeStreet(m);
  return h;
}

/** The street is done: give back what was not called, gather the bets, deal on (or show down). */
function closeStreet(m) {
  const h = m.hand;
  const [hi, lo] = h.bets.human >= h.bets.ai ? ['human', 'ai'] : ['ai', 'human'];
  const back = h.bets[hi] - h.bets[lo];
  if (back > 0) { m.stacks[hi] += back; h.bets[hi] -= back; h.log.push({street: h.street, who: hi, action: 'return', amount: back}); }
  h.pot += h.bets.human + h.bets.ai;
  h.bets = {human: 0, ai: 0};
  h.acted = {human: false, ai: false};
  h.currentBet = 0;
  h.minRaise = m.blinds.bb;
  h.toAct = null;
  const i = STREETS.indexOf(h.street);
  if (i === STREETS.length - 1) return showdown(m);
  h.street = STREETS[i + 1];
  h.deck.shift(); // burn
  h.board.push(...h.deck.splice(0, h.street === 'flop' ? 3 : 1));
  beginBetting(m);
}

function finishFold(m) {
  const h = m.hand, w = opp(h.folded);
  const won = h.pot + h.bets.human + h.bets.ai;
  h.pot = 0; h.bets = {human: 0, ai: 0}; h.toAct = null;
  m.stacks[w] += won;
  endHand(m, {how: 'fold', winner: w, won, net: net(m)});
}

function showdown(m) {
  const h = m.hand;
  h.street = 'showdown';
  const hands = {human: bestHand([...h.hole.human, ...h.board]), ai: bestHand([...h.hole.ai, ...h.board])};
  const c = compareScores(hands.human.score, hands.ai.score);
  const won = h.pot;
  h.pot = 0;
  let winner = null;
  if (c === 0) {
    const half = Math.floor(won / 2);
    const odd = won - 2 * half; // the odd chip goes to the player out of position (not the button)
    m.stacks.human += half; m.stacks.ai += half; m.stacks[opp(h.button)] += odd;
  } else { winner = c > 0 ? 'human' : 'ai'; m.stacks[winner] += won; }
  h.shown = [...PLAYERS];
  const show = (p) => ({name: hands[p].name, cards: hands[p].cards});
  endHand(m, {how: 'showdown', winner, won, net: net(m), hands: {human: show('human'), ai: show('ai')}});
}

const net = (m) => ({human: m.stacks.human - m.hand.startStacks.human, ai: m.stacks.ai - m.hand.startStacks.ai});

function endHand(m, result) {
  const h = m.hand;
  h.result = result;
  m.results.push({no: h.no, ...result, board: [...h.board]});
  if (m.stacks.human === 0 || m.stacks.ai === 0) { m.over = true; m.winner = m.stacks.human === 0 ? 'ai' : 'human'; }
}

/** After a hand: a player turns their cards up for the other (a player folded and wants the other to see, say). */
export function showCards(m, p) {
  const h = m.hand;
  if (!h?.result) throw new PokerError('HAND_LIVE', '这一手还没打完，不能亮牌');
  if (!h.shown.includes(p)) h.shown.push(p);
  return h;
}

/** The human ends the match early (between hands only). */
export function endMatch(m) {
  if (live(m)) throw new PokerError('HAND_LIVE', '这一手打完再结束');
  if (!m.over) { m.over = true; m.winner = m.stacks.human === m.stacks.ai ? null : m.stacks.human > m.stacks.ai ? 'human' : 'ai'; m.endedEarly = true; }
  return m;
}

/**
 * What one side may see: their own cards always, the other's only once shown (showdown, or turned up after the hand).
 * The deck never leaves this file. This is what the page gets for the human and what the AI's letters are made from.
 */
export function viewFor(m, p) {
  const h = m.hand;
  const base = {matchId: m.id, you: p, blinds: m.blinds, stacks: {...m.stacks}, handNo: m.handNo, over: m.over, winner: m.winner,
    ...(m.endedEarly ? {endedEarly: true} : {})};
  if (!h) return {...base, hand: null};
  return {...base, hand: {
    no: h.no, button: h.button, street: h.street, board: [...h.board], pot: h.pot, bets: {...h.bets}, toAct: h.toAct,
    hole: {[p]: [...h.hole[p]], ...(h.shown.includes(opp(p)) ? {[opp(p)]: [...h.hole[opp(p)]]} : {})},
    log: h.log.map((e) => ({...e})), legal: legalActions(m, p), result: h.result ? structuredClone(h.result) : null, // a fold shows no hands
  }};
}
