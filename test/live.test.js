import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenFiles, antigravityLiveState, antigravityLivePids, antigravityFooterMode } from '../server/live.js';

test('links open transcript files to their owning agent processes', () => {
  const files = parseOpenFiles('p101\nn/tmp/first.jsonl\np202\nn/tmp/second.jsonl\n');
  assert.equal(files.get('/tmp/first.jsonl'), 101);
  assert.equal(files.get('/tmp/second.jsonl'), 202);
});

test('maps recent Antigravity DB statuses to live states only while Antigravity is running', () => {
  const now = Date.parse('2026-11-19T08:10:00Z');
  const recent = '2026-11-19T08:08:00Z';
  const stale = '2026-11-19T07:00:00Z';
  assert.equal(antigravityLiveState({ agStatus:'CASCADE_RUN_STATUS_RUNNING', updatedAt:recent }, true, now), 'working');
  assert.equal(antigravityLiveState({ agStatus:'CASCADE_RUN_STATUS_WAITING_FOR_USER', updatedAt:recent }, true, now), 'asking');
  assert.equal(antigravityLiveState({ agStatus:'CASCADE_RUN_STATUS_IDLE', updatedAt:recent }, true, now), '');
  assert.equal(antigravityLiveState({ agStatus:'CASCADE_RUN_STATUS_RUNNING', updatedAt:stale }, true, now), '');
  assert.equal(antigravityLiveState({ agStatus:'CASCADE_RUN_STATUS_RUNNING', updatedAt:recent }, false, now), '');
});

test('links live Antigravity CLI PIDs via presence lockfiles and conversation DBs', () => {
  const files = parseOpenFiles([
    'p401',
    'n/Users/dev/.gemini/antigravity-cli/conversations/conv-a.db',
    'n/Users/dev/.gemini/antigravity-cli/presence/conv-a.lock',
    'p402',
    'n/Users/dev/.gemini/antigravity-cli/conversations/conv-b.db',
    'p403',
    'n/Users/dev/.gemini/antigravity-cli/presence/conv-c.lock',
  ].join('\n'));
  const processes = new Map([[401, 'antigravity'], [402, 'antigravity'], [403, 'claude']]);
  const pids = antigravityLivePids(files, processes);
  assert.equal(pids.get('conv-a'), 401);
  assert.equal(pids.get('conv-b'), 402);
  assert.equal(pids.has('conv-c'), false);
  assert.equal(antigravityFooterMode('some output\n auto · Gemini 4 Neon · high\n'), 'auto');
  assert.equal(antigravityFooterMode('some output\n plan · Gemini 4 Neon · high\n'), 'plan');
  assert.equal(antigravityFooterMode('some output\n accept-edits · Gemini 4 Neon · high\n'), 'edits');
});
