// The table page. Made-up hands, fetch mocked (the long poll answers once, then waits).
import {afterEach, describe, expect, it, vi} from 'vitest';
import {fireEvent, render, screen, within} from '@testing-library/react';
import {Poker, resultLine, type PokerView} from '../src/Poker';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
afterEach(() => { vi.unstubAllGlobals(); });

const view = (over: Partial<PokerView> = {}): PokerView => ({
  version: 3, aiName: 'Robin', mode: 'auto', listening: false,
  talk: [{who: 'ai', text: '这把我不信你', at: 1, hand: 2}], call: {state: 'idle'}, ledger: {matches: 1, human: 1, ai: 0, humanNet: 300}, past: [],
  match: {matchId: 'm1', blinds: {sb: 10, bb: 20}, stacks: {human: 1990, ai: 1960}, handNo: 2, over: false, winner: null, startStack: 2000, startedAt: 1, results: [],
    hand: {no: 2, button: 'human', street: 'preflop', board: [], pot: 0, bets: {human: 10, ai: 40}, toAct: 'human', hole: {human: ['As', 'Td']}, legal: {fold: true, check: false, call: 30, raise: {min: 70, max: 2000}},
      log: [{street: 'preflop', who: 'human', action: 'sb', amount: 10}, {street: 'preflop', who: 'ai', action: 'bb', amount: 20}], result: null}},
  ...over,
});

/** fetch: the first GET answers `first`, later GETs never answer; POSTs answer `after` and are recorded. */
function stub(first: PokerView, after: PokerView = first) {
  const posts: {path: string; body: unknown}[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push({path: url, body: JSON.parse(String(init.body))}); return json(after); }
    if (url === '/api/table') return json(first);
    return new Promise<Response>(() => {});
  }));
  return posts;
}

describe('the table page', () => {
  it('your cards, its backs, its words, its name; you call and raise', async () => {
    const posts = stub(view());
    render(<Poker />);
    expect(await screen.findByLabelText('A♠')).toBeInTheDocument();
    expect(screen.getAllByLabelText('背面的牌')).toHaveLength(2);
    expect(screen.getAllByText('这把我不信你').length).toBeGreaterThan(0);
    expect(screen.getByText(/Robin 赢 0 · 累计你 \+300/)).toBeInTheDocument();
    expect(screen.getByText('底池 50')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: '跟 30'}));
    await vi.waitFor(() => expect(posts.at(-1)).toEqual({path: '/api/act', body: {action: 'call'}}));
    fireEvent.click(screen.getByRole('button', {name: '1 池'})); // 40 + (50 + 30) = 120
    await vi.waitFor(() => expect(screen.getByRole('button', {name: '加注到 120'})).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', {name: '加注到 120'}));
    await vi.waitFor(() => expect(posts.at(-1)).toEqual({path: '/api/act', body: {action: 'raise', amount: 120}}));
  });

  it('you type how much to raise to; out of range cannot go', async () => {
    const posts = stub(view());
    render(<Poker />);
    const box = await screen.findByRole('textbox', {name: '加注到多少'});
    expect(box).toHaveValue('70');
    fireEvent.change(box, {target: {value: '35'}});
    expect(screen.getByRole('button', {name: '70～2000'})).toBeDisabled();
    fireEvent.change(box, {target: {value: '3a33'}});
    expect(box).toHaveValue('333');
    fireEvent.submit(box.closest('form')!);
    await vi.waitFor(() => expect(posts.at(-1)).toEqual({path: '/api/act', body: {action: 'raise', amount: 333}}));
  });

  it('small and big blind on the seats; all of the match\'s talk beside the table, by hand', async () => {
    const talk = Array.from({length: 30}, (_, i) => ({who: (i % 2 ? 'human' : 'ai') as 'human' | 'ai', text: `第${i}句`, at: i, hand: 1 + Math.floor(i / 10)}));
    stub(view({talk}));
    render(<Poker />);
    const mine = (await screen.findByLabelText('A♠')).closest('.seat') as HTMLElement;
    expect(within(mine).getByText('小盲')).toBeInTheDocument();
    const its = screen.getAllByLabelText('背面的牌')[0].closest('.seat') as HTMLElement;
    expect(within(its).getByText('大盲')).toBeInTheDocument();
    expect(within(its).getByText('Robin')).toBeInTheDocument();
    const side = screen.getByRole('complementary', {name: '说话'});
    const list = within(side).getByRole('list', {name: '这一场说的话'});
    expect(within(list).getAllByRole('listitem')).toHaveLength(30);
    expect(within(list).getAllByText(/^第 \d 手$/).map((x) => x.textContent)).toEqual(['第 1 手', '第 2 手', '第 3 手']);
    expect(within(side).getByRole('textbox', {name: '说一句'})).toBeInTheDocument();
  });

  it('its turn: thinking (auto); in MCP mode, a hint when it is not waiting; a failed call can be retried', async () => {
    const v = view();
    v.match!.hand!.toAct = 'ai'; v.match!.hand!.legal = null; v.call = {state: 'calling'};
    stub(v);
    const {unmount} = render(<Poker />);
    expect(await screen.findByText(/Robin 在想/)).toBeInTheDocument();
    unmount();
    stub({...v, mode: 'mcp', listening: false, call: {state: 'idle'}});
    const r2 = render(<Poker />);
    expect(await screen.findByText(/Robin 现在没在等牌/)).toBeInTheDocument();
    r2.unmount();
    const posts = stub({...v, call: {state: 'missed', reason: '叫了它，它没出手'}});
    render(<Poker />);
    fireEvent.click(await screen.findByRole('button', {name: '再叫一次'}));
    await vi.waitFor(() => expect(posts.at(-1)?.path).toBe('/api/retry'));
  });

  it('after a showdown: both hands, who won, the next hand; no match: 开一场', async () => {
    const v = view();
    Object.assign(v.match!.hand!, {street: 'showdown', board: ['Ac', 'Kd', '8h', '9d', '5s'], toAct: null, legal: null, hole: {human: ['As', 'Td'], ai: ['7h', '7c']},
      result: {how: 'showdown', winner: 'human', won: 400, net: {human: 200, ai: -200}, hands: {human: {name: '一对', cards: []}, ai: {name: '一对', cards: []}}}});
    const posts = stub(v);
    const {unmount} = render(<Poker />);
    expect(await screen.findByText('第 2 手：你赢了 400：一对（踢脚大）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: '下一手'}));
    await vi.waitFor(() => expect(posts.at(-1)?.path).toBe('/api/next'));
    expect(resultLine({how: 'fold', winner: 'ai', won: 60, net: {human: -30, ai: 30}}, 'Robin')).toBe('你弃牌，Robin 收了 60');
    unmount();
    const p2 = stub(view({match: null, ledger: {matches: 0, human: 0, ai: 0, humanNet: 0}}));
    render(<Poker />);
    fireEvent.click(await screen.findByRole('button', {name: '开一场'}));
    await vi.waitFor(() => expect(p2.at(-1)?.path).toBe('/api/start'));
  });
});
