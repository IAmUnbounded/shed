import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenFiles, antigravityLiveState, antigravityLivePids, parseAntigravityArgs, antigravityFooterMode, parseTerminalScreen } from '../server/live.js';

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

test('links Antigravity PIDs from --conversation CLI args even without presence lockfiles', () => {
  const argsPids = parseAntigravityArgs([
    '70499 /opt/homebrew/Caskroom/antigravity-cli/1.5.13/antigravity --conversation 36eb1d4b-1683-4f35-934b-bdfa48bcf4cb --model gemini-4-neon-high -i hi',
    '71042 agy --conversation=9dc5d8e4-a069-43c0-85e0-88295f014e07',
    '72000 node something.js --conversation 11111111-1111-1111-1111-111111111111',
  ].join('\n'));
  const processes = new Map([[70499, 'antigravity'], [71042, 'antigravity']]);
  const pids = antigravityLivePids(new Map(), processes, argsPids);
  assert.equal(pids.get('36eb1d4b-1683-4f35-934b-bdfa48bcf4cb'), 70499);
  assert.equal(pids.get('9dc5d8e4-a069-43c0-85e0-88295f014e07'), 71042);
  assert.equal(pids.has('11111111-1111-1111-1111-111111111111'), false);
});

test('classifies Antigravity terminal screens accurately as working, paused/open, or asking', () => {
  const runningScreen = [
    '○ Running (npm test) (ctrl+o to expand)',
    '⣻  Running command...',
    '────────────────────────────────────────────────────────────',
    '>',
    '────────────────────────────────────────────────────────────',
    'esc to cancel                               auto · Gemini 4 Neon · high',
  ].join('\n');
  assert.deepEqual(parseTerminalScreen(runningScreen, 'antigravity'), { asking:false, active:true, mode:'auto' });

  const pausedWithOldSpinner = [
    '○ Running (previous command)',
    'All done! Want me to continue?',
    '────────────────────────────────────────────────────────────',
    '> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)',
    '────────────────────────────────────────────────────────────',
    '? for shortcuts                             auto · Gemini 4 Neon · high',
  ].join('\n');
  assert.deepEqual(parseTerminalScreen(pausedWithOldSpinner, 'antigravity'), { asking:false, active:false, mode:'auto' });

  const askingScreen = [
    'Allow running git push?',
    '  ❯ 1. Yes',
    '    2. No',
    'Enter to confirm · Esc to cancel',
  ].join('\n');
  assert.equal(parseTerminalScreen(askingScreen, 'antigravity').asking, true);
  assert.equal(parseTerminalScreen(askingScreen, 'antigravity').active, false);
});
