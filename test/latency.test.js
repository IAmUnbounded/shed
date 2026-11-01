import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';

// Latency budgets for what a phone does all day: open the app, poll the lists, open a session, review its changes and
// ship them. A fixture Mac with 300 sessions and a git project with real changes, served by a real Shed process.
// Budgets are p95 over many requests on this machine; they leave headroom for a busy laptop, not for a slow design.
const ROUNDS = 40;
const BUDGET_MS = {
  'GET / (page)':10, 'GET /app.js':10, 'GET /app.js (cached, 304)':5,
  'GET /api/sessions':30, 'GET /api/sessions (unchanged)':10, 'GET /api/tasks':10, 'GET /api/bootstrap':40,
  'GET /api/sessions/:id (conversation)':20, 'GET /api/sessions/:id/files':20,
  'GET /api/sessions/:id/changes':60, 'GET /api/sessions/:id/changes (unchanged)':60, 'GET /api/sessions/:id/diff':40,
};
const ONCE_BUDGET_MS = { 'server start → first answer':1500, 'commit 30 files':600, 'push to remote':1500, 'open pull request (gh)':1000 };

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const pct = (list, p) => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(p / 100 * list.length))];

function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shed-latency-')));
  const home = path.join(dir, 'home'), bin = path.join(dir, 'bin'), project = path.join(dir, 'project'), remote = path.join(dir, 'remote.git');
  fs.mkdirSync(bin, { recursive:true });
  // 300 Codex sessions with 40 messages each, spread over a month.
  const day = path.join(home, '.codex', 'sessions', '2026', '10', '01');
  fs.mkdirSync(day, { recursive:true });
  const ids = [];
  for (let i = 0; i < 300; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`; ids.push(id);
    const rows = [JSON.stringify({ type:'session_meta', payload:{ id, cwd:i === 0 ? project : path.join(dir, `p${i % 20}`) } })];
    for (let m = 0; m < 40; m++) rows.push(JSON.stringify({ timestamp:new Date(Date.UTC(2026, 9, 1 + (i % 28), 0, m)).toISOString(), type:'response_item', payload:{ type:'message', role:m % 2 ? 'assistant' : 'user', content:[{ type:m % 2 ? 'output_text' : 'input_text', text:`${m % 2 ? 'Done: I changed' : 'Please change'} the ${['login', 'billing', 'search', 'upload'][m % 4]} flow, step ${m}. ${'Details. '.repeat(30)}` }] } }));
    const file = path.join(day, `rollout-2026-10-01T00-00-00-${id}.jsonl`);
    fs.writeFileSync(file, rows.join('\n') + '\n');
    const t = new Date(Date.UTC(2026, 9, 1 + (i % 28))); fs.utimesSync(file, t, t);
  }
  // A project with a remote and 30 changed files (edits, new files, a deletion).
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding:'utf8' });
  execFileSync('git', ['init', '-q', '--bare', remote]);
  fs.mkdirSync(path.join(project, 'src'), { recursive:true });
  g(project, 'init', '-q', '-b', 'main'); g(project, 'config', 'user.email', 'dev@example.com'); g(project, 'config', 'user.name', 'Dev');
  for (let f = 0; f < 40; f++) fs.writeFileSync(path.join(project, 'src', `module${f}.js`), Array.from({ length:300 }, (_, l) => `export const value${l} = ${l}; // line ${l}`).join('\n') + '\n');
  g(project, 'add', '-A'); g(project, 'commit', '-q', '-m', 'Initial'); g(project, 'remote', 'add', 'origin', remote); g(project, 'push', '-q', '-u', 'origin', 'main');
  for (let f = 0; f < 25; f++) { const file = path.join(project, 'src', `module${f}.js`); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/= (\d)(\d);/g, '= $1$2 * 2;')); }
  for (let f = 0; f < 4; f++) fs.writeFileSync(path.join(project, 'src', `feature${f}.js`), 'export function feature() {\n  return true;\n}\n');
  fs.rmSync(path.join(project, 'src', 'module39.js'));
  // Fake CLIs: codex (ready), gh (pull requests).
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli fixture'; exit 0; fi\nif [ "$1" = "login" ]; then echo 'Logged in'; exit 0; fi\nexit 0\n`);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then if [ -f "${dir}/pr-made" ]; then echo '{"number":7,"url":"https://github.com/o/r/pull/7","state":"OPEN","title":"Double the values","isDraft":false,"reviewDecision":"","headRefName":"main","baseRefName":"main","statusCheckRollup":[{"name":"test","conclusion":"SUCCESS"}]}'; exit 0; fi; echo 'no pull requests found for branch' >&2; exit 1; fi\nif [ "$1" = "pr" ] && [ "$2" = "create" ]; then touch "${dir}/pr-made"; printf '%s\\n' "$@" > "${dir}/pr-args"; echo 'https://github.com/o/r/pull/7'; exit 0; fi\nexit 1\n`);
  for (const name of ['codex', 'gh']) fs.chmodSync(path.join(bin, name), 0o755);
  return { dir, home, bin, project, remote, ids, g };
}

test('everything a phone does stays inside its latency budget', async t => {
  const fx = fixture();
  const port = await freePort(), token = 'latency-secret', base = `http://127.0.0.1:${port}`;
  const started = performance.now();
  const child = spawn(process.execPath, ['server/index.js'], { cwd:path.resolve('.'), env:{ ...process.env, HOME:fx.home, PATH:`${fx.bin}:/usr/bin:/bin`, LAYA_DATA_DIR:path.join(fx.dir, 'data'), LAYA_TOKEN:token, LAYA_PRELOAD:'0', LAYA_HEADLESS_CLAUDE:'1', LAYA_HEADLESS_CODEX:'1', SHED_LAN:'1', SHED_TERMINAL_WORKER:'0', HOST:'127.0.0.1', PORT:String(port) }, stdio:'ignore' });
  const headers = { Authorization:`Bearer ${token}` };
  const results = [];
  try {
    for (let i = 0; i < 200; i++) { try { if ((await fetch(`${base}/api/auth/status`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 15)); }
    results.push({ name:'server start → first answer', once:performance.now() - started });

    const get = async (url, extra = {}) => { const s = performance.now(); const res = await fetch(base + url, { headers:{ ...headers, ...extra } }); const body = await res.text(); return { ms:performance.now() - s, res, body }; };
    async function measure(name, url, extra) {
      await get(url, extra); await get(url, extra); // warm up
      const times = [];
      let last;
      for (let i = 0; i < ROUNDS; i++) { last = await get(url, typeof extra === 'function' ? extra() : extra); times.push(last.ms); }
      results.push({ name, p50:pct(times, 50), p95:pct(times, 95), kb:last.body.length / 1024, status:last.res.status });
      return last;
    }
    const sid = encodeURIComponent(`codex:${fx.ids[0]}`);
    await measure('GET / (page)', '/');
    const app = await measure('GET /app.js', '/app.js');
    const etag = app.res.headers.get('etag');
    assert.ok(etag, 'static files carry an ETag');
    const cached = await measure('GET /app.js (cached, 304)', '/app.js', { 'If-None-Match':etag });
    assert.equal(cached.res.status, 304);
    const list = await measure('GET /api/sessions', '/api/sessions');
    const sessions = JSON.parse(list.body);
    assert.equal(sessions.sessions.length, 300);
    await measure('GET /api/sessions (unchanged)', `/api/sessions?v=${sessions.v}`);
    await measure('GET /api/tasks', '/api/tasks');
    const boot = await measure('GET /api/bootstrap', '/api/bootstrap');
    assert.ok(JSON.parse(boot.body).sessions.length === 300, 'one request brings everything the app needs to open');
    await measure('GET /api/sessions/:id (conversation)', `/api/sessions/${sid}`);
    await measure('GET /api/sessions/:id/files', `/api/sessions/${sid}/files`);
    const ch = await measure('GET /api/sessions/:id/changes', `/api/sessions/${sid}/changes`);
    const state = JSON.parse(ch.body);
    assert.equal(state.files.length, 30);
    await measure('GET /api/sessions/:id/changes (unchanged)', `/api/sessions/${sid}/changes?v=${state.v}`);
    await measure('GET /api/sessions/:id/diff', `/api/sessions/${sid}/diff?path=${encodeURIComponent('src/module3.js')}`);

    const post = async (name, payload) => {
      const s = performance.now();
      const res = await fetch(`${base}/api/sessions/${sid}/git`, { method:'POST', headers:{ ...headers, 'Content-Type':'application/json' }, body:JSON.stringify(payload) });
      const data = await res.json();
      results.push({ name, once:performance.now() - s });
      assert.equal(res.status, 200, data.error);
      return data;
    };
    const committed = await post('commit 30 files', { action:'commit', message:'Double the values' });
    assert.equal(committed.commit.subject, 'Double the values');
    await post('push to remote', { action:'push' });
    assert.match(fx.g(fx.remote, 'log', '-1', '--format=%s', 'main'), /Double the values/);
    const pr = await post('open pull request (gh)', { action:'pr', title:'Double the values' });
    assert.equal(pr.pr.url, 'https://github.com/o/r/pull/7');
    assert.match(fs.readFileSync(path.join(fx.dir, 'pr-args'), 'utf8'), /Done: I changed/, 'the description defaults to the agent\'s last reply');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(fx.dir, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  }

  const rows = results.map(r => r.once !== undefined
    ? `${r.name.padEnd(44)} ${'once'.padStart(8)} ${r.once.toFixed(1).padStart(8)} ms   budget ${ONCE_BUDGET_MS[r.name]} ms`
    : `${r.name.padEnd(44)} p50 ${r.p50.toFixed(1).padStart(6)} p95 ${r.p95.toFixed(1).padStart(6)} ms ${r.kb.toFixed(1).padStart(7)} KB   budget ${BUDGET_MS[r.name]} ms`);
  t.diagnostic(`\n${rows.join('\n')}`);
  if (process.env.SHED_LATENCY_REPORT) fs.writeFileSync(process.env.SHED_LATENCY_REPORT, JSON.stringify(results, null, 2));
  const over = results.filter(r => r.once !== undefined ? r.once > ONCE_BUDGET_MS[r.name] : r.p95 > BUDGET_MS[r.name]);
  assert.deepEqual(over.map(r => `${r.name}: ${(r.once ?? r.p95).toFixed(1)} ms`), [], 'over budget');
});
