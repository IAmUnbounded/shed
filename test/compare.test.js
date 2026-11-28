import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { compareStore, compareSummary, buildReviewPrompt } from '../server/compare.js';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(fn, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { const v = await fn(); if (v) return v; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for condition.');
}

test('compareStore persists comparisons and syncs contestant states', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-cmp-store-'));
  try {
    const store = compareStore(dir);
    store.add({
      id: 'cmp1',
      title: 'Add dark mode',
      prompt: 'Add dark mode toggle',
      project: '/tmp/app',
      status: 'running',
      winnerTaskId: null,
      winnerHarness: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: [
        { harness:'claude', taskId:'t1', sessionId:null, cwd:'/tmp/wt1', branch:'shed/dark-claude', status:'running', output:'', error:'' },
        { harness:'codex', taskId:'t2', sessionId:null, cwd:'/tmp/wt2', branch:'shed/dark-codex', status:'running', output:'', error:'' },
      ],
    });
    const tasks = {
      t1: { id:'t1', status:'completed', sessionId:'claude:s1', model:'sonnet', output:'Implemented in CSS' },
      t2: { id:'t2', status:'completed', sessionId:'codex:s2', model:'gpt-6', output:'Implemented with theme provider' },
    };
    const changed = store.sync(id => tasks[id], () => null);
    assert.equal(changed, true);
    const reloaded = compareStore(dir).get('cmp1');
    assert.equal(reloaded.status, 'ready');
    assert.equal(reloaded.entries[0].sessionId, 'claude:s1');
    assert.equal(compareSummary(reloaded).entries[1].model, 'gpt-6');
  } finally {
    fs.rmSync(dir, { recursive:true, force:true });
  }
});

test('buildReviewPrompt lists changed files and includes shed ask when author is live', () => {
  const text = buildReviewPrompt({
    authorSession: { id:'codex:abc', harness:'codex', title:'Fix billing retry' },
    branch: 'shed/fix-billing-retry',
    files: [{ path:'server/billing.js', status:'M', additions:12, deletions:4, binary:false }],
    focus: 'Check idempotency keys',
    shedCli: '/bin/shed',
    canAskAuthor: true,
  });
  assert.match(text, /focused code review of changes made by Codex/);
  assert.match(text, /shed\/fix-billing-retry/);
  assert.match(text, /server\/billing\.js \(\+12 \/ -4\)/);
  assert.match(text, /Check idempotency keys/);
  assert.match(text, /\/bin\/shed ask codex:abc/);
});

test('end-to-end: compare fan-out, winner pick with worktree cleanup, cross-harness review, and GitHub issue picker', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shed-cmp-e2e-')));
  const home = path.join(dir, 'home'), bin = path.join(dir, 'bin'), project = path.join(dir, 'project');
  fs.mkdirSync(bin, { recursive:true });
  fs.mkdirSync(project, { recursive:true });

  // Seed a git repo with an existing Codex session so Shed knows the project
  const g = (...args) => execFileSync('git', args, { cwd:project, encoding:'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'dev@example.com'); g('config', 'user.name', 'Dev');
  fs.writeFileSync(path.join(project, 'index.js'), 'export const v = 1;\n');
  g('add', '-A'); g('commit', '-q', '-m', 'init');

  const sid = '11111111-1111-4111-8111-111111111111';
  const sessionDir = path.join(home, '.codex', 'sessions', '2026', '11', '26');
  fs.mkdirSync(sessionDir, { recursive:true });
  fs.writeFileSync(path.join(sessionDir, `rollout-2026-11-26T00-00-00-${sid}.jsonl`), [
    JSON.stringify({ type:'session_meta', payload:{ id:sid, cwd:project } }),
    JSON.stringify({ timestamp:'2026-11-26T00:00:01.000Z', type:'response_item', payload:{ type:'message', role:'user', content:[{ type:'input_text', text:'Initial task' }] } }),
    JSON.stringify({ timestamp:'2026-11-26T00:00:02.000Z', type:'response_item', payload:{ type:'message', role:'assistant', content:[{ type:'output_text', text:'Done.' }] } }),
  ].join('\n') + '\n');

  // Fake codex, claude, and gh CLIs
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex 1.0'; exit 0; fi
if [ "$1" = "login" ]; then echo 'Logged in'; exit 0; fi
if [ "$1" = "exec" ]; then
  cat >/dev/null
  echo '// codex edit' >> index.js
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"Codex finished the change."}}'
  exit 0
fi
exit 0
`);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'claude 1.0'; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"loggedIn":true}'; exit 0; fi
if [ "$1" = "-p" ]; then
  echo '// claude edit' >> index.js
  echo '{"type":"result","result":"Claude finished the change."}'
  exit 0
fi
exit 0
`);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  echo '[{"number":42,"title":"Add retry logic","url":"https://github.com/o/r/issues/42","labels":[{"name":"bug"}],"author":{"login":"alice"},"updatedAt":"2026-11-26T00:00:00Z","body":"Please retry failed calls."}]'
  exit 0
fi
exit 1
`);
  for (const name of ['codex', 'claude', 'gh']) fs.chmodSync(path.join(bin, name), 0o755);

  const port = await freePort(), token = 'cmp-secret', base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, HOME:home, PATH:`${bin}:/usr/bin:/bin`, LAYA_DATA_DIR:path.join(dir, 'data'), LAYA_TOKEN:token, LAYA_PRELOAD:'0', LAYA_HEADLESS_CLAUDE:'1', LAYA_HEADLESS_CODEX:'1', SHED_TERMINAL_WORKER:'0', HOST:'127.0.0.1', PORT:String(port) },
    stdio: 'ignore',
  });
  const headers = { Authorization:`Bearer ${token}`, 'Content-Type':'application/json' };
  const req = async (url, init) => {
    const res = await fetch(base + url, { headers, ...init });
    return { status:res.status, data:await res.json() };
  };

  try {
    await waitFor(async () => (await fetch(`${base}/api/auth/status`)).ok);
    await waitFor(async () => {
      const { data } = await req('/api/harness-health?force=1');
      return data.harnesses?.codex?.state === 'ready' && data.harnesses?.claude?.state === 'ready';
    });

    // 1. GitHub Issue picker
    const issuesRes = await req(`/api/issues?cwd=${encodeURIComponent(project)}`);
    assert.equal(issuesRes.status, 200);
    assert.equal(issuesRes.data.issues.length, 1);
    assert.equal(issuesRes.data.issues[0].number, 42);

    // 2. Fan-out & Compare across claude + codex
    const created = await req('/api/comparisons', {
      method: 'POST',
      body: JSON.stringify({ prompt:'Improve retry logic', harnesses:['claude', 'codex'], models:{ claude:'sonnet' }, cwd:project }),
    });
    assert.equal(created.status, 201, created.data.error);
    const compId = created.data.comparison.id;
    assert.equal(created.data.comparison.entries.length, 2);
    const [eClaude, eCodex] = created.data.comparison.entries;
    assert.notEqual(eClaude.cwd, eCodex.cwd);
    assert.match(eClaude.branch, /^shed\/improve-retry-logic-claude/);
    assert.match(eCodex.branch, /^shed\/improve-retry-logic-codex/);

    // Wait for both contestants to complete and inspect live diff stats
    const detail = await waitFor(async () => {
      const { data } = await req(`/api/comparisons/${compId}`);
      return data.comparison.status === 'ready' ? data.comparison : null;
    });
    assert.equal(detail.entries[0].diff.filesCount, 1);
    assert.equal(detail.entries[1].diff.filesCount, 1);

    // 3. Worktrees list shows both branches
    const wtList = await req('/api/worktrees');
    assert.equal(wtList.status, 200);
    assert.equal(wtList.data.worktrees.length, 2);

    // 4. Pick winner & force-cleanup losing worktree
    const picked = await req(`/api/comparisons/${compId}/pick`, {
      method: 'POST',
      body: JSON.stringify({ taskId:eClaude.taskId, cleanupOthers:true, force:true }),
    });
    assert.equal(picked.status, 200, picked.data.error);
    assert.equal(picked.data.comparison.winnerHarness, 'claude');
    assert.equal(fs.existsSync(eClaude.cwd), true, 'winner worktree kept');
    assert.equal(fs.existsSync(eCodex.cwd), false, 'loser worktree removed');

    // 5. Cross-harness review on the original session
    fs.writeFileSync(path.join(project, 'index.js'), 'export const v = 2;\n');
    const rev = await req(`/api/sessions/${encodeURIComponent(`codex:${sid}`)}/review`, {
      method: 'POST',
      body: JSON.stringify({ harness:'claude', model:'sonnet' }),
    });
    assert.equal(rev.status, 201, rev.data.error);
    assert.equal(rev.data.task.harness, 'claude');
    assert.equal(rev.data.task.cwd, project, 'review runs in the exact checkout being reviewed');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  }
});
