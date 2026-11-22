import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionMessages, discoverAntigravitySessions, antigravityUserText, antigravityTerminalProgress, findAntigravityTranscript } from '../server/sessions.js';

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

test('a typed message is still found after megabytes of image data, and the reply is read as it grows', async () => {
  const { claudeTerminalProgress } = await import('../server/sessions.js');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'laya-terminal-')), 'session.jsonl');
  const earlier = JSON.stringify({ type:'assistant', timestamp:'2026-10-06T09:00:00.000Z', message:{ content:[{ type:'text', text:'old reply' }] } }) + '\n';
  fs.writeFileSync(file, earlier);
  const prompt = 'Look at this video\n\nAttached file (saved on this Mac):\n- /tmp/clip.mp4';
  const task = { id:'big-reply', transcriptFile:file, transcriptOffset:Buffer.byteLength(earlier), agentPrompt:prompt, prompt:'Look at this video', createdAt:'2026-10-06T10:00:00.000Z' };
  // Claude records a multi-line paste wrapped in <pasted_content> tags.
  const row = x => JSON.stringify(x) + '\n';
  fs.appendFileSync(file, row({ type:'user', timestamp:'2026-10-06T10:00:01.000Z', message:{ content:`\n\n<pasted_content id="1d56">\n${prompt}\n</pasted_content id="1d56">\n` } }));
  assert.equal(claudeTerminalProgress(task).found, true);
  // Frames from the video: about 6 MB of image data after the message, half of the last row not yet written.
  const image = row({ type:'user', timestamp:'2026-10-06T10:00:02.000Z', message:{ content:[{ type:'tool_result', content:[{ type:'image', source:{ type:'base64', data:'A'.repeat(6 * 1024 * 1024) } }] }] } });
  const reply = row({ type:'assistant', timestamp:'2026-10-06T10:00:05.000Z', message:{ content:[{ type:'text', text:'I watched the reel.' }] } });
  fs.appendFileSync(file, image + reply.slice(0, 20));
  assert.equal(claudeTerminalProgress(task).output, '');
  fs.appendFileSync(file, reply.slice(20));
  const done = claudeTerminalProgress(task);
  assert.equal(done.found, true);
  assert.equal(done.output, 'I watched the reel.');
});

test('Antigravity sessions are discovered from SQLite summaries, transcripts, and CLI cache while skipping subagents', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-agy-sessions-'));
  const appDir = path.join(root, '.gemini', 'antigravity');
  const cliDir = path.join(root, '.gemini', 'antigravity-cli');
  fs.mkdirSync(appDir, { recursive:true });
  fs.mkdirSync(path.join(cliDir, 'cache'), { recursive:true });
  const dbFile = path.join(appDir, 'conversation_summaries.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, preview text, step_count integer, last_modified_time text, workspace_uris text, status text, parent_conversation_id text, nesting_depth integer);
    CREATE TABLE conversations_fts (conversation_id text, chunk_index integer, user_body text, agent_body text, last_step_created_at integer);
  `);
  const mainId = 'aaaaaaaa-1111-4222-8333-444444444444';
  const legacyId = 'bbbbbbbb-1111-4222-8333-444444444444';
  const subId = 'cccccccc-1111-4222-8333-444444444444';
  const cliId = 'dddddddd-1111-4222-8333-444444444444';
  const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run(mainId, 'Build Space App', 'Build Space App', 4, '2026-11-19 08:00:00+00:00', '["file:///Users/dev/My%20Project"]', 'CASCADE_RUN_STATUS_RUNNING', '', 0);
  insert.run(legacyId, '', 'Legacy History Chat', 6, '2026-11-18 10:00:00+00:00', '["file:///Users/dev/legacy"]', 'CASCADE_RUN_STATUS_IDLE', '', 0);
  insert.run(subId, 'Subagent Task', 'Subagent Task', 3, '2026-11-19 08:01:00+00:00', '["file:///Users/dev/My%20Project"]', 'CASCADE_RUN_STATUS_IDLE', mainId, 1);
  db.prepare('INSERT INTO conversations_fts VALUES (?, ?, ?, ?, ?)').run(legacyId, 0, 'Explain the legacy parser', 'The legacy parser reads chunks in order.', 0);
  db.close();

  const mainLogs = path.join(appDir, 'brain', mainId, '.system_generated', 'logs');
  fs.mkdirSync(mainLogs, { recursive:true });
  fs.writeFileSync(path.join(mainLogs, 'transcript.jsonl'), [
    { step_index:0, source:'USER_EXPLICIT', type:'USER_INPUT', created_at:'2026-11-19T08:00:01Z', content:'<USER_REQUEST>\nAdd launch controls\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>' },
    { step_index:1, source:'MODEL', type:'PLANNER_RESPONSE', created_at:'2026-11-19T08:00:05Z', model:'gemini-4-neon-xhigh', content:'Truncated...', truncated_fields:['content'] },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(mainLogs, 'transcript_full.jsonl'), [
    { step_index:0, source:'USER_EXPLICIT', type:'USER_INPUT', created_at:'2026-11-19T08:00:01Z', content:'<USER_REQUEST>\nAdd launch controls\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>' },
    { step_index:1, source:'MODEL', type:'PLANNER_RESPONSE', created_at:'2026-11-19T08:00:05Z', model:'gemini-4-neon-xhigh', content:'Full untruncated launch controls reply.' },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  // Subagent transcript must still be ignored because conversation_summaries marks it as a child.
  const subLogs = path.join(appDir, 'brain', subId, '.system_generated', 'logs');
  fs.mkdirSync(subLogs, { recursive:true });
  fs.writeFileSync(path.join(subLogs, 'transcript.jsonl'), JSON.stringify({ step_index:0, source:'USER_EXPLICIT', type:'USER_INPUT', created_at:'2026-11-19T08:01:00Z', content:'Subagent prompt' }) + '\n');

  // Standalone CLI session without a DB row recovers its cwd from cache/last_conversations.json.
  fs.writeFileSync(path.join(cliDir, 'cache', 'last_conversations.json'), JSON.stringify({ '/Users/dev/cli-app':cliId }));
  const cliLogs = path.join(cliDir, 'brain', cliId, '.system_generated', 'logs');
  fs.mkdirSync(cliLogs, { recursive:true });
  fs.writeFileSync(path.join(cliLogs, 'transcript.jsonl'), [
    { step_index:0, source:'USER_EXPLICIT', type:'USER_INPUT', created_at:'2026-11-19T07:00:00Z', content:'Fix CLI flag parsing' },
    { step_index:1, source:'MODEL', type:'PLANNER_RESPONSE', created_at:'2026-11-19T07:00:03Z', model:'gemini-4-hydrogen-high', content:'Fixed the flag parser.' },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');

  // CLI DB mirroring the Desktop App row with app_data_dir='antigravity' and empty status must not clobber it.
  const cliDb = new DatabaseSync(path.join(cliDir, 'conversation_summaries.db'));
  cliDb.exec(`CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, preview text, step_count integer, last_modified_time text, workspace_uris text, status text, parent_conversation_id text, nesting_depth integer, app_data_dir text);`);
  cliDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(mainId, 'Build Space App', 'Build Space App', 4, '2026-11-19 08:05:00+00:00', '["file:///Users/dev/My%20Project"]', '', '', 0, 'antigravity');
  cliDb.close();

  try {
    assert.equal(antigravityUserText('<USER_REQUEST>\nHello world\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>'), 'Hello world');
    const found = discoverAntigravitySessions([appDir, cliDir]);
    assert.equal(found.length, 3, 'subagents are excluded');
    const main = found.find(s => s.id === `antigravity:${mainId}`);
    assert.equal(main.cwd, '/Users/dev/My Project');
    assert.equal(main.title, 'Build Space App');
    assert.equal(main.currentModel, 'gemini-4-neon-xhigh');
    assert.equal(main.agStatus, 'CASCADE_RUN_STATUS_RUNNING');
    assert.equal(main.agAppOnly, true, 'Desktop App sessions are marked app-only for CLI resume');
    assert.deepEqual(sessionMessages(main).map(m => [m.role, m.text]), [
      ['user', 'Add launch controls'],
      ['assistant', 'Full untruncated launch controls reply.'],
    ]);

    const legacy = found.find(s => s.id === `antigravity:${legacyId}`);
    assert.equal(legacy.title, 'Legacy History Chat');
    assert.equal(legacy.cwd, '/Users/dev/legacy');
    assert.deepEqual(sessionMessages(legacy).map(m => [m.role, m.text]), [
      ['user', 'Explain the legacy parser'],
      ['assistant', 'The legacy parser reads chunks in order.'],
    ]);

    const cli = found.find(s => s.id === `antigravity:${cliId}`);
    assert.equal(cli.cwd, '/Users/dev/cli-app');
    assert.equal(cli.title, 'Fix CLI flag parsing');
    assert.equal(cli.currentModel, 'gemini-4-hydrogen-high');
    assert.equal(Boolean(cli.agAppOnly), false, 'CLI sessions can resume natively with --conversation');
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
});

test('a message in an Antigravity terminal is found and tracked until its final reply', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-agy-term-'));
  const cliDir = path.join(root, 'antigravity-cli');
  const convId = 'eeeeeeee-1111-4222-8333-444444444444';
  const logs = path.join(cliDir, 'brain', convId, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive:true });
  fs.mkdirSync(path.join(cliDir, 'cache'), { recursive:true });
  fs.writeFileSync(path.join(cliDir, 'cache', 'last_conversations.json'), JSON.stringify({ '/Users/dev/proj':convId }));
  const file = path.join(logs, 'transcript.jsonl');
  const row = x => JSON.stringify(x) + '\n';
  const earlier = row({ step_index:0, source:'USER_EXPLICIT', type:'USER_INPUT', status:'DONE', created_at:'2026-11-20T09:00:00Z', content:'<USER_REQUEST>\nEarlier turn\n</USER_REQUEST>' })
    + row({ step_index:1, source:'MODEL', type:'PLANNER_RESPONSE', status:'DONE', created_at:'2026-11-20T09:00:05Z', content:'Earlier answer' });
  fs.writeFileSync(file, earlier);

  const createdAt = new Date().toISOString();
  const task = { id:'agy-term-1', cwd:'/Users/dev/proj', prompt:'Check the build status', createdAt, transcriptFile:file, transcriptOffset:Buffer.byteLength(earlier) };
  try {
    assert.equal(antigravityTerminalProgress(task).found, false);
    // Turn starts with USER_INPUT + tool call (not final yet).
    fs.appendFileSync(file, row({ step_index:2, source:'USER_EXPLICIT', type:'USER_INPUT', status:'DONE', created_at:new Date(Date.now() + 1000).toISOString(), content:'<USER_REQUEST>\nCheck the build status\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>' }));
    fs.appendFileSync(file, row({ step_index:3, source:'MODEL', type:'PLANNER_RESPONSE', status:'DONE', created_at:new Date(Date.now() + 2000).toISOString(), content:'Running tests now.', tool_calls:[{ name:'run_command' }] }));
    fs.appendFileSync(file, row({ step_index:4, source:'MODEL', type:'GENERIC', status:'DONE', created_at:new Date(Date.now() + 3000).toISOString(), content:'All passed' }));
    const found = findAntigravityTranscript({ cwd:'/Users/dev/proj', prompt:'Check the build status', createdAt }, cliDir);
    assert.deepEqual(found, { file, id:convId });
    const mid = antigravityTerminalProgress(task);
    assert.equal(mid.found, true);
    assert.equal(mid.finalReply, false, 'tool call step is not the final reply');
    // Final reply arrives without tool_calls.
    fs.appendFileSync(file, row({ step_index:5, source:'MODEL', type:'PLANNER_RESPONSE', status:'DONE', created_at:new Date(Date.now() + 4000).toISOString(), content:'Build is green.' }));
    const done = antigravityTerminalProgress(task);
    assert.equal(done.found, true);
    assert.equal(done.finalReply, true);
    assert.match(done.output, /Build is green\./);
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
});
