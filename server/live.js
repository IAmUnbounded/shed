import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { claudeLiveSessions, ttyOf, readTerminalAsync } from './terminal.js';

// Approval prompts and menus end with these lines; a session showing one is waiting on the user.
const askingPatterns = {
  claude:/Do you want to|Esc to cancel|Enter to confirm|❯\s*1\./,
  codex:/Would you like to|Allow .*\?|Press enter to confirm|esc to cancel|[›❯]\s*1\.\s/i,
};
// Mid-turn, both CLIs show "esc to interrupt" in their footer, even while waiting on their own tools or background work.
const activePattern = /esc to interrupt|Working \(/i;
// Reading a Terminal window takes about 0.3 seconds. Readings are refreshed in the background (at most every
// 3 seconds per window) and the last one is returned straight away, so session discovery never waits on Terminal.
const screenCache = new Map();
export function terminalState(tty, harness) {
  if (!tty || !askingPatterns[harness]) return { asking:false, active:false };
  const key = `${tty}:${harness}`;
  let entry = screenCache.get(key);
  if (!entry) { entry = { at:0, state:{ asking:false, active:false }, pending:false }; screenCache.set(key, entry); }
  if (!entry.pending && Date.now() - entry.at > 3000) {
    entry.pending = true;
    readTerminalAsync(tty, 14)
      .then(screen => { entry.state = { asking:askingPatterns[harness].test(screen || ''), active:activePattern.test(screen || '') }; })
      .catch(() => {})
      .finally(() => { entry.at = Date.now(); entry.pending = false; });
  }
  return entry.state;
}
export const terminalIsAsking = (tty, harness) => terminalState(tty, harness).asking;
// Claude's own status: busy (mid-turn), waiting (needs the person's input) or idle. Its footer covers the gaps,
// such as a turn that is waiting on its own background work.
export function claudeLiveState(info) {
  if (info.status === 'waiting') return 'asking';
  const screen = terminalState(info.tty, 'claude');
  if (screen.asking) return 'asking';
  return info.status === 'busy' || screen.active ? 'working' : 'open';
}

const names = new Set(['codex', 'claude', 'gemini', 'pi', 'opencode']);

export function parseOpenFiles(output) {
  const files = new Map();
  let pid = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line.startsWith('n') && pid && path.isAbsolute(line.slice(1))) files.set(line.slice(1), pid);
  }
  return files;
}

function agentPids() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding:'utf8', timeout:3000, maxBuffer:2 * 1024 * 1024 });
  if (result.status !== 0) return new Map();
  const processes = new Map();
  for (const line of result.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const name = path.basename(match[2]).toLowerCase();
    if (names.has(name)) processes.set(Number(match[1]), name);
  }
  return processes;
}

function openFiles(pids) {
  if (!pids.length) return new Map();
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '-F', 'pn', '-p', pids.join(',')], { encoding:'utf8', timeout:5000, maxBuffer:8 * 1024 * 1024 });
  return parseOpenFiles(result.stdout || '');
}

export function codexWorkState(file) {
  try {
    const fd = fs.openSync(file, 'r');
    let text;
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, 128 * 1024);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
    let last = '';
    for (const line of text.split('\n')) {
      if (!line.includes('task_started') && !line.includes('task_complete') && !line.includes('turn_aborted')) continue;
      try {
        const row = JSON.parse(line);
        if (row.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(row.payload?.type)) last = row.payload.type;
      } catch { /* A live write may be incomplete. */ }
    }
    return last === 'task_started' ? 'working' : 'open';
  } catch { return 'open'; }
}

function opencodeStatuses(processes) {
  if (![...processes.values()].includes('opencode')) return new Map();
  const pids = [...processes].filter(([, name]) => name === 'opencode').map(([pid]) => pid);
  const listeners = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-F', 'n', '-p', pids.join(',')], { encoding:'utf8', timeout:3000, maxBuffer:1024 * 1024 });
  const ports = [...new Set((listeners.stdout || '').split('\n').flatMap(line => {
    const match = line.match(/^n(?:127\.0\.0\.1|\[::1\]):(\d+)$/);
    return match ? [Number(match[1])] : [];
  }))];
  for (const port of ports) for (const endpoint of ['/session/status', '/api/session/status']) {
    const response = spawnSync('/usr/bin/curl', ['-fsS', '--noproxy', '*', '--max-time', '2', `http://127.0.0.1:${port}${endpoint}`], { encoding:'utf8', timeout:3000, maxBuffer:1024 * 1024 });
    if (response.status !== 0) continue;
    try {
      const data = JSON.parse(response.stdout);
      if (data && typeof data === 'object' && !Array.isArray(data)) return new Map(Object.entries(data));
    } catch { /* Try another local OpenCode endpoint. */ }
  }
  return new Map();
}

export function liveSessionStates(sessions) {
  const processes = agentPids();
  const files = openFiles([...processes.keys()]);
  const statuses = opencodeStatuses(processes);
  const claude = claudeLiveSessions();
  const states = new Map();
  for (const session of sessions) {
    const pid = session.file && files.get(session.file);
    const claudeLive = session.harness === 'claude' && claude.get(session.nativeId);
    if (claudeLive) {
      states.set(session.id, { liveState:claudeLiveState(claudeLive), livePid:claudeLive.pid, tty:claudeLive.tty });
    } else if (pid && processes.get(pid) === session.harness) {
      const tty = ttyOf(pid);
      const screen = session.harness === 'codex' ? terminalState(tty, 'codex') : null;
      states.set(session.id, { liveState:session.harness === 'codex' ? (screen.asking ? 'asking' : screen.active ? 'working' : codexWorkState(session.file)) : Date.now() - Date.parse(session.updatedAt) < 90000 ? 'working' : 'open', livePid:pid, tty });
    } else if (session.harness === 'opencode' && statuses.has(session.nativeId)) {
      const status = statuses.get(session.nativeId);
      states.set(session.id, { liveState:status?.type === 'busy' ? 'working' : 'open' });
    }
  }
  return states;
}
