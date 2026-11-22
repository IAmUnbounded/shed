import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { liveSessionStates } from './live.js';

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}

const home = os.homedir();
const roots = {
  codex: path.join(home, '.codex', 'sessions'),
  claude: path.join(home, '.claude', 'projects'),
  gemini: path.join(home, '.gemini', 'tmp'),
  pi: path.join(home, '.pi', 'agent', 'sessions'),
  antigravity: [
    path.join(home, '.gemini', 'antigravity'),
    path.join(home, '.gemini', 'antigravity-cli'),
  ],
};

function walk(dir, accept, maxDepth = 5, depth = 0, out = []) {
  if (depth > maxDepth) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, accept, maxDepth, depth + 1, out);
    else if (entry.isFile() && accept(full)) out.push(full);
  }
  return out;
}

function sliceFile(file, bytes, fromEnd = false) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = fromEnd ? Math.max(0, size - bytes) : 0;
    const buffer = Buffer.alloc(Math.min(bytes, size));
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (fromEnd && start > 0) text = text.slice(text.indexOf('\n') + 1);
    if (!fromEnd && size > bytes) text = text.slice(0, text.lastIndexOf('\n'));
    return text;
  } finally { fs.closeSync(fd); }
}

function jsonLines(text) {
  return text.split('\n').flatMap(line => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

// For showing a message: unlike clean(), keeps line breaks so Markdown (lists, code, headings) survives;
// drops only the harness-injected blocks a person never wrote or reads.
function displayText(text, limit = 12000) {
  return String(text || '')
    .replace(/<(environment_context|system-reminder|oai-mem-citation)>[\s\S]*?<\/\1>/g, '')
    .replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
}

function clean(text, limit = 220) {
  return String(text || '').replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // Claude records tool output as user-role tool_result blocks; that is not something the user typed.
  return content.filter(c => c?.type !== 'tool_result').map(c => typeof c === 'string' ? c : c.text || c.content || '').filter(x => typeof x === 'string' && x).join('\n\n');
}

function isUsefulPrompt(text) {
  const value = clean(text, 1000);
  // Claude Code writes slash commands, their output and system reminders as user rows; check the raw text since clean() strips the tags.
  if (/^\s*<(command-name|command-message|local-command-stdout|local-command-caveat|system-reminder)>/i.test(String(text || ''))) return false;
  return value.length > 8 && !/^(# AGENTS\.md instructions|<environment_context>|<permissions instructions>|You are Codex,)/i.test(value);
}

// Transcripts record the model on each turn; the last one in the tail is what a resume will continue with.
function lastModel(text) {
  const found = [...text.matchAll(/"model"\s*:\s*"([^"<]{1,100})"/g)].map(match => match[1]);
  return found.at(-1) || '';
}

// How freely the agent acts, as the transcript last recorded it: 'skip' (never asks), 'auto', 'edits' (accepts
// edits), 'plan', 'ask' (asks first), or '' when unknown. Claude records its mode on each message; Codex its
// approval and sandbox policy on each turn.
const CLAUDE_MODES = { bypassPermissions:'skip', auto:'auto', acceptEdits:'edits', plan:'plan', default:'ask', dontAsk:'skip' };
export function claudePermissions(text) {
  const mode = [...text.matchAll(/"permissionMode"\s*:\s*"(\w+)"/g)].at(-1)?.[1];
  return CLAUDE_MODES[mode] || '';
}
export function codexPermissions(text) {
  const approval = [...text.matchAll(/"approval_policy"\s*:\s*"([\w-]+)"/g)].at(-1)?.[1];
  const sandbox = [...text.matchAll(/"sandbox_policy"\s*:\s*\{\s*"type"\s*:\s*"([\w-]+)"/g)].at(-1)?.[1];
  if (!approval) return '';
  return approval === 'never' && sandbox === 'danger-full-access' ? 'skip' : 'ask';
}

// When the conversation last moved: the newest timestamped row in the tail. Claude Code appends bookkeeping rows when a
// session closes, which touches the file, so the file's time says when it was closed rather than when anyone spoke.
function lastActivity(rows, stat, isMessage = () => true) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!isMessage(rows[i])) continue;
    const at = Date.parse(rows[i].timestamp || rows[i].created_at);
    if (at) return new Date(Math.min(at, stat.mtimeMs)).toISOString();
  }
  return stat.mtime.toISOString();
}

// Whether the agent ever answered. Only the start and end of a transcript are read, so a long one whose answers sit in
// the unread middle (Claude logs big request blobs) counts as answered: "never answered" is only said of a file read whole.
const HEAD_BYTES = 256 * 1024;
function answeredIn(rows, stat, isAnswer) { return stat.size > HEAD_BYTES || rows.some(isAnswer); }

function codexRecord(file) {
  const stat = fs.statSync(file);
  const lines = jsonLines(sliceFile(file, HEAD_BYTES));
  const meta = lines.find(x => x.type === 'session_meta')?.payload || {};
  const prompts = lines.filter(x => x.type === 'response_item' && x.payload?.type === 'message' && x.payload.role === 'user')
    .map(x => contentText(x.payload.content)).filter(isUsefulPrompt);
  const title = clean(prompts.find(x => !x.includes('AGENTS.md')) || prompts[0] || path.basename(meta.cwd || '', '/'));
  const tail = sliceFile(file, 128 * 1024, true), tailRows = jsonLines(tail);
  const recent = tailRows.filter(x => x.type === 'response_item' && x.payload?.type === 'message' && x.payload.role === 'user').map(x => contentText(x.payload.content)).filter(isUsefulPrompt);
  const answered = x => (x.type === 'response_item' && x.payload?.type === 'message' && x.payload.role === 'assistant') || (x.type === 'event_msg' && x.payload?.type === 'agent_message');
  const id = path.basename(file).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/)?.[1] || meta.id || meta.session_id;
  if (!id) return null;
  return { id: `codex:${id}`, nativeId: id, harness: 'codex', title: title || 'Untitled Codex session', lastPrompt: clean(recent.at(-1), 260), cwd: meta.cwd || '', currentModel: lastModel(tail), permissions: codexPermissions(tail), updatedAt: lastActivity(tailRows, stat), replied: answeredIn(lines, stat, answered), file, source: 'desktop' };
}

function claudeRecord(file) {
  const stat = fs.statSync(file);
  const lines = jsonLines(sliceFile(file, HEAD_BYTES));
  const first = lines.find(x => x.type === 'user' && !x.isSidechain && isUsefulPrompt(contentText(x.message?.content)));
  const title = clean(contentText(first?.message?.content));
  const tail = sliceFile(file, 128 * 1024, true), tailRows = jsonLines(tail);
  const recent = tailRows.filter(x => x.type === 'user' && !x.isSidechain).map(x => contentText(x.message?.content)).filter(isUsefulPrompt);
  const id = first?.sessionId || path.basename(file, '.jsonl');
  const answered = x => x.type === 'assistant' && !x.isSidechain;
  return { id: `claude:${id}`, nativeId: id, harness: 'claude', title: title || 'Untitled Claude session', lastPrompt: clean(recent.at(-1), 260), cwd: first?.cwd || '', currentModel: lastModel(tail), permissions: claudePermissions(tail), updatedAt: lastActivity(tailRows, stat, x => x.type === 'user' || x.type === 'assistant'), replied: answeredIn(lines, stat, answered), file, source: 'desktop' };
}

function geminiRecord(file) {
  const stat = fs.statSync(file);
  if (stat.size > 8 * 1024 * 1024) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const first = messages.find(x => x.type === 'user' || x.role === 'user');
  const last = messages.filter(x => x.type === 'user' || x.role === 'user').at(-1);
  const title = clean(first?.content || first?.text || first?.message);
  const id = data.sessionId || path.basename(file, '.json');
  return { id: `gemini:${id}`, nativeId: id, harness: 'gemini', title: title || 'Untitled Gemini session', lastPrompt: clean(last?.content || last?.text || last?.message, 260), cwd: data.cwd || '', currentModel: [...messages].reverse().find(x => typeof x.model === 'string')?.model || '', updatedAt: data.lastUpdated || stat.mtime.toISOString(), replied: messages.some(x => x !== first && !(x.type === 'user' || x.role === 'user')), file, source: 'desktop' };
}

function piRecord(file) {
  const stat = fs.statSync(file);
  const lines = jsonLines(sliceFile(file, HEAD_BYTES));
  const meta = lines.find(x => x.type === 'session') || {};
  const prompts = lines.filter(x => x.type === 'message' && x.message?.role === 'user').map(x => contentText(x.message.content)).filter(isUsefulPrompt);
  const tail = sliceFile(file, 128 * 1024, true), tailRows = jsonLines(tail);
  const recent = tailRows.filter(x => x.type === 'message' && x.message?.role === 'user').map(x => contentText(x.message.content)).filter(isUsefulPrompt);
  const id = meta.id || path.basename(file, '.jsonl').match(/[0-9a-f]{8}-[0-9a-f-]{27,}/)?.[0];
  if (!id) return null;
  return { id:`pi:${id}`, nativeId:id, harness:'pi', title:clean(prompts[0]) || 'Untitled Pi session', lastPrompt:clean(recent.at(-1), 260), cwd:meta.cwd || '', currentModel:lastModel(tail), updatedAt:lastActivity(tailRows, stat), replied:answeredIn(lines, stat, x => x.type === 'message' && x.message?.role === 'assistant'), file, source:'desktop' };
}

// Asking the OpenCode CLI for its sessions takes about half a second, so its list is reused for a minute.
let opencodeCache = { at:0, rows:[] };
function opencodeCached() {
  if (Date.now() - opencodeCache.at > 60000) opencodeCache = { at:Date.now(), rows:opencodeRecords() };
  return opencodeCache.rows;
}
function opencodeRecords() {
  const result = spawnSync('opencode', ['session', 'list', '--format', 'json'], { encoding:'utf8', timeout:5000, maxBuffer:4 * 1024 * 1024 });
  if (result.status !== 0) return [];
  let rows;
  try { rows = JSON.parse(result.stdout); } catch { return []; }
  if (!Array.isArray(rows)) rows = rows.sessions;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(row => {
    const id = row.id || row.sessionId;
    if (!id) return [];
    const updated = row.time?.updated || row.updatedAt || row.updated;
    return [{ id:`opencode:${id}`, nativeId:id, harness:'opencode', title:clean(row.title || row.name) || 'Untitled OpenCode session', lastPrompt:'', cwd:row.directory || row.cwd || '', updatedAt:typeof updated === 'number' ? new Date(updated).toISOString() : updated || new Date().toISOString(), file:null, source:'desktop' }];
  });
}

// Antigravity stores session metadata in conversation_summaries.db and step transcripts in
// brain/<conversation-id>/.system_generated/logs/transcript.jsonl under ~/.gemini/antigravity (Desktop App)
// and ~/.gemini/antigravity-cli (CLI). Both are scanned and merged by conversation ID.
export function antigravityUserText(raw) {
  const text = String(raw || '');
  const req = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (req) return req[1].trim();
  return text.replace(/<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE|ACTIVE_DOCUMENT|USER_INFORMATION)>[\s\S]*?<\/\1>/g, '').trim();
}
function parseTimestamp(value, fallbackMs = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const at = Date.parse(value.trim().replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/, '$1T$2'));
    if (Number.isFinite(at) && at > 0) return new Date(at).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}
function firstWorkspacePath(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try { const value = JSON.parse(raw); list = Array.isArray(value) ? value : [value]; }
    catch { list = [raw.trim()]; }
  }
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) continue;
    if (item.startsWith('file://')) { try { return fileURLToPath(item); } catch {} }
    if (item.startsWith('/')) return item;
  }
  return '';
}
function querySqlite(dbFile, sql, params = []) {
  if (DatabaseSync) {
    let db;
    try {
      db = new DatabaseSync(dbFile, { readOnly:true });
      return db.prepare(sql).all(...params);
    } catch { return []; }
    finally { try { db?.close(); } catch {} }
  }
  const bound = sql.replace(/\?/g, () => `'${String(params.shift() ?? '').replace(/'/g, "''")}'`);
  const result = spawnSync('/usr/bin/sqlite3', ['-readonly', '-json', dbFile, bound], { encoding:'utf8', timeout:5000, maxBuffer:6 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try { return JSON.parse(result.stdout); } catch { return []; }
}
const antigravityDbCache = new Map();
function antigravitySummaryData(dbFile) {
  let stat;
  try { stat = fs.statSync(dbFile); } catch { return { rows:[], subagents:new Set() }; }
  let walKey = '';
  try { const wal = fs.statSync(`${dbFile}-wal`); walKey = `:${wal.mtimeMs}:${wal.size}`; } catch {}
  const key = `${stat.mtimeMs}:${stat.size}${walKey}`;
  const hit = antigravityDbCache.get(dbFile);
  if (hit && hit.key === key) return hit.data;
  const cols = querySqlite(dbFile, 'PRAGMA table_info(conversation_summaries)').map(c => c.name);
  const appCol = cols.includes('app_data_dir') ? ', app_data_dir' : '';
  const all = querySqlite(dbFile, `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, parent_conversation_id, nesting_depth${appCol} FROM conversation_summaries`);
  const rows = [], subagents = new Set();
  for (const row of all) {
    if (!row.conversation_id) continue;
    if (row.parent_conversation_id || Number(row.nesting_depth) > 0) subagents.add(row.conversation_id);
    else rows.push(row);
  }
  const data = { rows, subagents };
  antigravityDbCache.set(dbFile, { key, data });
  return data;
}
function antigravityLastConversations(dir) {
  const map = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'cache', 'last_conversations.json'), 'utf8'));
    if (raw && typeof raw === 'object') for (const [cwd, id] of Object.entries(raw)) if (typeof id === 'string' && cwd.startsWith('/')) map.set(id, cwd);
  } catch {}
  return map;
}
function antigravityTranscriptRecord(file) {
  const stat = fs.statSync(file);
  const id = file.match(/[/\\]brain[/\\]([^/\\]+)[/\\]\.system_generated[/\\]logs[/\\]transcript\.jsonl$/)?.[1] || path.basename(path.dirname(path.dirname(path.dirname(file))));
  if (!id) return null;
  const lines = jsonLines(sliceFile(file, HEAD_BYTES));
  const prompts = lines.filter(x => x.type === 'USER_INPUT' && x.source !== 'SYSTEM').map(x => antigravityUserText(x.content)).filter(text => clean(text).length > 0);
  const tail = sliceFile(file, 128 * 1024, true), tailRows = jsonLines(tail);
  const recent = tailRows.filter(x => x.type === 'USER_INPUT' && x.source !== 'SYSTEM').map(x => antigravityUserText(x.content)).filter(text => clean(text).length > 0);
  const model = [...tailRows].reverse().find(x => x.type === 'PLANNER_RESPONSE' && typeof x.model === 'string' && x.model)?.model || lastModel(tail);
  const cwd = lines.find(x => typeof x.cwd === 'string' && x.cwd)?.cwd || '';
  const answered = x => x.type === 'PLANNER_RESPONSE' && (!x.source || x.source === 'MODEL') && Boolean(x.content);
  return {
    id:`antigravity:${id}`, nativeId:id, harness:'antigravity',
    title:clean(prompts[0]) || (cwd ? path.basename(cwd) : '') || 'Untitled Antigravity session',
    lastPrompt:clean(recent.at(-1), 260), cwd, currentModel:model,
    updatedAt:lastActivity(tailRows, stat, x => x.type === 'USER_INPUT' || x.type === 'PLANNER_RESPONSE'),
    replied:answeredIn(lines, stat, answered), file, source:'desktop',
  };
}
export function discoverAntigravitySessions(dirs = roots.antigravity) {
  const byId = new Map();
  const subagents = new Set();
  const cliDir = dirs.find(d => path.basename(d) === 'antigravity-cli') || '';
  const hasCliTrajectory = id => Boolean(cliDir && (fs.existsSync(path.join(cliDir, 'conversations', `${id}.db`)) || fs.existsSync(path.join(cliDir, 'conversations', `${id}.pb`))));
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const dirName = path.basename(dir);
    const isCliDir = dirName === 'antigravity-cli';
    const lastCwd = antigravityLastConversations(dir);
    const dbFile = path.join(dir, 'conversation_summaries.db');
    const summary = antigravitySummaryData(dbFile);
    for (const sid of summary.subagents) subagents.add(sid);
    for (const row of summary.rows) {
      // agy mirrors Antigravity App rows into its own DB with app_data_dir='antigravity' and empty status; skip mirrored copies.
      if (row.app_data_dir && row.app_data_dir !== dirName) continue;
      const id = row.conversation_id;
      const transcriptFile = path.join(dir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
      let tx = null;
      if (fs.existsSync(transcriptFile)) {
        try { tx = parseCached(transcriptFile, antigravityTranscriptRecord); } catch {}
      }
      const cwd = firstWorkspacePath(row.workspace_uris) || lastCwd.get(id) || tx?.cwd || '';
      const dbTime = parseTimestamp(row.last_modified_time);
      const updatedAt = tx && Date.parse(tx.updatedAt) > Date.parse(dbTime) ? tx.updatedAt : dbTime;
      const title = clean(row.title || row.preview) || (tx && !tx.title.startsWith('Untitled ') ? tx.title : '') || (cwd ? path.basename(cwd) : '') || 'Untitled Antigravity session';
      const cliResumable = isCliDir || hasCliTrajectory(id);
      const item = {
        id:`antigravity:${id}`, nativeId:id, harness:'antigravity', title,
        lastPrompt:tx?.lastPrompt || clean(row.preview, 260), cwd,
        currentModel:tx?.currentModel || '', updatedAt,
        replied:Boolean(tx?.replied) || Number(row.step_count) > 1,
        file:tx ? transcriptFile : null, dbFile, agStatus:row.status || '',
        ...(cliResumable ? {} : { agAppOnly:true }), source:'desktop',
      };
      const prev = byId.get(id);
      if (!prev || (cliResumable && prev.agAppOnly) || Date.parse(item.updatedAt) > Date.parse(prev.updatedAt) || (item.file && !prev.file)) byId.set(id, item);
    }
    const brainDir = path.join(dir, 'brain');
    let entries = [];
    try { entries = fs.readdirSync(brainDir, { withFileTypes:true }); } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory() || byId.has(entry.name) || subagents.has(entry.name)) continue;
      const transcriptFile = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(transcriptFile)) continue;
      try {
        const tx = parseCached(transcriptFile, antigravityTranscriptRecord);
        if (!tx) continue;
        const cwd = tx.cwd || lastCwd.get(tx.nativeId) || '';
        const cliResumable = isCliDir || hasCliTrajectory(tx.nativeId);
        byId.set(tx.nativeId, { ...tx, cwd, title:tx.title.startsWith('Untitled ') && cwd ? path.basename(cwd) : tx.title, ...(cliResumable ? {} : { agAppOnly:true }) });
      } catch { /* Ignore incomplete live files. */ }
    }
  }
  return [...byId.values()];
}

// Parsing a transcript reads up to 384 KB of it, and there are hundreds; reuse the result until the file changes.
const parsed = new Map();
function parseCached(file, parse) {
  const stat = fs.statSync(file);
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = parsed.get(file);
  if (hit && hit.key === key) return hit.item;
  const item = parse(file);
  parsed.set(file, { key, item });
  return item;
}

export function discoverSessions() {
  const inputs = [
    ...walk(roots.codex, f => f.endsWith('.jsonl'), 5).map(file => [file, codexRecord]),
    ...walk(roots.claude, f => f.endsWith('.jsonl') && !f.includes('/subagents/'), 3).map(file => [file, claudeRecord]),
    ...walk(roots.gemini, f => f.endsWith('.json') && f.includes('/chats/'), 4).map(file => [file, geminiRecord]),
    ...walk(roots.pi, f => f.endsWith('.jsonl'), 3).map(file => [file, piRecord]),
  ];
  const sessions = [];
  for (const [file, parse] of inputs) {
    try { const item = parseCached(file, parse); if (item) sessions.push(item); } catch { /* Ignore incomplete live files. */ }
  }
  try { sessions.push(...discoverAntigravitySessions()); } catch {}
  try { sessions.push(...opencodeCached()); } catch {}
  const live = liveSessionStates(sessions);
  return sessions.filter(session => !(session.title.startsWith('Untitled ') && !session.cwd))
    .map(session => ({ ...session, liveState:live.get(session.id)?.liveState || 'history', tty:live.get(session.id)?.tty || '', permissions:live.get(session.id)?.permissions || session.permissions || '' }))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function sessionMessages(session) {
  const file = session.file;
  if (session.harness === 'opencode') {
    const result = spawnSync('opencode', ['export', session.nativeId], { encoding:'utf8', timeout:5000, maxBuffer:6 * 1024 * 1024 });
    if (result.status !== 0) return [];
    try {
      const data = JSON.parse(result.stdout);
      return (data.messages || []).map(x => ({ role:x.role || x.info?.role || 'assistant', text:displayText(x.content || x.text || x.parts?.map(p => p.text).join('\n')), at:x.timestamp || x.time?.created })).filter(x => x.text).slice(-60);
    } catch { return []; }
  }
  if (session.harness === 'antigravity') {
    if (file && fs.existsSync(file)) {
      const fullFile = path.join(path.dirname(file), 'transcript_full.jsonl');
      let source = file;
      try { if (fs.existsSync(fullFile) && fs.statSync(fullFile).size <= 8 * 1024 * 1024) source = fullFile; } catch {}
      const rows = jsonLines(sliceFile(source, 2 * 1024 * 1024, true));
      const messages = [];
      for (const row of rows) {
        if (row.type === 'USER_INPUT' && row.source !== 'SYSTEM') {
          const text = displayText(antigravityUserText(row.content));
          if (text) messages.push({ role:'user', text, at:row.created_at });
        } else if (row.type === 'PLANNER_RESPONSE' && (!row.source || row.source === 'MODEL') && row.content) {
          const text = displayText(row.content);
          if (text) messages.push({ role:'assistant', text, at:row.created_at });
        }
      }
      return messages.slice(-60);
    }
    if (session.dbFile && fs.existsSync(session.dbFile)) {
      const chunks = querySqlite(session.dbFile, 'SELECT chunk_index, user_body, agent_body, last_step_created_at FROM conversations_fts WHERE conversation_id = ? AND chunk_index >= 0 ORDER BY chunk_index ASC', [session.nativeId]);
      const messages = [];
      for (const chunk of chunks) {
        const at = Number(chunk.last_step_created_at) > 0 ? parseTimestamp(Number(chunk.last_step_created_at)) : undefined;
        const user = displayText(antigravityUserText(chunk.user_body));
        if (user) messages.push({ role:'user', text:user, at });
        const agent = displayText(chunk.agent_body);
        if (agent) messages.push({ role:'assistant', text:agent, at });
      }
      return messages.slice(-60);
    }
    return [];
  }
  if (!file || !fs.existsSync(file)) return [];
  if (session.harness === 'gemini') {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (data.messages || []).map(x => ({ role: x.type === 'user' || x.role === 'user' ? 'user' : 'assistant', text: displayText(x.content || x.text || x.message), at: x.timestamp || x.time })).filter(x => x.text).slice(-60);
  }
  const rows = jsonLines(sliceFile(file, 2 * 1024 * 1024, true));
  const messages = [];
  for (const row of rows) {
    if (session.harness === 'codex' && row.type === 'response_item' && row.payload?.type === 'message' && ['user', 'assistant'].includes(row.payload.role)) {
      const text = displayText(contentText(row.payload.content));
      if (text && !(row.payload.role === 'user' && !isUsefulPrompt(text))) messages.push({ role: row.payload.role, text, at: row.timestamp });
    }
    if (session.harness === 'claude' && ['user', 'assistant'].includes(row.type) && !row.isSidechain) {
      const raw = contentText(row.message?.content), text = displayText(raw);
      if (text && !(row.type === 'user' && !isUsefulPrompt(raw))) messages.push({ role: row.type, text, at: row.timestamp });
    }
    if (session.harness === 'pi' && row.type === 'message' && ['user', 'assistant'].includes(row.message?.role)) {
      const text = displayText(contentText(row.message.content));
      if (text) messages.push({ role:row.message.role, text, at:row.timestamp });
    }
  }
  return messages.slice(-60);
}

export function codexQueuedProgress(task) {
  if (task.harness !== 'codex' || !task.transcriptFile || !fs.existsSync(task.transcriptFile)) return null;
  const rows = jsonLines(sliceFile(task.transcriptFile, 4 * 1024 * 1024, true));
  // Prefix match: a typed or handed-off prompt can be long, and Codex may trim trailing whitespace.
  const expected = clean(task.agentPrompt || task.prompt, 20000).slice(0, 80);
  let found = false;
  let working = false;
  let completed = false;
  const output = [];
  for (const row of rows) {
    if (!found) {
      if (row.type !== 'response_item' || row.payload?.type !== 'message' || row.payload.role !== 'user') continue;
      if (Date.parse(row.timestamp || '') < Date.parse(task.createdAt) - 2000) continue;
      found = clean(contentText(row.payload.content), 20000).startsWith(expected);
      continue;
    }
    if (row.type === 'event_msg' && row.payload?.type === 'task_started') working = true;
    if (row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'assistant') {
      const message = displayText(contentText(row.payload.content));
      if (message) output.push(message);
    }
    if (row.type === 'event_msg' && row.payload?.type === 'task_complete') { completed = true; break; }
    if (row.type === 'event_msg' && row.payload?.type === 'turn_aborted') return { status:'failed', output:output.join('\n\n'), error:'The Codex turn was interrupted.' };
  }
  return found ? { status:completed ? 'completed' : 'running', output:output.join('\n\n'), working } : null;
}

export function publicSession(session) {
  const { file, nativeId, dbFile, agStatus, ...safe } = session;
  return safe;
}

// A message typed into a Claude terminal shows up in its transcript; the reply is every assistant message after it.
// The transcript is read forward from where it ended when the message was typed (task.transcriptOffset), a little
// more each time. Reading only its tail is not enough: a reply that looks at images or video frames writes megabytes
// of image data after the message, which would push the message out of any fixed-size tail.
const scans = new Map(); // task id -> { file, offset, rest, foundAt, output }
const CHUNK = 8 * 1024 * 1024;
export function claudeTerminalProgress(task) {
  if (!task.transcriptFile || !fs.existsSync(task.transcriptFile)) return { found:false, output:'' };
  const expected = clean(task.agentPrompt || task.prompt, 20000).slice(0, 80);
  const key = task.id || `${task.transcriptFile}|${task.createdAt}|${expected}`;
  let scan = scans.get(key);
  if (!scan || scan.file !== task.transcriptFile) {
    scan = { file:task.transcriptFile, offset:Math.max(0, Number(task.transcriptOffset) || 0), rest:Buffer.alloc(0), foundAt:null, output:[] };
    scans.set(key, scan);
    if (scans.size > 100) scans.delete(scans.keys().next().value);
  }
  const fd = fs.openSync(scan.file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < scan.offset) Object.assign(scan, { offset:0, rest:Buffer.alloc(0), foundAt:null, output:[] }); // rewritten
    while (scan.offset < size) {
      const buffer = Buffer.alloc(Math.min(CHUNK, size - scan.offset));
      const read = fs.readSync(fd, buffer, 0, buffer.length, scan.offset);
      if (!read) break;
      scan.offset += read;
      // Only whole lines are parsed; a line still being written waits for the next call.
      const data = Buffer.concat([scan.rest, buffer.subarray(0, read)]);
      const end = data.lastIndexOf(10);
      scan.rest = end < 0 ? data : data.subarray(end + 1);
      if (end < 0) continue;
      for (const row of jsonLines(data.subarray(0, end).toString('utf8'))) {
        if (row.isSidechain) continue;
        if (!scan.foundAt) {
          if (row.type !== 'user' || Date.parse(row.timestamp || '') < Date.parse(task.createdAt) - 5000) continue;
          const raw = contentText(row.message?.content);
          if (isUsefulPrompt(raw) && clean(raw, 20000).startsWith(expected)) scan.foundAt = Date.parse(row.timestamp);
          continue;
        }
        if (row.type === 'assistant') {
          const message = displayText(contentText(row.message?.content));
          if (message) scan.output.push(message);
        }
      }
    }
  } finally { fs.closeSync(fd); }
  return { found:Boolean(scan.foundAt), foundAt:scan.foundAt, output:scan.output.join('\n\n') };
}

// Codex writes transcripts through its background service, so a session started in a new Terminal window is found
// by its transcript: created after the task, in the task's folder, opening with the task's prompt.
export function findCodexTranscript(task) {
  const since = Date.parse(task.createdAt) - 5000;
  const expected = clean(task.agentPrompt || task.prompt, 20000).slice(0, 80);
  const recent = walk(roots.codex, f => f.endsWith('.jsonl'), 5)
    .map(file => { try { return { file, mtime:fs.statSync(file).mtimeMs, birth:fs.statSync(file).birthtimeMs }; } catch { return null; } })
    .filter(x => x && x.birth >= since)
    .sort((a, b) => b.birth - a.birth);
  for (const { file } of recent) {
    const rows = jsonLines(sliceFile(file, 512 * 1024));
    const meta = rows.find(x => x.type === 'session_meta')?.payload || {};
    if (task.cwd && meta.cwd && path.resolve(meta.cwd) !== path.resolve(task.cwd)) continue;
    const opened = rows.some(x => x.type === 'response_item' && x.payload?.type === 'message' && x.payload.role === 'user' && clean(contentText(x.payload.content), 20000).startsWith(expected));
    const id = meta.id || path.basename(file).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/)?.[1];
    if (opened && id) return { file, id };
  }
  return null;
}

export function antigravityCliTranscriptPath(nativeId, cliDir = roots.antigravity[1]) {
  return nativeId ? path.join(cliDir, 'brain', nativeId, '.system_generated', 'logs', 'transcript.jsonl') : '';
}

export function antigravityRunStatus(nativeId, cliDir = roots.antigravity[1]) {
  if (!nativeId) return { status:'', updatedAt:'' };
  const dirName = path.basename(cliDir);
  const { rows } = antigravitySummaryData(path.join(cliDir, 'conversation_summaries.db'));
  const row = rows.find(r => r.conversation_id === nativeId && (!r.app_data_dir || r.app_data_dir === dirName));
  return row ? { status:row.status || '', updatedAt:parseTimestamp(row.last_modified_time) } : { status:'', updatedAt:'' };
}

const agScans = new Map(); // task id -> { file, offset, rest, foundAt, output, finalReply, nextTurn }
export function antigravityTerminalProgress(task) {
  if (!task.transcriptFile || !fs.existsSync(task.transcriptFile)) return { found:false, foundAt:null, output:'', finalReply:false };
  const expected = clean(task.agentPrompt || task.prompt, 20000).slice(0, 80);
  const key = task.id || `${task.transcriptFile}|${task.createdAt}|${expected}`;
  let scan = agScans.get(key);
  if (!scan || scan.file !== task.transcriptFile) {
    scan = { file:task.transcriptFile, offset:Math.max(0, Number(task.transcriptOffset) || 0), rest:Buffer.alloc(0), foundAt:null, output:[], finalReply:false, nextTurn:false };
    agScans.set(key, scan);
    if (agScans.size > 100) agScans.delete(agScans.keys().next().value);
  }
  if (scan.nextTurn) return { found:Boolean(scan.foundAt), foundAt:scan.foundAt, output:scan.output.join('\n\n'), finalReply:true };
  const fd = fs.openSync(scan.file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < scan.offset) Object.assign(scan, { offset:0, rest:Buffer.alloc(0), foundAt:null, output:[], finalReply:false, nextTurn:false });
    while (scan.offset < size && !scan.nextTurn) {
      const buffer = Buffer.alloc(Math.min(CHUNK, size - scan.offset));
      const read = fs.readSync(fd, buffer, 0, buffer.length, scan.offset);
      if (!read) break;
      scan.offset += read;
      const data = Buffer.concat([scan.rest, buffer.subarray(0, read)]);
      const end = data.lastIndexOf(10);
      scan.rest = end < 0 ? data : data.subarray(end + 1);
      if (end < 0) continue;
      for (const row of jsonLines(data.subarray(0, end).toString('utf8'))) {
        if (!scan.foundAt) {
          if (row.type !== 'USER_INPUT' || row.source === 'SYSTEM') continue;
          const at = Date.parse(row.created_at || '');
          if (Number.isFinite(at) && at < Date.parse(task.createdAt) - 5000) continue;
          if (clean(antigravityUserText(row.content), 20000).startsWith(expected)) scan.foundAt = Number.isFinite(at) ? at : Date.now();
          continue;
        }
        if (row.type === 'USER_INPUT' && row.source !== 'SYSTEM') { scan.nextTurn = true; break; }
        if (row.type === 'GENERIC') { scan.finalReply = false; continue; }
        if (row.type === 'PLANNER_RESPONSE' && (!row.source || row.source === 'MODEL')) {
          const message = row.content ? displayText(row.content) : '';
          if (message) scan.output.push(message);
          const hasTools = Array.isArray(row.tool_calls) && row.tool_calls.length > 0;
          scan.finalReply = Boolean(message) && !hasTools && (!row.status || row.status === 'DONE');
        }
      }
    }
  } finally { fs.closeSync(fd); }
  return { found:Boolean(scan.foundAt), foundAt:scan.foundAt, output:scan.output.join('\n\n'), finalReply:Boolean(scan.finalReply || scan.nextTurn) };
}

export function findAntigravityTranscript(task, cliDir = roots.antigravity[1]) {
  const since = Date.parse(task.createdAt) - 5000;
  const expected = clean(task.agentPrompt || task.prompt, 20000).slice(0, 80);
  const brainDir = path.join(cliDir, 'brain');
  const lastCwd = antigravityLastConversations(cliDir);
  const dirName = path.basename(cliDir);
  const { rows:summaryRows, subagents } = antigravitySummaryData(path.join(cliDir, 'conversation_summaries.db'));
  const summaryCwd = new Map();
  for (const row of summaryRows) {
    if (row.app_data_dir && row.app_data_dir !== dirName) continue;
    const cwd = firstWorkspacePath(row.workspace_uris);
    if (cwd) summaryCwd.set(row.conversation_id, cwd);
  }
  let entries = [];
  try { entries = fs.readdirSync(brainDir, { withFileTypes:true }); } catch { return null; }
  const recent = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || subagents.has(entry.name)) continue;
    const file = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    try {
      const stat = fs.statSync(file);
      if (Math.max(stat.mtimeMs, stat.birthtimeMs) >= since) recent.push({ id:entry.name, file, mtime:stat.mtimeMs });
    } catch {}
  }
  recent.sort((a, b) => b.mtime - a.mtime);
  for (const { id, file } of recent) {
    const rows = jsonLines(sliceFile(file, 512 * 1024));
    const cwd = summaryCwd.get(id) || lastCwd.get(id) || rows.find(x => typeof x.cwd === 'string' && x.cwd)?.cwd || '';
    if (task.cwd && cwd && path.resolve(cwd) !== path.resolve(task.cwd)) continue;
    const opened = rows.some(x => x.type === 'USER_INPUT' && x.source !== 'SYSTEM'
      && (!x.created_at || Date.parse(x.created_at) >= since)
      && clean(antigravityUserText(x.content), 20000).startsWith(expected));
    if (opened) return { file, id };
  }
  return null;
}
