import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stopAgent } from '../server/terminal.js';

// A fake agent: node started through a symlink named "claude" (so ps reports it as claude), leading its own
// process group like an agent in a Terminal tab.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-stop-'));
const fakeClaude = path.join(dir, 'claude');
fs.symlinkSync(process.execPath, fakeClaude);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function agent(code) {
  const child = spawn(fakeClaude, ['-e', code], { detached:true, stdio:['ignore', 'pipe', 'ignore'] });
  child.unref();
  return child;
}
const firstLine = child => new Promise((resolve, reject) => { child.stdout.once('data', d => resolve(String(d).trim())); child.once('exit', code => reject(new Error(`fake agent exited (${code})`))); });
test.after(() => fs.rmSync(dir, { recursive:true, force:true }));

test('ends the agent and the tool command it is running', async () => {
  const child = agent("const c = require('child_process').spawn('sleep', ['300'], { stdio:'ignore' }); console.log(c.pid); setInterval(() => {}, 1000)");
  const toolPid = Number(await firstLine(child));
  assert.ok(alive(child.pid) && alive(toolPid));
  const result = await stopAgent(child.pid, 'claude');
  assert.deepEqual(result, { stopped:true, forced:false });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(alive(toolPid), false);
});

test('force-stops an agent that ignores SIGTERM', async () => {
  const child = agent("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)");
  await firstLine(child);
  const result = await stopAgent(child.pid, 'claude', { graceMs:500 });
  assert.deepEqual(result, { stopped:true, forced:true });
});

test('never signals a process that is not the named agent', async () => {
  const child = agent("console.log('ready'); setInterval(() => {}, 1000)");
  await firstLine(child);
  assert.deepEqual(await stopAgent(child.pid, 'codex'), { stopped:false, reason:'not-running' });
  assert.ok(alive(child.pid));
  process.kill(-child.pid, 'SIGKILL');
});
