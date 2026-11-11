#!/usr/bin/env node
// The AI's tools as an MCP server (stdio, JSON-RPC 2.0, no dependencies). It only passes calls on to the running
// holdem-duet server (server.json + token in the data folder), so the table lives in one place.
//   node src/mcp.mjs [--dir <data folder>] [--no-wait]
// --no-wait leaves poker_wait out (auto mode: the server calls the AI itself when it is its turn).
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {dataDir} from './paths.mjs';
import {TALK_MAX, TOOL_DESC} from './table.mjs';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const dir = dataDir(opt('--dir'));
const noWait = argv.includes('--no-wait');

const say = {type: 'string', minLength: 1, maxLength: TALK_MAX, description: '对对方说的话，显示在牌桌上（可不填）'};
const TOOLS = [
  {name: 'poker_start', description: TOOL_DESC.poker_start, inputSchema: {type: 'object', properties: {say}, additionalProperties: false}},
  {name: 'poker_look', description: TOOL_DESC.poker_look, inputSchema: {type: 'object', properties: {}, additionalProperties: false}},
  {name: 'poker_act', description: TOOL_DESC.poker_act, inputSchema: {type: 'object', properties: {
    action: {type: 'string', enum: ['fold', 'check', 'call', 'raise', 'allin'], description: 'fold / check / call / raise / allin（不出手就不填）'},
    amount: {type: 'integer', minimum: 1, description: 'raise 时：加注到多少'}, say}, additionalProperties: false}},
  ...(noWait ? [] : [{name: 'poker_wait', description: TOOL_DESC.poker_wait, inputSchema: {type: 'object', properties: {
    seconds: {type: 'integer', minimum: 1, maximum: 110, description: '最多等几秒（默认 50）'}}, additionalProperties: false}}]),
];

async function callTool(name, args) {
  let server, token;
  try { server = JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8')); token = readFileSync(join(dir, 'token'), 'utf8').trim(); }
  catch { return {error: '牌桌没开：先运行 npm start（holdem-duet 的服务）'}; }
  try {
    const res = await fetch(`${server.url}/api/ai/${name}`, {method: 'POST', headers: {'content-type': 'application/json', 'x-holdem-token': token}, body: JSON.stringify(args ?? {})});
    return await res.json();
  } catch (e) { return {error: `连不上牌桌（${server.url}）：${e?.message ?? e}`}; }
}

const out = (msg) => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...msg}) + '\n');
const KNOWN = ['2025-06-18', '2025-03-26', '2024-11-05'];

async function handle(msg) {
  const {id, method, params} = msg;
  if (id === undefined || id === null) return; // notifications (initialized, cancelled): nothing to answer
  if (method === 'initialize') {
    const v = KNOWN.includes(params?.protocolVersion) ? params.protocolVersion : KNOWN[0];
    return out({id, result: {protocolVersion: v, capabilities: {tools: {}}, serverInfo: {name: 'holdem-duet', version: '0.1.0'}}});
  }
  if (method === 'ping') return out({id, result: {}});
  if (method === 'tools/list') return out({id, result: {tools: TOOLS}});
  if (method === 'tools/call') {
    const name = params?.name;
    if (!TOOLS.some((t) => t.name === name)) return out({id, error: {code: -32602, message: `unknown tool: ${name}`}});
    const r = await callTool(name, params?.arguments ?? {});
    return out({id, result: {content: [{type: 'text', text: JSON.stringify(r)}], ...(r?.error && !r.now ? {isError: true} : {})}});
  }
  return out({id, error: {code: -32601, message: `method not found: ${method}`}});
}

const rl = createInterface({input: process.stdin});
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return out({id: null, error: {code: -32700, message: 'parse error'}}); }
  handle(msg).catch((e) => { if (msg?.id !== undefined) out({id: msg.id, error: {code: -32603, message: String(e?.message ?? e)}}); });
});
