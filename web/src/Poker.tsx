// The human's side of the table (server.mjs /api/*). You see your own cards, the AI's only when shown; you deal, act,
// talk; the AI plays through its tools. The page asks /api/table?since=<version> again and again (the server answers
// when something moves), so the AI's moves show up by themselves.
import {useCallback, useEffect, useRef, useState} from 'react';

type Who = 'human' | 'ai';
interface Legal { fold: boolean; check: boolean; call: number | null; raise: {min: number; max: number} | null }
interface Step { street: string; who: Who; action: string; amount?: number; allin?: boolean }
interface Shown { name: string; cards: string[]; holeCards?: string[] }
interface Result { how: 'fold' | 'showdown'; winner: Who | null; won: number; net: Record<Who, number>; hands?: Record<Who, Shown> }
interface Hand {
  no: number; button: Who; street: string; board: string[]; pot: number; bets: Record<Who, number>; toAct: Who | null;
  hole: Partial<Record<Who, string[]>>; log: Step[]; legal: Legal | null; result: Result | null;
}
interface Match {
  matchId: string; blinds: {sb: number; bb: number}; stacks: Record<Who, number>; handNo: number; over: boolean; winner: Who | null;
  endedEarly?: boolean; startStack: number; startedAt: number; startedBy?: Who; hand: Hand | null; results: {no: number; how: string; winner: Who | null; won: number}[];
}
interface Talk { who: Who; text: string; at: number; hand: number }
interface Past { id: string; startedAt: number; endedAt: number | null; hands: number; winner: Who | null; endedEarly: boolean; stacks: Record<Who, number>; startStack: number; said: number }
export interface PokerView {
  version: number; aiName: string; mode: 'mcp' | 'auto'; listening: boolean;
  match: Match | null; talk: Talk[]; call: {state: 'idle' | 'waiting' | 'calling' | 'missed' | 'error'; at?: number; reason?: string};
  ledger: {matches: number; human: number; ai: number; humanNet: number}; past: Past[];
}

class HttpError extends Error { constructor(public status: number, public code: string, message?: string) { super(message ?? code); } }
async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch('/api' + path, {method: body === undefined ? 'GET' : 'POST', signal,
    headers: {'x-holdem': '1', ...(body === undefined ? {} : {'content-type': 'application/json'})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const b = await res.json().catch(() => ({})) as {error?: string; message?: string};
  if (!res.ok) throw new HttpError(res.status, b.error ?? `HTTP_${res.status}`, b.message);
  return b as T;
}

const SUIT: Record<string, string> = {s: '♠', h: '♥', d: '♦', c: '♣'};
const rankOf = (c: string) => (c[0] === 'T' ? '10' : c[0]);
const red = (c: string) => c[1] === 'h' || c[1] === 'd';
const STREET: Record<string, string> = {preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌'};

export function Card({c, back = false, small = false}: {c?: string; back?: boolean; small?: boolean}) {
  if (back || !c) return <span className={`card back${small ? ' small' : ''}`} aria-label="背面的牌" />;
  return (
    <span className={`card${red(c) ? ' red' : ''}${small ? ' small' : ''}`} aria-label={`${rankOf(c)}${SUIT[c[1]]}`}>
      <b>{rankOf(c)}</b><i>{SUIT[c[1]]}</i>
    </span>
  );
}

export function resultLine(r: Result, ai = 'AI') {
  if (r.how === 'fold') return r.winner === 'human' ? `${ai} 弃牌，你收了 ${r.won}` : `你弃牌，${ai} 收了 ${r.won}`;
  const h = r.hands!;
  if (r.winner === null) return `平分 ${r.won}：都是${h.human.name}`;
  const w = r.winner, l: Who = w === 'human' ? 'ai' : 'human';
  return `${w === 'human' ? '你' : ai}赢了 ${r.won}：${h[w].name}${h[w].name === h[l].name ? '（踢脚大）' : ` 对 ${h[l].name}`}`;
}

/** Raise-to amounts for the quick buttons: half the pot, the pot, all in. */
function quick(h: Hand, L: Legal) {
  if (!L.raise) return [];
  const toCall = L.call ?? 0, cur = Math.max(h.bets.human, h.bets.ai), middle = h.pot + h.bets.human + h.bets.ai;
  const clamp = (n: number) => Math.min(L.raise!.max, Math.max(L.raise!.min, Math.round(n)));
  const out: {label: string; to: number}[] = [];
  for (const [label, f] of [['½ 池', 0.5], ['1 池', 1]] as const) {
    const to = clamp(cur + (middle + toCall) * f);
    if (!out.some((x) => x.to === to)) out.push({label, to});
  }
  out.push({label: '全下', to: L.raise.max});
  return out;
}

/** How reaching the AI goes: thinking, not at the table (MCP mode), or a failed call that can be tried again. */
function CallState({v, onRetry}: {v: PokerView; onRetry: () => void}) {
  const h = v.match?.hand, ai = v.aiName;
  const st = v.call.state;
  if (st === 'missed' || st === 'error') {
    return <div className="state warn">{ai} 没接上：{v.call.reason ?? '不知道为什么'} <button type="button" className="link" onClick={onRetry}>再叫一次</button></div>;
  }
  const itsTurn = !!h && !h.result && h.toAct === 'ai';
  const over = !!v.match?.over;
  if (v.mode === 'mcp' && (itsTurn || over) && !v.listening) {
    return <div className="state warn">{ai} 现在没在等牌。去和它说一声「轮到你了，用 poker_wait 等着」，它就会回来。</div>;
  }
  if (!itsTurn) return null;
  return <div className="state thinking">{st === 'waiting' ? `${ai} 在忙别的，等它空下来…` : `${ai} 在想`}<span className="dots"><i>.</i><i>.</i><i>.</i></span></div>;
}

export function Poker() {
  const [v, setV] = useState<PokerView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [raiseTo, setRaiseTo] = useState('');
  const [say, setSay] = useState('');
  const [busy, setBusy] = useState(false);
  const version = useRef(-1);

  const take = useCallback((x: PokerView) => { if (x.version >= version.current) { version.current = x.version; setV(x); } }, []);
  // the long poll: the server answers when the version moves past ours (or after 25 s)
  useEffect(() => {
    const ac = new AbortController();
    let stop = false;
    (async () => {
      for (let first = true; !stop; first = false) {
        try {
          take(await call<PokerView>(first ? '/table' : `/table?since=${version.current}`, undefined, ac.signal));
          setErr(null);
        } catch {
          if (stop) return;
          setErr('连不上牌桌的服务，过一会儿再试');
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    })();
    return () => { stop = true; ac.abort(); };
  }, [take]);

  const h = v?.match?.hand ?? null;
  const L = h?.legal ?? null;
  // a new turn of yours: the raise box starts at the smallest raise
  const turnKey = h ? `${h.no}:${h.log.length}` : '';
  useEffect(() => { setRaiseTo(L?.raise ? String(L.raise.min) : ''); }, [turnKey]);
  const raiseN = /^\d+$/.test(raiseTo.trim()) ? Number(raiseTo.trim()) : null;
  const raiseOk = !!L?.raise && raiseN !== null && raiseN >= L.raise.min && raiseN <= L.raise.max;

  const post = async (path: string, body: unknown = {}) => {
    setBusy(true);
    try { take(await call<PokerView>(path, body)); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const act = (action: string, amount?: number) => post('/act', {action, ...(amount !== undefined ? {amount} : {})});
  const sendSay = async (e: React.FormEvent) => { e.preventDefault(); const t = say.trim(); if (!t) return; setSay(''); await post('/say', {text: t}); };

  if (!v) return <main className="poker"><div className="lobby"><p className="muted">{err ?? '摆桌子…'}</p></div></main>;

  const ai = v.aiName;
  const m = v.match;
  const L2 = v.ledger;
  const ledger = L2.matches ? `打了 ${L2.matches} 场 · 你赢 ${L2.human} · ${ai} 赢 ${L2.ai} · 累计你 ${L2.humanNet >= 0 ? '+' : ''}${L2.humanNet}` : '还没打过';
  const talkNow = (w: Who) => { const t = v.talk.filter((x) => x.who === w && m && x.hand === m.handNo).at(-1); return t?.text ?? null; };

  return (
    <main className={`poker${m ? ' playing' : ''}`}>
      <header className="bar">
        <h1>德扑</h1>
        {m && !m.over && m.startedBy === 'ai' && <span className="by">{ai} 开的</span>}
        <span className="ledger" title="总账">{ledger}</span>
      </header>

      {!m ? (
        <div className="lobby">
          <p>和 {ai} 单挑。各 2000 分，盲注 10/20。</p>
          <button type="button" className="big" disabled={busy} onClick={() => void post('/start')}>开一场</button>
          <p className="muted small">{v.mode === 'mcp' ? `也可以让 ${ai} 自己开：跟它说「我们打德扑吧」。` : `${ai} 也能自己开一场。`}</p>
          {!!v.past.length && <PastList past={v.past} ai={ai} />}
        </div>
      ) : (
        <div className="play">
          <div className="main">
            <section className="table" aria-label="牌桌">
              <Seat who="ai" name={ai} m={m} h={h} talk={talkNow('ai')} />
              <div className="middle">
                <div className="board" aria-label="公共牌">
                  {[0, 1, 2, 3, 4].map((i) => (h?.board[i] ? <Card key={i} c={h.board[i]} /> : <span key={i} className="card slot" aria-hidden="true" />))}
                </div>
                <div className="pot">底池 {h ? (h.result ? h.result.won : h.pot + h.bets.human + h.bets.ai) : 0}{h && !h.result && <span className="street"> · {STREET[h.street]}</span>}</div>
              </div>
              <Seat who="human" name="你" m={m} h={h} talk={talkNow('human')} />
            </section>

            <section className="controls" aria-label="操作">
              {err && <div className="state warn">{err}</div>}
              <CallState v={v} onRetry={() => void post('/retry')} />
              {h?.result && (
                <div className={`state result ${h.result.winner === 'human' ? 'win' : h.result.winner === 'ai' ? 'lose' : ''}`}>第 {h.no} 手：{resultLine(h.result, ai)}</div>
              )}
              {m.over && (
                <div className="state result">这一场打完了{m.endedEarly ? '（你说先到这）' : ''}：{m.winner === 'human' ? '你赢了' : m.winner === 'ai' ? `${ai} 赢了` : '打平了'}（你 {m.stacks.human}，{ai} {m.stacks.ai}），一共 {m.handNo} 手。</div>
              )}

              {L && h && (
                <div className="acts">
                  <button type="button" className="fold" disabled={busy} onClick={() => void act('fold')}>弃牌</button>
                  {L.check ? <button type="button" disabled={busy} onClick={() => void act('check')}>过牌</button>
                    : <button type="button" disabled={busy} onClick={() => void act('call')}>跟 {L.call}{L.call === m.stacks.human ? '（全下）' : ''}</button>}
                  {L.raise && (
                    <form className="raise" onSubmit={(e) => { e.preventDefault(); if (raiseOk && !busy) void act('raise', raiseN!); }}>
                      <div className="quick">{quick(h, L).map((q) => <button key={q.label} type="button" className={raiseN === q.to ? 'on' : ''} onClick={() => setRaiseTo(String(q.to))}>{q.label}</button>)}</div>
                      <label className="to">
                        <span>{Math.max(h.bets.human, h.bets.ai) === 0 ? '下注' : '加注到'}</span>
                        <input type="text" inputMode="numeric" value={raiseTo} aria-label="加注到多少" aria-invalid={!raiseOk}
                          onChange={(e) => setRaiseTo(e.target.value.replace(/[^\d]/g, ''))} onFocus={(e) => e.target.select()} />
                      </label>
                      <button type="submit" className="go" disabled={busy || !raiseOk}>
                        {!raiseOk ? `${L.raise.min}～${L.raise.max}` : raiseN === L.raise.max ? `全下 ${raiseN}` : `${Math.max(h.bets.human, h.bets.ai) === 0 ? '下注' : '加注到'} ${raiseN}`}
                      </button>
                    </form>
                  )}
                </div>
              )}

              {h?.result && !m.over && (
                <div className="acts">
                  <button type="button" className="go" disabled={busy} onClick={() => void post('/next')}>下一手</button>
                  {h.result.how === 'fold' && <button type="button" disabled={busy} onClick={() => void post('/show')}>给 {ai} 看我的牌</button>}
                  <button type="button" className="quiet" disabled={busy} onClick={() => { if (confirm('这一场就打到这？')) void post('/end'); }}>结束这一场</button>
                </div>
              )}
              {m.over && <div className="acts"><button type="button" className="go big" disabled={busy} onClick={() => void post('/start')}>再开一场</button></div>}
            </section>
          </div>

          {/* wide screens: the talk beside the table; narrow ones: under it, the say box first */}
          <aside className="chat" aria-label="说话">
            <TalkList talk={v.talk} ai={ai} />
            <form className="say" onSubmit={(e) => void sendSay(e)}>
              <input value={say} onChange={(e) => setSay(e.target.value)} maxLength={300} placeholder={`说一句（${ai} 下次出手时看到）`} aria-label="说一句" />
              <button type="submit" disabled={busy || !say.trim()}>说</button>
            </form>
          </aside>
        </div>
      )}
    </main>
  );
}

function Seat({who, name, m, h, talk}: {who: Who; name: string; m: Match; h: Hand | null; talk: string | null}) {
  const cards = h?.hole[who];
  const bet = h?.bets[who] ?? 0;
  const won = h?.result && h.result.winner === who;
  const best = h?.result?.hands?.[who];
  return (
    <div className={`seat ${who}${h?.toAct === who ? ' turn' : ''}${won ? ' won' : ''}`}>
      {talk && <div className="bubble">{talk}</div>}
      <div className="who">
        {who === 'ai' && <span className="badge" aria-hidden="true">{[...name][0]}</span>}
        <span className="name">{name}</span>
        {h && <span className={`blind ${h.button === who ? 'sb' : 'bb'}`} title={h.button === who ? '庄家，下小盲' : '下大盲'}>{h.button === who ? '小盲' : '大盲'}</span>}
        <span className="stack">{m.stacks[who]}</span>
      </div>
      <div className="hole">
        {h ? (cards ? cards.map((c) => <Card key={c} c={c} />) : [<Card key="a" back />, <Card key="b" back />]) : null}
      </div>
      {best && <div className="best">{best.name}</div>}
      {bet > 0 && <div className="bet">{bet}</div>}
    </div>
  );
}

/** All the talk of this match, oldest first; it stays at the bottom unless you scrolled up. */
function TalkList({talk, ai}: {talk: Talk[]; ai: string}) {
  const box = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  useEffect(() => { const el = box.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [talk.length]);
  return (
    <ol className="talk" aria-label="这一场说的话" ref={box}
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
      {!talk.length && <li className="empty">这一场还没人说话</li>}
      {talk.map((t, i) => (
        <li key={i} className={t.who}>
          {(i === 0 || talk[i - 1].hand !== t.hand) && <span className="hand">第 {t.hand} 手</span>}
          <b>{t.who === 'human' ? '你' : ai}</b>{t.text}
        </li>
      ))}
    </ol>
  );
}

function PastList({past, ai}: {past: Past[]; ai: string}) {
  const day = (t: number) => new Date(t).toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
  return (
    <ol className="past" aria-label="打过的">
      {[...past].reverse().map((x) => (
        <li key={x.id}><span>{day(x.startedAt)}</span><span>{x.hands} 手</span>
          <span className={x.winner === 'human' ? 'win' : x.winner === 'ai' ? 'lose' : ''}>{x.winner === 'human' ? '你赢' : x.winner === 'ai' ? `${ai} 赢` : '平'}（{x.stacks.human}:{x.stacks.ai}）</span></li>
      ))}
    </ol>
  );
}
