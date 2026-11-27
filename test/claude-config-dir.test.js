import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code keeps its projects and live-session records under CLAUDE_CONFIG_DIR when it is set.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-claude-config-'));
process.env.CLAUDE_CONFIG_DIR = configDir;
const { discoverSessions } = await import('../server/sessions.js');
const { claudeLiveSessions } = await import('../server/terminal.js');

const project = path.join(configDir, 'projects', '-tmp-project');
fs.mkdirSync(project, { recursive:true });
const write = (name, rows) => fs.writeFileSync(path.join(project, name), rows.map(x => JSON.stringify(x)).join('\n') + '\n');

test('Claude sessions are found under CLAUDE_CONFIG_DIR', () => {
  write('11111111-1111-1111-1111-111111111111.jsonl', [
    { type:'user', sessionId:'11111111-1111-1111-1111-111111111111', cwd:'/tmp/project', message:{ role:'user', content:'Build the lunar dashboard please' } },
  ]);
  const found = discoverSessions().find(s => s.nativeId === '11111111-1111-1111-1111-111111111111');
  assert.equal(found?.title, 'Build the lunar dashboard please');
});

test('a long session with no prompt in its first 256 KB keeps its saved title and cwd', () => {
  const id = '22222222-2222-2222-2222-222222222222';
  const snapshot = { type:'file-history-snapshot', snapshot:{ padding:'x'.repeat(8 * 1024) } };
  write(`${id}.jsonl`, [
    { type:'ai-title', aiTitle:'Mobile parity check', sessionId:id },
    ...Array.from({ length:40 }, () => snapshot),
    { type:'user', sessionId:id, cwd:'/tmp/project', message:{ role:'user', content:'Carry on with the parity list' } },
  ]);
  const found = discoverSessions().find(s => s.nativeId === id);
  assert.ok(found, 'the session is listed, not hidden as untitled');
  assert.equal(found.title, 'Mobile parity check');
  assert.equal(found.cwd, '/tmp/project');
  assert.equal(found.lastPrompt, 'Carry on with the parity list');
});

test('live Claude sessions are read from CLAUDE_CONFIG_DIR/sessions', () => {
  const sessions = path.join(configDir, 'sessions');
  fs.mkdirSync(sessions, { recursive:true });
  fs.writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ pid:process.pid, sessionId:'33333333-3333-3333-3333-333333333333', status:'idle' }));
  assert.ok(claudeLiveSessions().has('33333333-3333-3333-3333-333333333333'));
});
