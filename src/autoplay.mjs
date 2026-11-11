// Auto mode: when it is the AI's turn (or a match it played is over), the server calls it itself with Claude Code
// in print mode (`claude -p`), the letter on stdin, this project's MCP tools loaded. The session id is kept, so the
// next call resumes the same conversation: the AI remembers the match, its table talk, what it was thinking.
// Your own Claude Code login is used as it is; nothing here reads or passes credentials.
import {spawn} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const MCP = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
export const TOOLS = ['poker_act', 'poker_look', 'poker_start'].map((n) => `mcp__holdem__${n}`);
export const FOOT = '你直接写的字对方看不到，只有写在 poker_act 的 say 里的话会显示在牌桌上。';

/** Run the command once: prompt on stdin, JSON on stdout. Resolves {sessionId, isError, text} or rejects. */
function runOnce({command, args, prompt, cwd, timeoutMs, env}) {
  return new Promise((ok, no) => {
    const child = spawn(command, args, {cwd, env, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); no(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); no(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let r = null;
      try { r = JSON.parse(out.trim().split('\n').at(-1)); } catch {}
      if (!r) return no(new Error(`exit ${code}: ${(err || out).trim().slice(0, 300)}`));
      ok({sessionId: r.session_id ?? null, isError: !!r.is_error, text: r.result ?? ''});
    });
    child.stdin.end(prompt);
  });
}

/**
 * dir: the data folder (the MCP config and the session id go there). command/extraArgs: how to call the AI
 * (default `claude`). session: a Claude Code session id to resume for the first call (your own conversation), else a new one.
 */
export function createAutoplay({dir, command = 'claude', extraArgs = [], session = null, cwd = dir, timeoutMs = 5 * 60 * 1000, log = () => {}, env = process.env}) {
  const mcpConfig = join(dir, 'mcp-auto.json');
  writeFileSync(mcpConfig, JSON.stringify({mcpServers: {holdem: {command: process.execPath, args: [MCP, '--dir', dir, '--no-wait']}}}, null, 2) + '\n', {mode: 0o600});
  const sessionFile = join(dir, 'auto-session.json');
  const readSession = () => { try { return JSON.parse(readFileSync(sessionFile, 'utf8')).id ?? null; } catch { return null; } };
  let busy = false, lastKey = null;

  async function drain(table) {
    if (busy) return;
    busy = true;
    try {
      for (let due = table.due(); due; due = table.due()) {
        if (due.key === lastKey) { table.setCall('missed', '叫了它，它没出手'); log('auto: called the AI, it did not act'); break; }
        const prompt = `${table.letter(due)}\n${FOOT}`;
        const sid = readSession() ?? session;
        const args = ['-p', '--output-format', 'json', `--mcp-config=${mcpConfig}`, `--allowedTools=${TOOLS.join(',')}`, ...(sid ? ['--resume', sid] : []), ...extraArgs];
        table.setCall('calling');
        table.told(due);
        lastKey = due.key;
        let r;
        try { r = await runOnce({command, args, prompt, cwd, timeoutMs, env}); }
        catch (e) { table.setCall('error', `叫 AI 出错：${String(e?.message ?? e).slice(0, 160)}`); log(`auto: ${e?.message ?? e}`); break; }
        if (r.sessionId) writeFileSync(sessionFile, JSON.stringify({id: r.sessionId}) + '\n', {mode: 0o600});
        if (r.isError) { table.setCall('error', `AI 这一轮出错：${r.text.slice(0, 160)}`); break; }
        table.setCall('idle');
      }
    } finally { busy = false; }
  }

  return {
    /** The table moved (or the page asked to call again). */
    onChange(table, {retry = false} = {}) { if (retry) lastKey = null; void drain(table); },
    get busy() { return busy; },
  };
}
