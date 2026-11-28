import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { captureCheckpoint, revertToCheckpoint, checkpointChanges, checkpointFileDiff, checkpointStore } from '../server/checkpoints.js';
import { queueStore, planModePrompt, steerPrompt } from '../server/queue.js';
import { discoverScripts, runProjectScript } from '../server/scripts.js';
import { sessionWorktree, commitAll, branchChanges, branchFileDiff } from '../server/git.js';

function gitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shed-turn-repo-')));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'dev@example.com');
  g('config', 'user.name', 'Dev');
  fs.writeFileSync(path.join(dir, 'app.js'), 'export const step = 0;\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'Initial commit');
  return { dir, g };
}

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
    await new Promise(r => setTimeout(r, 80));
  }
  throw new Error('Timed out waiting for condition.');
}

test('hidden Git checkpoints capture tracked + untracked files, diff cleanly, and rewind without touching git log or .shed/', async () => {
  const { dir, g } = gitRepo();
  try {
    // Seed a .shed upload that must never be deleted on rewind
    fs.mkdirSync(path.join(dir, '.shed', 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.shed', 'uploads', 'keep.txt'), 'safe');

    // Turn 1: edit app.js and create untracked helper.js
    fs.writeFileSync(path.join(dir, 'app.js'), 'export const step = 1;\n');
    fs.writeFileSync(path.join(dir, 'helper.js'), 'export const help = 1;\n');
    const cp1 = await captureCheckpoint(dir, { label: 'After turn 1', sessionId: 'claude:s1' });
    assert.ok(cp1?.commit);
    assert.equal(g('stash', 'list').trim(), '', 'git stash list stays empty');
    assert.equal(g('rev-list', '--count', 'HEAD').trim(), '1', 'git log stays untouched');

    // Turn 2: break app.js, edit helper.js, and create junk.js
    fs.writeFileSync(path.join(dir, 'app.js'), 'export const step = 999;\n');
    fs.writeFileSync(path.join(dir, 'helper.js'), 'export const help = 999;\n');
    fs.writeFileSync(path.join(dir, 'junk.js'), 'bad\n');

    const diffSummary = await checkpointChanges(dir, cp1.commit);
    assert.deepEqual(diffSummary.files.map(f => f.path).sort(), ['app.js', 'helper.js', 'junk.js']);
    const filePatch = await checkpointFileDiff(dir, cp1.commit, '', 'app.js');
    assert.ok(filePatch.hunks[0].lines.some(l => l.t === '+' && l.text.includes('999')));

    // Rewind to cp1
    await revertToCheckpoint(dir, cp1.commit);
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), 'export const step = 1;\n');
    assert.equal(fs.readFileSync(path.join(dir, 'helper.js'), 'utf8'), 'export const help = 1;\n');
    assert.equal(fs.existsSync(path.join(dir, 'junk.js')), false, 'extra untracked file removed on rewind');
    assert.equal(fs.readFileSync(path.join(dir, '.shed', 'uploads', 'keep.txt'), 'utf8'), 'safe', '.shed uploads preserved');
    assert.equal(g('rev-list', '--count', 'HEAD').trim(), '1', 'HEAD untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('branchChanges and branchFileDiff show full branch diff vs base branch even after committing', async () => {
  const { dir } = gitRepo();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shed-brdiff-')));
  try {
    const wt = await sessionWorktree(dir, 'Branch review', { home });
    fs.writeFileSync(path.join(wt.path, 'app.js'), 'export const step = 2;\n');
    fs.writeFileSync(path.join(wt.path, 'added.js'), 'export const added = true;\n');
    await commitAll(wt.path, 'Implement step 2');
    // Working tree is now clean, but Whole Branch diff must still show both files vs main!
    const br = await branchChanges(wt.path);
    assert.equal(br.scope, 'branch');
    assert.equal(br.baseBranch, 'main');
    assert.equal(br.commitsAhead, 1);
    assert.deepEqual(br.files.map(f => f.path).sort(), ['added.js', 'app.js']);
    const d = await branchFileDiff(wt.path, 'app.js');
    assert.ok(d.hunks[0].lines.some(l => l.t === '+' && l.text.includes('step = 2')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('discoverScripts and runProjectScript run package.json and .shed.yaml scripts safely and reject unknown IDs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-scripts-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo',
      scripts: { dev: 'node server.js', test: 'node -e "console.log(\'PASS_OK\')"', failcheck: 'node -e "console.error(\'FAIL_NOW\'); process.exit(2)"' },
    }));
    fs.writeFileSync(path.join(dir, '.shed.yaml'), 'scripts:\n  quick: echo CUSTOM_OK\n');
    const list = discoverScripts(dir);
    assert.ok(list.some(s => s.id === 'cfg:quick'));
    assert.ok(list.some(s => s.id === 'npm:test'));
    assert.equal(list.some(s => s.name === 'dev'), false, 'long-running dev script skipped');

    const okRun = await runProjectScript(dir, 'cfg:quick');
    assert.equal(okRun.ok, true);
    assert.match(okRun.output, /CUSTOM_OK/);

    const failRun = await runProjectScript(dir, 'npm:failcheck');
    assert.equal(failRun.ok, false);
    assert.equal(failRun.code, 2);
    assert.match(failRun.output, /FAIL_NOW/);

    await assert.rejects(runProjectScript(dir, 'cfg:nonexistent'), /not defined/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('queueStore persists FIFO queue items, cancels, promotes by ID, and formats plan/steer prompts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-q-'));
  try {
    const q = queueStore(dir);
    const a = q.enqueue({ sessionId: 'claude:1', prompt: 'First follow-up', mode: 'plan' });
    const b = q.enqueue({ sessionId: 'claude:1', prompt: 'Second follow-up' });
    assert.equal(queueStore(dir).forSession('claude:1').length, 2);
    assert.equal(q.takeById(b.id).prompt, 'Second follow-up');
    assert.equal(q.takeNext('claude:1').id, a.id);
    assert.equal(q.forSession('claude:1').length, 0);
    assert.match(planModePrompt('Add auth'), /PLAN MODE — DO NOT EDIT FILES/);
    assert.match(steerPrompt('Use JWT instead'), /course correction/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkpointStore deduplicates identical trees and attaches sessionId by taskId', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-cpstore-'));
  try {
    const store = checkpointStore(dir);
    const c1 = store.add({ id: 'cp-1', root: '/tmp/p', sessionId: '', taskId: 't1', tree: 'aaa', kind: 'pre-turn', label: 'Before', commit: '1111111' });
    const c2 = store.add({ id: 'cp-2', root: '/tmp/p', sessionId: '', taskId: 't1', tree: 'aaa', kind: 'pre-turn', label: 'Before', commit: '2222222' });
    assert.equal(c1.id, c2.id, 'identical adjacent checkpoint deduplicated');
    store.attachSession('t1', 'claude:abc');
    assert.equal(checkpointStore(dir).forSession('claude:abc')[0].id, 'cp-1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('end-to-end: plan mode, auto checkpoints + rewind, branch diff scope, queue + mid-run steer, and project scripts API', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shed-turn-e2e-')));
  const home = path.join(dir, 'home'), bin = path.join(dir, 'bin'), project = path.join(dir, 'project');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  const g = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'dev@example.com'); g('config', 'user.name', 'Dev');
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node -e "console.log(\'UNIT_OK\')"' } }));
  fs.writeFileSync(path.join(project, 'app.js'), 'export const val = 1;\n');
  g('add', '-A'); g('commit', '-q', '-m', 'init');

  // Seed an existing Claude session in `project`
  const claudeId = '22222222-2222-4222-8222-222222222222';
  const claudeDir = path.join(home, '.claude', 'projects', 'demo');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, `${claudeId}.jsonl`), [
    JSON.stringify({ type: 'user', sessionId: claudeId, cwd: project, timestamp: '2026-11-26T00:00:01Z', message: { role: 'user', content: 'Setup app' } }),
    JSON.stringify({ type: 'assistant', sessionId: claudeId, cwd: project, timestamp: '2026-11-26T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Ready.' }] } }),
  ].join('\n') + '\n');

  const claudeArgsLog = path.join(dir, 'claude-args.log');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'claude 1.0'; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"loggedIn":true}'; exit 0; fi
printf '%s\\n---\\n' "$*" >> "${claudeArgsLog}"
case "$*" in
  *"SLOW_TURN"*)
    sleep 4
    echo '{"type":"result","result":"Slow finished."}'
    exit 0
    ;;
  *"PLAN MODE"*)
    echo '{"type":"result","result":"Step 1: edit app.js"}'
    exit 0
    ;;
  *)
    echo 'export const val = 42;' > app.js
    echo '{"type":"result","result":"Updated app.js to 42."}'
    exit 0
    ;;
esac
`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);

  const port = await freePort(), token = 'turn-secret', base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, LAYA_DATA_DIR: path.join(dir, 'data'), LAYA_TOKEN: token, LAYA_PRELOAD: '0', LAYA_HEADLESS_CLAUDE: '1', LAYA_HEADLESS_CODEX: '1', SHED_TERMINAL_WORKER: '0', HOST: '127.0.0.1', PORT: String(port) },
    stdio: 'ignore',
  });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const req = async (url, init) => {
    const res = await fetch(base + url, { headers, ...init });
    return { status: res.status, data: await res.json() };
  };
  const sid = encodeURIComponent(`claude:${claudeId}`);

  try {
    await waitFor(async () => (await fetch(`${base}/api/auth/status`)).ok);
    await waitFor(async () => (await req('/api/harness-health?force=1')).data.harnesses?.claude?.state === 'ready');

    // 1. Project scripts discovery + execution
    const scriptsRes = await req(`/api/sessions/${sid}/scripts`);
    assert.equal(scriptsRes.status, 200);
    assert.ok(scriptsRes.data.scripts.some(s => s.id === 'npm:test'));
    const runRes = await req(`/api/sessions/${sid}/scripts/run`, { method: 'POST', body: JSON.stringify({ id: 'npm:test' }) });
    assert.equal(runRes.status, 200);
    assert.equal(runRes.data.result.ok, true);
    assert.match(runRes.data.result.output, /UNIT_OK/);

    // 2. Plan mode passes --permission-mode plan and does not modify files
    const planRes = await req('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Plan refactor', mode: 'plan', sessionId: `claude:${claudeId}`, followup: 'stay', model: 'sonnet', newSession: false }),
    });
    assert.equal(planRes.status, 201, planRes.data.error);
    assert.equal(planRes.data.task.mode, 'plan');
    await waitFor(async () => (await req(`/api/tasks/${planRes.data.task.id}`)).data.task.status === 'completed');
    assert.match(fs.readFileSync(claudeArgsLog, 'utf8'), /--permission-mode plan/);
    assert.equal(fs.readFileSync(path.join(project, 'app.js'), 'utf8'), 'export const val = 1;\n');

    // 3. Build turn automatically creates pre-turn & post-turn checkpoints, and revert restores val = 1
    const buildRes = await req('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Change val to 42', mode: 'build', sessionId: `claude:${claudeId}`, followup: 'stay', model: 'sonnet', newSession: false }),
    });
    assert.equal(buildRes.status, 201, buildRes.data.error);
    await waitFor(async () => (await req(`/api/tasks/${buildRes.data.task.id}`)).data.task.status === 'completed');
    assert.equal(fs.readFileSync(path.join(project, 'app.js'), 'utf8').trim(), 'export const val = 42;');

    const cps = await waitFor(async () => {
      const { data } = await req(`/api/sessions/${sid}/checkpoints`);
      return data.checkpoints.length >= 2 ? data.checkpoints : null;
    });
    const preCp = cps.find(c => c.kind === 'pre-turn');
    assert.ok(preCp, 'pre-turn checkpoint captured automatically');
    const revRes = await req(`/api/sessions/${sid}/checkpoints/${preCp.id}/revert`, { method: 'POST', body: '{}' });
    assert.equal(revRes.status, 200, revRes.data.error);
    assert.ok(revRes.data.backup, 'safety backup checkpoint saved before rewind');
    assert.equal(fs.readFileSync(path.join(project, 'app.js'), 'utf8'), 'export const val = 1;\n');

    // 4. Universal Queue while busy + Mid-Run Steer interrupts slow turn immediately
    const slow = await req('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'SLOW_TURN long job', mode: 'build', sessionId: `claude:${claudeId}`, followup: 'stay', model: 'sonnet', newSession: false }),
    });
    assert.equal(slow.status, 201);
    const queued = await req('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Queued follow-up', mode: 'build', queueIfBusy: true, sessionId: `claude:${claudeId}`, followup: 'stay', model: 'sonnet', newSession: false }),
    });
    assert.equal(queued.status, 202, 'busy session queues follow-up instead of 409');
    assert.equal(queued.data.queued, true);
    assert.equal(queued.data.items.length, 1);

    // Promote queued item to steer immediately!
    const steered = await req(`/api/sessions/${sid}/steer`, {
      method: 'POST',
      body: JSON.stringify({ queueId: queued.data.item.id }),
    });
    assert.equal(steered.status, 201, steered.data.error);
    await waitFor(async () => (await req(`/api/tasks/${steered.data.task.id}`)).data.task.status === 'completed');
    const qAfter = await req(`/api/sessions/${sid}/queue`);
    assert.equal(qAfter.data.items.length, 0);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
