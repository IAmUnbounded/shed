import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { cleanupSuggestions } from '../server/cleanup.js';

const now = Date.parse('2026-11-02T12:00:00Z');
const hoursAgo = h => new Date(now - h * 3600 * 1000).toISOString();
const session = (id, extra = {}) => ({ id, harness:'claude', title:`Build the ${id} dashboard for the team`, cwd:`/work/${id}`, liveState:'history', updatedAt:hoursAgo(5), replied:true, ...extra });

test('clutter is sessions that never answered, tests, deleted folders and repeats, never live or fresh ones', () => {
  const list = [
    session('kept'),
    session('silent', { replied:false }),
    session('silent-live', { replied:false, liveState:'open' }),
    session('silent-fresh', { replied:false, updatedAt:hoursAgo(0.1) }),
    session('probe', { title:'Reply with just the word READY' }),
    session('scratch', { cwd:'/private/tmp/claude-501/work' }),
    session('gone', { cwd:'/work/deleted' }),
    session('twice-old', { title:'Find apartments downtown near the office', cwd:'/work/apt', updatedAt:hoursAgo(9) }),
    session('twice-new', { title:'Find apartments downtown near the office', cwd:'/work/apt-2', updatedAt:hoursAgo(8) }),
    session('twice-other-harness', { harness:'codex', title:'Find apartments downtown near the office', cwd:'/work/apt' }),
  ];
  const reasons = cleanupSuggestions(list, { now, exists:dir => dir !== '/work/deleted', tempDirs:['/private/tmp/'] });
  assert.deepEqual(Object.fromEntries(reasons), { silent:'never answered', probe:'test run', scratch:'test run', gone:'folder deleted', 'twice-old':'duplicate' });
});

test('a repeat that answered is kept over a newer one that did not', () => {
  const list = [
    session('answered', { title:'Summarise this research paper for me', updatedAt:hoursAgo(9) }),
    session('retry', { title:'Summarise this research paper for me', updatedAt:hoursAgo(8), replied:false }),
  ];
  assert.deepEqual(Object.fromEntries(cleanupSuggestions(list, { now, exists:() => true })), { retry:'never answered' });
});

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('sessions are ordered by their last message, and cleared ones stay cleared until put back', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shed-cleanup-')));
  const home = path.join(dir, 'home'), project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive:true });
  const folder = path.join(home, '.claude', 'projects', 'project');
  fs.mkdirSync(folder, { recursive:true });
  const write = (id, rows, mtime) => {
    const file = path.join(folder, `${id}.jsonl`);
    fs.writeFileSync(file, rows.map(r => JSON.stringify({ sessionId:id, cwd:project, ...r })).join('\n') + '\n');
    fs.utimesSync(file, new Date(mtime), new Date(mtime));
  };
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  // Spoke on day 1 but was closed (bookkeeping appended) on day 3: it belongs below the one that spoke on day 2.
  write(ids[0], [
    { type:'user', timestamp:'2026-10-01T10:00:00Z', message:{ content:'Plan the billing migration for next week' } },
    { type:'assistant', timestamp:'2026-10-01T10:01:00Z', message:{ content:[{ type:'text', text:'Here is the plan.' }] } },
    { type:'cost-state' },
  ], '2026-10-03T00:00:00Z');
  write(ids[1], [
    { type:'user', timestamp:'2026-10-02T10:00:00Z', message:{ content:'Fix the flaky login test in CI' } },
    { type:'assistant', timestamp:'2026-10-02T10:01:00Z', message:{ content:[{ type:'text', text:'Fixed.' }] } },
  ], '2026-10-02T10:01:00Z');
  write(ids[2], [{ type:'user', timestamp:'2026-10-01T09:00:00Z', message:{ content:'Write the release notes for 2.0' } }], '2026-10-01T09:00:00Z');

  const port = await freePort(), token = 'cleanup-secret', base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], { cwd:path.resolve('.'), env:{ ...process.env, HOME:home, PATH:'/usr/bin:/bin', LAYA_DATA_DIR:path.join(dir, 'data'), LAYA_TOKEN:token, LAYA_PRELOAD:'0', SHED_LAN:'1', SHED_TERMINAL_WORKER:'0', HOST:'127.0.0.1', PORT:String(port) }, stdio:'ignore' });
  const call = async (url, options = {}) => (await fetch(base + url, { ...options, headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' } })).json();
  try {
    for (let i = 0; i < 200; i++) { try { if ((await fetch(`${base}/api/auth/status`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 15)); }
    let { sessions } = await call('/api/sessions');
    assert.deepEqual(sessions.map(s => s.id), [ids[1], ids[0], ids[2]].map(id => `claude:${id}`));
    assert.equal(sessions[1].updatedAt, '2026-10-01T10:01:00.000Z');
    assert.deepEqual(sessions.map(s => s.cleanup), ['', '', 'never answered']);

    assert.equal((await call('/api/sessions/hide', { method:'POST', body:JSON.stringify({ ids:[`claude:${ids[2]}`, 'claude:not-a-session'] }) })).hidden, 1);
    ({ sessions } = await call('/api/sessions'));
    assert.deepEqual(sessions.filter(s => s.hidden).map(s => s.id), [`claude:${ids[2]}`]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'settings.json'), 'utf8')).hiddenSessions.length, 1, 'kept across restarts');
    assert.ok(fs.existsSync(path.join(folder, `${ids[2]}.jsonl`)), 'the transcript is untouched');

    await call('/api/sessions/hide', { method:'POST', body:JSON.stringify({ ids:[`claude:${ids[2]}`], hidden:false }) });
    ({ sessions } = await call('/api/sessions'));
    assert.equal(sessions.filter(s => s.hidden).length, 0);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  }
});
