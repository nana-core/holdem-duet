#!/usr/bin/env node
// holdem-duet: start the table.
//   npm start                      MCP mode: your AI joins through the MCP tools and waits for its turn with poker_wait
//   npm start -- --auto            auto mode: the server calls the AI (Claude Code, `claude -p`) whenever it is its turn
// Options: --port 5480  --host 127.0.0.1  --dir ~/.holdem-duet  --ai-name AI  --command claude  --session <Claude Code session id>
// The same keys can sit in <dir>/config.json: {"port": 5480, "aiName": "AI", "auto": true, "command": "claude", "extraArgs": [], "session": null}
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dataDir} from './paths.mjs';
import {startServer} from './server.mjs';
import {createAutoplay} from './autoplay.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 7).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const dir = dataDir(opt('--dir'));
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')); } catch {}
const auto = argv.includes('--auto') || cfg.auto === true;
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const web = fileURLToPath(new URL('../web/dist', import.meta.url));

const player = auto ? createAutoplay({dir, command: opt('--command') ?? cfg.command ?? 'claude', extraArgs: cfg.extraArgs ?? [], session: opt('--session') ?? cfg.session ?? null, log}) : null;
const s = await startServer({dir, web, host: opt('--host') ?? cfg.host ?? '127.0.0.1', port: Number(opt('--port') ?? cfg.port ?? 5480),
  aiName: opt('--ai-name') ?? cfg.aiName ?? 'AI', mode: auto ? 'auto' : 'mcp', log, onChange: (table, o) => player?.onChange(table, o)});
player?.onChange(s.table); // something may have been waiting since last time

const mcp = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
console.log(`\n  牌桌：${s.url}\n  数据：${dir}\n  模式：${auto ? '自动（轮到 AI 时用 Claude Code 叫它）' : 'MCP（AI 用 poker_wait 等轮到自己）'}\n`);
if (!auto) console.log(`  把工具接给 Claude Code：\n    claude mcp add holdem -- "${process.execPath}" "${mcp}"${opt('--dir') ? ` --dir "${dir}"` : ''}\n  然后跟它说：「我们打德扑吧，你开一场，然后用 poker_wait 等轮到你。」\n`);
const stop = async () => { await s.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
