import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionMessages } from '../server/sessions.js';

test('Claude tool output and CLI wrappers are not shown as user prompts', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'laya-sessions-')), 'session.jsonl');
  fs.writeFileSync(file, [
    { type:'user', message:{ role:'user', content:'Build the lunar dashboard please' } },
    { type:'assistant', message:{ role:'assistant', content:[{ type:'text', text:'Listing the files first.' }, { type:'tool_use', id:'t1', name:'Bash', input:{} }] } },
    { type:'user', message:{ role:'user', content:[{ type:'tool_result', tool_use_id:'t1', content:'Exit code 1 total 64 drwxr-xr-x' }] } },
    { type:'user', message:{ role:'user', content:'<local-command-stdout>Set model to opus</local-command-stdout>' } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const messages = sessionMessages({ harness:'claude', file });
  assert.deepEqual(messages.map(m => [m.role, m.text]), [['user', 'Build the lunar dashboard please'], ['assistant', 'Listing the files first.']]);
});

test('a message typed into a Claude terminal is tracked through its transcript', async () => {
  const { claudeTerminalProgress } = await import('../server/sessions.js');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'laya-terminal-')), 'session.jsonl');
  const createdAt = '2026-10-06T10:00:00.000Z';
  const rows = [
    { type:'user', timestamp:'2026-10-06T09:00:00.000Z', message:{ content:'Reply with just the word PING.' } },
    { type:'assistant', timestamp:'2026-10-06T09:00:01.000Z', message:{ content:[{ type:'text', text:'PING' }] } },
  ];
  fs.writeFileSync(file, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
  assert.equal(claudeTerminalProgress({ transcriptFile:file, prompt:'Reply with just the word PING.', createdAt }).found, false, 'an earlier identical prompt is not this task');
  rows.push(
    { type:'user', timestamp:'2026-10-06T10:00:02.000Z', message:{ content:'Reply with just the word PING.' } },
    { type:'user', timestamp:'2026-10-06T10:00:03.000Z', message:{ content:[{ type:'tool_result', content:'tool output' }] } },
    { type:'assistant', timestamp:'2026-10-06T10:00:04.000Z', message:{ content:[{ type:'text', text:'PING again' }] } },
  );
  fs.writeFileSync(file, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
  const progress = claudeTerminalProgress({ transcriptFile:file, prompt:'Reply with just the word PING.', createdAt });
  assert.equal(progress.found, true);
  assert.equal(progress.output, 'PING again');
});
