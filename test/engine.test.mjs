// The engine (engine.mjs): hand values, heads-up blinds and order, raises, all-ins, showdown. Fixed decks, no files.
import test from 'node:test';
import assert from 'node:assert/strict';
import {act, bestHand, cardText, compareScores, endMatch, legalActions, newDeck, newMatch, opp, shuffle, showCards, startHand, viewFor} from '../src/engine.mjs';

const best = (s) => bestHand(s.split(' '));
const cmp = (a, b) => compareScores(best(a).score, best(b).score);

/** A deck that deals these hole cards and this board (burns in between), the rest in order after. */
function deckFor({button, holes, board}) {
  const other = opp(button);
  const top = [holes[other][0], holes[button][0], holes[other][1], holes[button][1], 'x1', ...board.slice(0, 3), 'x2', board[3], 'x3', board[4]];
  const used = new Set(top);
  const rest = newDeck().filter((c) => !used.has(c));
  // the burns are real cards from the rest
  const burns = rest.splice(0, 3);
  return top.map((c) => (c === 'x1' ? burns[0] : c === 'x2' ? burns[1] : c === 'x3' ? burns[2] : c)).concat(rest);
}
const chips = (m) => m.stacks.human + m.stacks.ai + (m.hand ? m.hand.pot + m.hand.bets.human + m.hand.bets.ai : 0);

test('hand values: every category, the wheel, kickers, the best five of seven', () => {
  assert.equal(best('As Ks Qs Js Ts').name, '皇家同花顺');
  assert.equal(best('9h 8h 7h 6h 5h').name, '同花顺');
  assert.equal(best('Ac Ad Ah As 2c').name, '四条');
  assert.equal(best('Kc Kd Kh 2s 2c').name, '葫芦');
  assert.equal(best('Ac 9c 7c 4c 2c').name, '同花');
  assert.equal(best('Ac 2d 3h 4s 5c').name, '顺子');
  assert.equal(best('7c 7d 7h Ks 2c').name, '三条');
  assert.equal(best('7c 7d 4h 4s 2c').name, '两对');
  assert.equal(best('7c 7d 4h 3s 2c').name, '一对');
  assert.equal(best('Ac Jd 9h 4s 2c').name, '高牌');
  assert.equal(cmp('Ac 2d 3h 4s 5c', '2c 3d 4h 5s 6c'), -1); // the wheel is the lowest straight
  assert.equal(cmp('Ac Kd Qh Js Tc', '9c Td Jh Qs Kc'), 1);
  assert.equal(cmp('2c 4c 6c 8c Tc', 'Ac Kd Qh Js Tc'), 1); // flush over straight
  assert.equal(cmp('Kc Kd Kh 2s 2c', 'Qc Qd Qh As Ac'), 1); // full houses by the trips
  assert.equal(cmp('7c 7d 4h 4s Ac', '7h 7s 4c 4d Kc'), 1); // two pair kicker
  assert.equal(cmp('Ac Ad 9h 4s 2c', 'Ah As 9c 4d 3c'), -1); // pair, last kicker
  assert.equal(cmp('Ac Ad 9h 4s 2c', 'Ah As 9c 4d 2d'), 0);
  const seven = best('2c 2d Ah Kh Qh Jh Th');
  assert.equal(seven.name, '皇家同花顺');
  assert.deepEqual([...seven.cards].sort(), ['Ah', 'Jh', 'Kh', 'Qh', 'Th']);
  assert.equal(best('Ac Ad Ah 2s 2c 2d 9h').name, '葫芦'); // two sets of trips: aces full of twos
  assert.equal(cardText('Td'), '10♦');
});

test('shuffle: 52 different cards, steered only by the random source given', () => {
  const d = shuffle(newDeck());
  assert.equal(new Set(d).size, 52);
  let s = 7;
  const rnd = (n) => { s = (s * 1103515245 + 12345) % 2147483648; return s % n; };
  const a = shuffle(newDeck(), rnd);
  s = 7;
  assert.deepEqual(shuffle(newDeck(), rnd), a);
});

test('heads-up blinds and order: the button posts the small blind, acts first preflop and last after; the button moves', () => {
  const m = newMatch({id: 't1', firstButton: 'human'});
  const h = startHand(m, {deck: deckFor({button: 'human', holes: {human: ['As', 'Kd'], ai: ['7h', '7c']}, board: ['Qh', 'Js', '2c', '9d', '3s']})});
  assert.deepEqual(h.hole, {human: ['As', 'Kd'], ai: ['7h', '7c']});
  assert.deepEqual(m.stacks, {human: 1990, ai: 1980});
  assert.equal(h.toAct, 'human');
  assert.deepEqual(legalActions(m, 'human'), {fold: true, check: false, call: 10, raise: {min: 40, max: 2000}});
  assert.equal(legalActions(m, 'ai'), null);
  act(m, 'human', {action: 'call'});
  assert.equal(h.toAct, 'ai'); // the big blind's option
  assert.equal(legalActions(m, 'ai').check, true);
  act(m, 'ai', {action: 'check'});
  assert.equal(h.street, 'flop');
  assert.deepEqual(h.board, ['Qh', 'Js', '2c']);
  assert.equal(h.pot, 40);
  assert.equal(h.toAct, 'ai'); // out of position first after the flop
  act(m, 'ai', {action: 'check'});
  act(m, 'human', {action: 'check'});
  assert.equal(h.street, 'turn');
  assert.deepEqual(h.board, ['Qh', 'Js', '2c', '9d']);
  act(m, 'ai', {action: 'check'}); act(m, 'human', {action: 'check'});
  act(m, 'ai', {action: 'check'}); act(m, 'human', {action: 'check'});
  assert.equal(h.street, 'showdown');
  assert.equal(h.result.winner, 'ai');
  assert.equal(h.result.hands.ai.name, '一对');
  assert.deepEqual(m.stacks, {human: 1980, ai: 2020});
  assert.deepEqual(h.result.net, {human: -20, ai: 20});
  const h2 = startHand(m);
  assert.equal(h2.button, 'ai');
  assert.equal(h2.toAct, 'ai');
  assert.deepEqual(m.stacks, {human: 1960, ai: 2010});
});

test('raises: at least the last raise again; bet after the flop; a wrong move says why and changes nothing', () => {
  const m = newMatch({firstButton: 'ai'});
  const h = startHand(m, {deck: deckFor({button: 'ai', holes: {human: ['As', 'Ad'], ai: ['Kh', 'Kc']}, board: ['2h', '7s', '9c', 'Jd', '4s']})});
  assert.throws(() => act(m, 'human', {action: 'call'}), {code: 'NOT_YOUR_TURN'});
  act(m, 'ai', {action: 'raise', amount: 60}); // to 60: a raise of 40
  assert.equal(h.log.at(-1).action, 'raise');
  assert.deepEqual(legalActions(m, 'human').raise, {min: 100, max: 2000});
  const before = JSON.stringify(m);
  assert.throws(() => act(m, 'human', {action: 'raise', amount: 90}), {code: 'TOO_LITTLE', message: /至少到 100/});
  assert.throws(() => act(m, 'human', {action: 'raise', amount: 2001}), {code: 'TOO_MUCH'});
  assert.throws(() => act(m, 'human', {action: 'raise'}), {code: 'BAD_AMOUNT'});
  assert.throws(() => act(m, 'human', {action: 'check'}), {code: 'CANNOT_CHECK', message: /要跟 40/});
  assert.throws(() => act(m, 'human', {action: 'dance'}), {code: 'BAD_ACTION'});
  assert.equal(JSON.stringify(m), before);
  act(m, 'human', {action: 'raise', amount: 180}); // a raise of 120: the next must be 120 more
  assert.deepEqual(legalActions(m, 'ai').raise, {min: 300, max: 2000});
  act(m, 'ai', {action: 'call'});
  assert.equal(h.street, 'flop');
  assert.equal(h.pot, 360);
  assert.equal(h.toAct, 'human');
  act(m, 'human', {action: 'call'}); // nothing to call: a check
  assert.equal(h.log.at(-1).action, 'check');
  act(m, 'ai', {action: 'bet', amount: 100});
  assert.equal(h.log.at(-1).action, 'bet');
  assert.deepEqual(legalActions(m, 'human').raise, {min: 200, max: 1820});
});

test('fold: the other takes the pot, no cards shown until turned up', () => {
  const m = newMatch({firstButton: 'human'});
  const h = startHand(m, {deck: deckFor({button: 'human', holes: {human: ['2s', '7d'], ai: ['Ah', 'Kh']}, board: ['Qh', 'Jh', 'Th', '9d', '3s']})});
  act(m, 'human', {action: 'raise', amount: 60});
  act(m, 'ai', {action: 'fold'});
  assert.equal(h.result.how, 'fold');
  assert.equal(h.result.winner, 'human');
  assert.equal(h.result.won, 80);
  assert.deepEqual(m.stacks, {human: 2020, ai: 1980});
  assert.equal(chips(m), 4000);
  assert.equal(viewFor(m, 'human').hand.hole.ai, undefined);
  assert.equal(viewFor(m, 'human').hand.board.length, 0);
  assert.throws(() => act(m, 'human', {action: 'check'}), {code: 'NO_HAND'});
  showCards(m, 'human'); // the human shows the AI the bluff
  assert.deepEqual(viewFor(m, 'ai').hand.hole.human, ['2s', '7d']);
  assert.equal(viewFor(m, 'human').hand.hole.ai, undefined);
});

test('all-in: the board runs out, the uncovered part goes back, the match ends at zero', () => {
  const m = newMatch({firstButton: 'human'});
  m.stacks = {human: 3500, ai: 500};
  const h = startHand(m, {deck: deckFor({button: 'human', holes: {human: ['As', 'Ad'], ai: ['Kh', 'Kc']}, board: ['2h', '7s', '9c', 'Jd', '4s']})});
  act(m, 'human', {action: 'allin'});
  assert.equal(h.bets.human, 3500);
  assert.deepEqual(legalActions(m, 'ai'), {fold: true, check: false, call: 480, raise: null}); // can only call its last 480
  act(m, 'ai', {action: 'allin'}); // all-in with no raise left: a call
  assert.equal(h.street, 'showdown');
  assert.equal(h.board.length, 5);
  assert.ok(h.log.some((e) => e.action === 'return' && e.who === 'human' && e.amount === 3000));
  assert.equal(h.result.won, 1000);
  assert.deepEqual(m.stacks, {human: 4000, ai: 0});
  assert.equal(m.over, true);
  assert.equal(m.winner, 'human');
  assert.throws(() => startHand(m), {code: 'MATCH_OVER'});
});

test('a short big blind is all-in at once: no betting, straight to showdown', () => {
  const m = newMatch({firstButton: 'human'});
  m.stacks = {human: 3985, ai: 15};
  const h = startHand(m, {deck: deckFor({button: 'human', holes: {human: ['2s', '3d'], ai: ['Ah', 'Kh']}, board: ['Ac', 'Kd', '8h', '9d', '5s']})});
  // the AI's blind is all of its 15: the human's 10 does not cover it, so the human must call 5 or fold, and cannot raise
  assert.equal(h.toAct, 'human');
  assert.deepEqual(legalActions(m, 'human'), {fold: true, check: false, call: 5, raise: null});
  act(m, 'human', {action: 'call'});
  assert.equal(h.result.winner, 'ai');
  assert.deepEqual(m.stacks, {human: 3970, ai: 30});
  const m2 = newMatch({firstButton: 'ai'});
  m2.stacks = {human: 4, ai: 3996};
  const h2 = startHand(m2, {deck: deckFor({button: 'ai', holes: {human: ['Ah', 'Ad'], ai: ['7h', '2c']}, board: ['Ac', 'Kd', '8h', '9d', '5s']})});
  assert.equal(h2.street, 'showdown'); // the human is all-in for 4 and the AI's 10 covers it: the rest goes back
  assert.deepEqual(m2.stacks, {human: 8, ai: 3992});
});

test('a split pot: the odd chip goes to the player who is not the button', () => {
  const m = newMatch({firstButton: 'human'});
  const h = startHand(m, {deck: deckFor({button: 'human', holes: {human: ['2s', '3d'], ai: ['2h', '3c']}, board: ['Ac', 'Kd', 'Qh', 'Jd', 'Ts']})});
  act(m, 'human', {action: 'call'}); act(m, 'ai', {action: 'check'});
  h.pot += 1; m.stacks.ai -= 1; // an odd pot, by hand
  for (let i = 0; i < 3; i++) { act(m, 'ai', {action: 'check'}); act(m, 'human', {action: 'check'}); }
  assert.equal(h.result.winner, null);
  assert.deepEqual(m.stacks, {human: 2000, ai: 2000});
});

test('views: your own cards, the other hand only after the showdown; never the deck', () => {
  const m = newMatch({id: 'v', firstButton: 'human'});
  startHand(m, {deck: deckFor({button: 'human', holes: {human: ['As', 'Kd'], ai: ['7h', '7c']}, board: ['Qh', 'Js', '2c', '9d', '3s']})});
  const v = viewFor(m, 'human');
  assert.deepEqual(v.hand.hole, {human: ['As', 'Kd']});
  assert.equal(JSON.stringify(v).includes('7h'), false);
  assert.equal(JSON.stringify(v).includes('deck'), false);
  assert.ok(viewFor(m, 'human').hand.legal);
  assert.equal(viewFor(m, 'ai').hand.legal, null);
  act(m, 'human', {action: 'allin'}); act(m, 'ai', {action: 'call'});
  assert.deepEqual(viewFor(m, 'human').hand.hole.ai, ['7h', '7c']);
  assert.equal(JSON.stringify(viewFor(m, 'human')).includes('deck'), false);
});

test('ending early: only between hands; the one with more chips wins', () => {
  const m = newMatch({firstButton: 'human'});
  startHand(m);
  assert.throws(() => endMatch(m), {code: 'HAND_LIVE'});
  act(m, 'human', {action: 'fold'});
  endMatch(m);
  assert.equal(m.over, true);
  assert.equal(m.winner, 'ai');
  assert.equal(m.endedEarly, true);
});

test('random play: chips are never made or lost, every hand ends, the state stays plain JSON', () => {
  let s = 12345;
  const rnd = (n) => { s = (s * 1103515245 + 12345) % 2147483648; return s % n; };
  for (let game = 0; game < 30; game++) {
    let m = newMatch({firstButton: game % 2 ? 'ai' : 'human', stack: 300});
    for (let hands = 0; hands < 200 && !m.over; hands++) {
      startHand(m, {rnd});
      for (let steps = 0; m.hand.toAct; steps++) {
        assert.ok(steps < 50, 'a hand that never ends');
        const p = m.hand.toAct, L = legalActions(m, p);
        const r = rnd(10);
        if (r === 0) act(m, p, {action: 'fold'});
        else if (r < 4 && L.raise) act(m, p, {action: 'raise', amount: L.raise.min + rnd(L.raise.max - L.raise.min + 1)});
        else act(m, p, {action: L.check ? 'check' : 'call'});
        assert.equal(chips(m), 600);
        m = JSON.parse(JSON.stringify(m));
      }
      assert.ok(m.hand.result);
      assert.equal(chips(m), 600);
      assert.ok(m.stacks.human >= 0 && m.stacks.ai >= 0);
    }
  }
});
