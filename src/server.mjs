// The server: the table page for the human, and the AI's door (/api/ai/*, used by mcp.mjs with a token).
// Binds 127.0.0.1 by default. The human's API has no login (it is your own machine); use --host only on a network you trust.
import {createServer} from 'node:http';
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {extname, join, normalize, resolve, sep} from 'node:path';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {PokerError} from './engine.mjs';
import {createTable, TALK_MAX} from './table.mjs';

const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2'};
const AI_TOOLS = new Set(['poker_start', 'poker_look', 'poker_act', 'poker_wait']);

/** The token the AI's side needs: made once, kept in the data folder (0600). */
export function aiToken(dir) {
  const p = join(dir, 'token');
  try { const s = readFileSync(p, 'utf8').trim(); if (s.length >= 32) return s; } catch {}
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const s = randomBytes(24).toString('hex');
  writeFileSync(p, s + '\n', {mode: 0o600});
  return s;
}
const same = (a, b) => { const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

async function readBody(req, max = 16 * 1024) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > max) throw new PokerError('TOO_BIG', '太长了'); chunks.push(c); }
  if (!n) return {};
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); return v && typeof v === 'object' ? v : {}; }
  catch { throw new PokerError('BAD_JSON', '不是 JSON'); }
}

/**
 * Start the server. dir: the data folder. web: the built page (web/dist). Returns {server, table, url, close()}.
 * onTable(table): called once the table exists (autoplay hangs itself on it).
 */
export async function startServer({dir, web, host = '127.0.0.1', port = 5480, aiName = 'AI', mode = 'mcp', log = () => {}, onChange = () => {}, now, rnd} = {}) {
  const token = aiToken(dir);
  const table = createTable({dir, aiName, mode, log, onChange: () => onChange(table), ...(now ? {now} : {}), ...(rnd ? {rnd} : {})});
  const root = web ? resolve(web) : null;

  const send = (res, status, body) => { res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}); res.end(JSON.stringify(body)); };
  const fail = (res, status, code, message) => send(res, status, {error: code, ...(message ? {message} : {})});

  function serveFile(res, path) {
    if (!root) return fail(res, 404, 'NO_PAGE', '页面还没构建：npm run build');
    const rel = path === '/' ? '/index.html' : path;
    const file = normalize(join(root, decodeURIComponent(rel)));
    if (file !== root && !file.startsWith(root + sep)) return fail(res, 404, 'NOT_FOUND');
    if (!existsSync(file) || !statSync(file).isFile()) return fail(res, 404, 'NOT_FOUND');
    res.writeHead(200, {'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': rel === '/index.html' ? 'no-cache' : 'public, max-age=3600'});
    res.end(readFileSync(file));
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;
      if (req.method === 'GET' && !path.startsWith('/api/')) return serveFile(res, path);

      // the AI's door: mcp.mjs, with the token
      if (path.startsWith('/api/ai/')) {
        if (req.method !== 'POST') return fail(res, 405, 'METHOD');
        if (!same(req.headers['x-holdem-token'], token)) return fail(res, 401, 'TOKEN');
        const tool = path.slice('/api/ai/'.length);
        if (!AI_TOOLS.has(tool)) return fail(res, 404, 'NO_TOOL');
        const args = await readBody(req);
        if (tool === 'poker_wait') {
          const ms = Math.min(Math.max(Number(args.seconds ?? 50) * 1000, 1000), 110000);
          return send(res, 200, await table.waitTurn(ms));
        }
        if (typeof args.say === 'string' && args.say.length > TALK_MAX) args.say = args.say.slice(0, TALK_MAX);
        return send(res, 200, table.call(tool, args));
      }

      // the human's page. The header keeps other sites' forms out (a cross-site form cannot set it).
      if (req.headers['x-holdem'] !== '1') return fail(res, 403, 'HEADER');
      if (path === '/api/table' && req.method === 'GET') {
        const since = Number(url.searchParams.get('since'));
        if (Number.isSafeInteger(since)) await table.wait(since);
        return send(res, 200, table.view());
      }
      if (req.method !== 'POST') return fail(res, 405, 'METHOD');
      const b = await readBody(req);
      const what = path.slice('/api/'.length);
      if (what === 'start') return send(res, 200, table.start('human'));
      if (what === 'next') return send(res, 200, table.next());
      if (what === 'act') return send(res, 200, table.act('human', {action: String(b.action ?? ''), amount: b.amount === undefined ? undefined : Number(b.amount)}));
      if (what === 'show') return send(res, 200, table.show());
      if (what === 'say') return send(res, 200, table.say('human', b.text));
      if (what === 'end') return send(res, 200, table.end());
      if (what === 'retry') { table.setCall('idle'); onChange(table, {retry: true}); return send(res, 200, table.view()); }
      return fail(res, 404, 'NOT_FOUND');
    } catch (e) {
      if (e instanceof PokerError) return fail(res, 409, e.code, e.message);
      log(`error: ${e?.stack ?? e}`);
      return fail(res, 500, 'INTERNAL');
    }
  });
  server.requestTimeout = 0; // the long polls
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, host, ok); });
  const real = server.address().port;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${real}`;
  // where mcp.mjs finds the server (the token stays in its own file)
  writeFileSync(join(dir, 'server.json'), JSON.stringify({url: `http://127.0.0.1:${real}`, pid: process.pid}) + '\n', {mode: 0o600});
  return {server, table, url, port: real, close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); })};
}
