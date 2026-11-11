// The table (table.mjs): the AI's letters and tools, poker_wait, the records. Temp folders only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cardsText} from '../src/engine.mjs';
import {createTable, handSteps, legalText} from '../src/table.mjs';

const seeded = (seed) => (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const tmp = () => mkdtempSync(join(tmpdir(), 'holdem-'));
/** A table whose first button is the human's (rnd(2) → 0 for the first draw). */
function table(dir, extra = {}, seed = 99) {
  const r = seeded(seed);
  let first = true;
  return createTable({dir, now: () => Date.parse('2026-11-04T13:40:00Z'), rnd: (n) => (first && n === 2 ? (first = false, 0) : r(n)), ...extra});
}
const toAct = (t) => t.view().match.hand.toAct;

test('the words: steps of a hand, what the AI may do', () => {
  assert.equal(handSteps([{street: 'preflop', who: 'human', action: 'sb', amount: 10}, {street: 'preflop', who: 'ai', action: 'bb', amount: 20},
    {street: 'preflop', who: 'human', action: 'call', amount: 10}, {street: 'flop', who: 'ai', action: 'check'}, {street: 'flop', who: 'human', action: 'bet', amount: 40}]),
  '翻牌前 对方小盲 10，你大盲 20，对方跟 10｜翻牌 你过牌，对方下注 40');
  assert.equal(legalText({fold: true, check: false, call: 40, raise: {min: 80, max: 1880}}), '弃牌 fold / 跟 40 call / 加注 raise（amount 填加注到多少：80～1880，1880 是全下）');
  assert.equal(legalText({fold: true, check: true, call: null, raise: {min: 300, max: 300}}), '弃牌 fold / 过牌 check / 全下 allin（300）');
});

test('the human opens: the AI letter carries its cards, never the human\'s; rules once; talk once', () => {
  const dir = tmp();
  try {
    const t = table(dir);
    assert.equal(t.due(), null);
    assert.equal(t.call('poker_act', {action: 'call'}).error, '现在没有在打的牌局');
    t.start('human');
    const v = t.view();
    assert.equal(v.match.hand.hole.ai, undefined); // the page never gets the AI's cards
    const hers = v.match.hand.hole.human;
    assert.equal(t.due(), null); // the human acts first
    t.act('human', {action: 'call'});
    const due = t.due();
    assert.equal(due.kind, 'turn');
    const letter = t.letter(due);
    assert.match(letter, /^对方开了一场德扑：单挑无限注德州，各 2000 分，盲注 10\/20/);
    assert.match(letter, /第 1 手，你是大盲（对方是庄家、小盲）。\n你的牌：\S+ \S+\n公共牌：还没发（翻牌前）/);
    assert.match(letter, /轮到你：弃牌 fold \/ 过牌 check \/ 加注 raise/);
    for (const c of hers) assert.equal(letter.includes(cardsText([c])), false, 'the human\'s card in the AI letter');
    t.say('human', '你敢加吗');
    assert.match(t.letter(due), /对方在牌桌上说：「你敢加吗」/);
    t.told(due);
    assert.doesNotMatch(t.letter(due), /开了一场|对方在牌桌上说/);
    const r = t.call('poker_act', {action: 'check', say: '看看再说'});
    assert.equal(r.did, '你过牌');
    assert.match(r.now, /公共牌：\S+ \S+ \S+（翻牌）[\s\S]*轮到你：/);
    assert.equal(t.view().talk.at(-1).who, 'ai');
    assert.match(t.call('poker_act', {action: 'raise', amount: 5}).error, /加注至少到 20/);
    assert.equal(t.call('poker_act', {}).error, '没有出手也没有说话：action 和 say 至少给一个');
    // the record of a finished hand has both hands
    t.call('poker_act', {action: 'raise', amount: 100});
    t.act('human', {action: 'fold'});
    const rec = JSON.parse(readFileSync(join(dir, 'hands.jsonl'), 'utf8').trim());
    assert.equal(rec.no, 1);
    assert.equal(rec.hole.human.length, 2);
    assert.equal(rec.result.winner, 'ai');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('the AI opens (poker_start): the rules in its result, not again; not while one is on', () => {
  const dir = tmp();
  try {
    const t = table(dir);
    const r = t.call('poker_start', {say: '来一局'});
    assert.equal(r.started, true);
    assert.match(r.rules, /^你开了一场德扑/);
    assert.match(r.now, /现在轮到对方。/);
    assert.equal(t.view().match.startedBy, 'ai');
    assert.equal(t.view().talk.at(-1).text, '来一局');
    assert.match(t.call('poker_start', {}).error, /这一场还没打完/);
    t.act('human', {action: 'call'});
    assert.doesNotMatch(t.letter(t.due()), /开了一场德扑/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('the match ends: the over letter once, the ledger, the next match; state survives a restart', () => {
  const dir = tmp();
  try {
    const t = table(dir);
    t.start('human');
    t.act('human', {action: 'fold'}); // hand 1 to the AI
    t.end();
    const due = t.due();
    assert.equal(due.kind, 'over');
    assert.match(t.letter(due), /这一场打完了（对方说先到这）：一共 1 手，你赢了（对方 1990，你 2010）。总账：打了 1 场，对方赢 0 场，你赢 1 场。/);
    t.told(due);
    assert.equal(t.due(), null);
    assert.deepEqual(t.view().ledger, {matches: 1, human: 0, ai: 1, humanNet: -10});
    const again = table(dir); // a restart reads table.json
    assert.equal(again.view().match.over, true);
    again.start('human');
    assert.equal(again.view().past.length, 1);
    assert.equal(again.view().past[0].winner, 'ai');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('poker_wait: returns the letter when it is the AI\'s turn, waiting after the time, idle with no match; the page sees it listening', async () => {
  const dir = tmp();
  try {
    const t = createTable({dir, rnd: (() => { let first = true; const r = seeded(5); return (n) => (first && n === 2 ? (first = false, 0) : r(n)); })()});
    assert.deepEqual(await t.waitTurn(30), {kind: 'poker_wait', status: 'idle'});
    t.start('human');
    const w = t.waitTurn(5000);
    await new Promise((r) => setImmediate(r));
    assert.equal(t.view().listening, true);
    t.act('human', {action: 'call'});
    const got = await w;
    assert.equal(got.status, 'your_turn');
    assert.match(got.letter, /轮到你：/);
    assert.equal(t.view().listening, false);
    // told: the same turn is not handed out twice
    t.call('poker_act', {action: 'check'});
    if (toAct(t) === 'human') {
      const r = await t.waitTurn(30);
      assert.equal(r.status, 'waiting');
      assert.match(r.now, /现在轮到对方/);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
