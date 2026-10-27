import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refusal, depthFor, messagePrompt, exchangeStore, MESSAGE_MARK, MAX_DEPTH } from '../server/exchanges.js';

const a = { id:'claude:a', harness:'claude', cwd:'/p/web', title:'Client', liveState:'open' };
const b = { id:'codex:b', harness:'codex', cwd:'/p/api', title:'Backend', liveState:'working' };

test('lets an open session message another one', () => {
  assert.equal(refusal({ from:a, to:b }), '');
});

test('refuses unknown callers, itself, closed sessions and floods', () => {
  assert.match(refusal({ from:null, to:b }), /could not tell/);
  assert.match(refusal({ from:a, to:a }), /your own/);
  assert.match(refusal({ from:a, to:{ ...b, liveState:'history' } }), /not open/);
  assert.match(refusal({ from:a, to:b, recent:20 }), /last hour/);
});

test('refuses a message that would deadlock or loop', () => {
  // b is waiting on a; a messaging b back would wait on a session that is itself waiting.
  assert.match(refusal({ from:a, to:b, open:[{ from:b.id, to:a.id }] }), /waiting for your answer/);
  assert.match(refusal({ from:a, to:b, open:[{ from:a.id, to:b.id }] }), /already have a message/);
  const chain = [{ from:'x', to:a.id, depth:MAX_DEPTH - 1 }];
  assert.equal(depthFor(a.id, chain), MAX_DEPTH);
  assert.match(refusal({ from:a, to:b, open:chain }), /passes through/);
});

test('the delivered message names the sender and how to answer', () => {
  const text = messagePrompt(a, 'Which port does the API use?', '/x/bin/shed');
  assert.ok(text.startsWith(`${MESSAGE_MARK}. It is the Claude session working on web`));
  assert.match(text, /Which port does the API use\?/);
  assert.match(text, /\/x\/bin\/shed ask claude:a/);
});

test('an exchange follows its task to the answer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-ex-'));
  const store = exchangeStore(dir);
  store.add({ id:'e1', kind:'ask', from:a.id, to:b.id, message:'hi', taskId:'t1', status:'sending', createdAt:new Date().toISOString() });
  const task = { id:'t1', status:'running' };
  assert.equal(store.sync(() => task), true);
  assert.equal(store.get('e1').status, 'waiting');
  Object.assign(task, { status:'completed', output:'Port 4378.', updatedAt:'2026-10-26T10:00:00Z' });
  store.sync(() => task);
  assert.equal(store.get('e1').status, 'answered');
  assert.equal(store.get('e1').reply, 'Port 4378.');
  assert.equal(exchangeStore(dir).get('e1').reply, 'Port 4378.'); // saved
  assert.equal(store.open().length, 0);
  fs.rmSync(dir, { recursive:true, force:true });
});
