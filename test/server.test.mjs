// The server (server.mjs), the MCP tools (mcp.mjs, over stdio) and auto mode (autoplay.mjs, with a fake `claude`).
// Temp folders and port 0 only; nothing here calls a real AI.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer} from '../src/server.mjs';
import {createAutoplay} from '../src/autoplay.mjs';

const MCP = fileURLToPath(new URL('../src/mcp.mjs', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'holdem-'));
const firstButtonHuman = () => { let first = true; let s = 3; return (n) => (first && n === 2 ? (first = false, 0) : (s = (s * 1103515245 + 12345) % 2147483648) % n); };
const H = {'x-holdem': '1', 'content-type': 'application/json'};

test('the page API: header required, start / act / long poll; the AI door needs the token', async () => {
  const dir = tmp();
  const s = await startServer({dir, port: 0, rnd: firstButtonHuman()});
  try {
    assert.equal((await fetch(`${s.url}/api/start`, {method: 'POST'})).status, 403);
    const v = await (await fetch(`${s.url}/api/start`, {method: 'POST', headers: H, body: '{}'})).json();
    assert.equal(v.match.hand.toAct, 'human');
    assert.equal(v.aiName, 'AI');
    const poll = fetch(`${s.url}/api/table?since=${v.version}`, {headers: H}).then((r) => r.json());
    await fetch(`${s.url}/api/act`, {method: 'POST', headers: H, body: JSON.stringify({action: 'call'})});
    assert.equal((await poll).match.hand.toAct, 'ai');
    const bad = await fetch(`${s.url}/api/act`, {method: 'POST', headers: H, body: JSON.stringify({action: 'call'})});
    assert.equal(bad.status, 409);
    assert.equal((await bad.json()).error, 'NOT_YOUR_TURN');
    assert.equal((await fetch(`${s.url}/api/ai/poker_look`, {method: 'POST', headers: {'x-holdem-token': 'nope'}})).status, 401);
    const token = readFileSync(join(dir, 'token'), 'utf8').trim();
    const look = await (await fetch(`${s.url}/api/ai/poker_look`, {method: 'POST', headers: {'x-holdem-token': token}})).json();
    assert.match(look.now, /轮到你/);
    assert.equal((await fetch(`${s.url}/../token`)).status, 404);
  } finally { await s.close(); rmSync(dir, {recursive: true, force: true}); }
});

/** Talk to mcp.mjs over stdio: send requests, collect answers by id. */
function mcpClient(dir, extra = []) {
  const child = spawn(process.execPath, [MCP, '--dir', dir, ...extra], {stdio: ['pipe', 'pipe', 'inherit']});
  const waiting = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); waiting.get(m.id)?.(m); }
  });
  let id = 0;
  return {
    ask: (method, params) => new Promise((ok) => { const i = ++id; waiting.set(i, ok); child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: i, method, params}) + '\n'); }),
    tell: (method) => child.stdin.write(JSON.stringify({jsonrpc: '2.0', method}) + '\n'),
    close: () => child.kill(),
  };
}

test('MCP: initialize, the four tools, a match played through them (poker_wait hands over the turn)', async () => {
  const dir = tmp();
  const s = await startServer({dir, port: 0, rnd: firstButtonHuman()});
  const c = mcpClient(dir);
  try {
    const init = await c.ask('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't', version: '0'}});
    assert.equal(init.result.protocolVersion, '2025-06-18');
    c.tell('notifications/initialized');
    const names = (await c.ask('tools/list')).result.tools.map((t) => t.name);
    assert.deepEqual(names, ['poker_start', 'poker_look', 'poker_act', 'poker_wait']);
    const tool = async (name, args = {}) => JSON.parse((await c.ask('tools/call', {name, arguments: args})).result.content[0].text);
    assert.equal((await tool('poker_start', {say: '来'})).started, true);
    const wait = tool('poker_wait', {seconds: 10});
    await fetch(`${s.url}/api/act`, {method: 'POST', headers: H, body: JSON.stringify({action: 'call'})});
    const w = await wait;
    assert.equal(w.status, 'your_turn');
    assert.match(w.letter, /轮到你：/);
    assert.equal((await tool('poker_act', {action: 'check'})).did, '你过牌');
    const unknown = await c.ask('tools/call', {name: 'nope', arguments: {}});
    assert.equal(unknown.error.code, -32602);
    const c2 = mcpClient(dir, ['--no-wait']);
    await c2.ask('initialize', {protocolVersion: '2024-11-05'});
    assert.equal((await c2.ask('tools/list')).result.tools.some((t) => t.name === 'poker_wait'), false);
    c2.close();
  } finally { c.close(); await s.close(); rmSync(dir, {recursive: true, force: true}); }
});

test('auto mode: on its turn the server runs the command with the letter, the tools, then --resume; a silent AI is "missed"', async () => {
  const dir = tmp();
  // a fake `claude`: records its args and prompt, plays "call/check" through the AI door, answers like `claude -p --output-format json`
  const fake = join(dir, 'fake-claude.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import {appendFileSync, readFileSync} from 'node:fs';
const dir = ${JSON.stringify(dir)};
let prompt = ''; for await (const c of process.stdin) prompt += c;
appendFileSync(dir + '/calls.jsonl', JSON.stringify({args: process.argv.slice(2), prompt}) + '\\n');
if (!process.env.FAKE_SILENT) {
  const s = JSON.parse(readFileSync(dir + '/server.json', 'utf8')), token = readFileSync(dir + '/token', 'utf8').trim();
  const act = /跟 \\d+ call/.test(prompt) ? 'call' : 'check';
  if (/轮到你/.test(prompt)) await fetch(s.url + '/api/ai/poker_act', {method: 'POST', headers: {'x-holdem-token': token}, body: JSON.stringify({action: act, say: '跟'})});
}
console.log(JSON.stringify({type: 'result', is_error: false, result: 'ok', session_id: 'sess-1'}));
`);
  chmodSync(fake, 0o755);
  const settle = async (s) => { for (let i = 0; i < 100 && (player.busy || s.table.due()); i++) await new Promise((r) => setTimeout(r, 30)); };
  let player = createAutoplay({dir, command: fake});
  const s = await startServer({dir, port: 0, mode: 'auto', rnd: firstButtonHuman(), onChange: (t, o) => player.onChange(t, o)});
  try {
    await fetch(`${s.url}/api/start`, {method: 'POST', headers: H, body: '{}'});
    await fetch(`${s.url}/api/act`, {method: 'POST', headers: H, body: JSON.stringify({action: 'call'})});
    await settle(s);
    const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(calls.length >= 1);
    assert.match(calls[0].prompt, /^对方开了一场德扑/);
    assert.match(calls[0].prompt, /只有写在 poker_act 的 say 里的话会显示在牌桌上/);
    assert.ok(calls[0].args.includes('-p'));
    assert.ok(calls[0].args.some((a) => a.startsWith('--mcp-config=')));
    assert.ok(calls[0].args.includes('--allowedTools=mcp__holdem__poker_act,mcp__holdem__poker_look,mcp__holdem__poker_start'));
    assert.equal(calls[0].args.includes('--resume'), false);
    const mcp = JSON.parse(readFileSync(join(dir, 'mcp-auto.json'), 'utf8'));
    assert.ok(mcp.mcpServers.holdem.args.includes('--no-wait'));
    assert.equal(s.table.view().talk.at(-1).text, '跟');
    if (calls.length > 1) assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf('--resume'), calls[1].args.indexOf('--resume') + 2), ['--resume', 'sess-1']);
    assert.equal(s.table.view().call.state, 'idle');

    // the AI says nothing and does not act: called once for this turn, then "missed"; 再叫一次 calls again
    process.env.FAKE_SILENT = '1';
    player = createAutoplay({dir, command: fake});
    while (s.table.view().match.hand.toAct !== 'human' && !s.table.view().match.hand.result) await new Promise((r) => setTimeout(r, 20));
    const h = s.table.view().match.hand;
    if (!h.result) await fetch(`${s.url}/api/act`, {method: 'POST', headers: H, body: JSON.stringify({action: h.legal.check ? 'check' : 'call'})});
    else { await fetch(`${s.url}/api/next`, {method: 'POST', headers: H, body: '{}'}); }
    for (let i = 0; i < 100 && s.table.view().call.state !== 'missed' && s.table.due(); i++) await new Promise((r) => setTimeout(r, 30));
    if (s.table.due()) assert.equal(s.table.view().call.state, 'missed');
  } finally { delete process.env.FAKE_SILENT; await s.close(); rmSync(dir, {recursive: true, force: true}); }
});
