import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { liveSessionStates } from './live.js';

const home = os.homedir();
const roots = {
  codex: path.join(home, '.codex', 'sessions'),
  claude: path.join(home, '.claude', 'projects'),
  gemini: path.join(home, '.gemini', 'tmp'),
  pi: path.join(home, '.pi', 'agent', 'sessions'),
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

function codexRecord(file) {
  const stat = fs.statSync(file);
  const lines = jsonLines(sliceFile(file, 256 * 1024));
  const meta = lines.find(x => x.type === 'session_meta')?.payload || {};
  const prompts = lines.filter(x => x.type === 'response_item' && x.payload?.type === 'message' && x.payload.role === 'user')
    .map(x => contentText(x.payload.content)).filter(isUsefulPrompt);
  const title = clean(prompts.find(x => !x.includes('AGENTS.md')) || prompts[0] || path.basename(meta.cwd || '', '/'));
  const tail = sliceFile(file, 128 * 1024, true);
  const recent = jsonLines(tail).filter(x => x.type === 'response_item' && x.payload?.type === 'message' && x.payload.role === 'user').map(x => contentText(x.payload.content)).filter(isUsefulPrompt);
  const id = path.basename(file).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/)?.[1] || meta.id || meta.session_id;
  if (!id) return null;
  return { id: `codex:${id}`, nativeId: id, harness: 'codex', title: title || 'Untitled Codex session', lastPrompt: clean(recent.at(-1), 260), cwd: meta.cwd || '', currentModel: lastModel(tail), updatedAt: stat.mtime.toISOString(), file, source: 'desktop' };
}

function claudeRecord(file) {
  const stat = fs.statSync(file);
  const lines = jsonLines(sliceFile(file, 256 * 1024));
  const first = lines.find(x => x.type === 'user' && !x.isSidechain && isUsefulPrompt(contentText(x.message?.content)));
  const title = clean(contentText(first?.message?.content));
  const tail = sliceFile(file, 128 * 1024, true);
  const recent = jsonLines(tail).filter(x => x.type === 'user' && !x.isSidechain).map(x => contentText(x.message?.content)).filter(isUsefulPrompt);
  const id = first?.sessionId || path.basename(file, '.jsonl');
  return { id: `claude:${id}`, nativeId: id, harness: 'claude', title: title || 'Untitled Claude session', lastPrompt: clean(recent.at(-1), 260), cwd: first?.cwd || '', currentModel: lastModel(tail), updatedAt: stat.mtime.toISOString(), file, source: 'desktop' };
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
  return { id: `gemini:${id}`, nativeId: id, harness: 'gemini', title: title || 'Untitled Gemini session', lastPrompt: clean(last?.content || last?.text || last?.message, 260), cwd: data.cwd || '', currentModel: [...messages].reverse().find(x => typeof x.model === 'string')?.model || '', updatedAt: data.lastUpdated || stat.mtime.toISOString(), file, source: 'desktop' };
}

function piRecord(file) {
  const stat = fs.statSync(file);
  const lines = jsonLines(sliceFile(file, 256 * 1024));
  const meta = lines.find(x => x.type === 'session') || {};
  const prompts = lines.filter(x => x.type === 'message' && x.message?.role === 'user').map(x => contentText(x.message.content)).filter(isUsefulPrompt);
  const tail = sliceFile(file, 128 * 1024, true);
  const recent = jsonLines(tail).filter(x => x.type === 'message' && x.message?.role === 'user').map(x => contentText(x.message.content)).filter(isUsefulPrompt);
  const id = meta.id || path.basename(file, '.jsonl').match(/[0-9a-f]{8}-[0-9a-f-]{27,}/)?.[0];
  if (!id) return null;
  return { id:`pi:${id}`, nativeId:id, harness:'pi', title:clean(prompts[0]) || 'Untitled Pi session', lastPrompt:clean(recent.at(-1), 260), cwd:meta.cwd || '', currentModel:lastModel(tail), updatedAt:stat.mtime.toISOString(), file, source:'desktop' };
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
  try { sessions.push(...opencodeCached()); } catch {}
  const live = liveSessionStates(sessions);
  return sessions.filter(session => !(session.title.startsWith('Untitled ') && !session.cwd))
    .map(session => ({ ...session, liveState:live.get(session.id)?.liveState || 'history', tty:live.get(session.id)?.tty || '' }))
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
  const { file, nativeId, ...safe } = session;
  return safe;
}

// A message typed into a Claude terminal shows up in its transcript; the reply is every assistant message after it.
export function claudeTerminalProgress(task) {
  if (!task.transcriptFile || !fs.existsSync(task.transcriptFile)) return { found:false, output:'' };
  const expected = clean(task.agentPrompt || task.prompt, 20000).slice(0, 80);
  let foundAt = null;
  const output = [];
  for (const row of jsonLines(sliceFile(task.transcriptFile, 4 * 1024 * 1024, true))) {
    if (row.isSidechain) continue;
    if (!foundAt) {
      if (row.type !== 'user' || Date.parse(row.timestamp || '') < Date.parse(task.createdAt) - 5000) continue;
      const raw = contentText(row.message?.content);
      if (isUsefulPrompt(raw) && clean(raw, 20000).startsWith(expected)) foundAt = Date.parse(row.timestamp);
      continue;
    }
    if (row.type === 'assistant') {
      const message = displayText(contentText(row.message?.content));
      if (message) output.push(message);
    }
  }
  return { found:Boolean(foundAt), foundAt, output:output.join('\n\n') };
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
