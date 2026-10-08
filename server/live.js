import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { claudeLiveSessions, ttyOf, readTerminal } from './terminal.js';

// Approval prompts and menus end with these lines; a session showing one is waiting on the user.
const askingPatterns = {
  claude:/Do you want to|Esc to cancel|Enter to confirm|❯\s*1\./,
  codex:/Would you like to|Allow .*\?|Press enter to confirm|esc to cancel|[›❯]\s*1\.\s/i,
};
// Reading a Terminal window takes about 0.3 seconds, so each answer is reused briefly.
const askingCache = new Map();
export function terminalIsAsking(tty, harness) {
  if (!tty || !askingPatterns[harness]) return false;
  const key = `${tty}:${harness}`, hit = askingCache.get(key);
  if (hit && Date.now() - hit.at < 8000) return hit.asking;
  let asking = false;
  try { asking = askingPatterns[harness].test(readTerminal(tty, 14) || ''); } catch {}
  askingCache.set(key, { at:Date.now(), asking });
  return asking;
}
const claudeIsAsking = tty => terminalIsAsking(tty, 'claude');

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
      states.set(session.id, { liveState:claudeIsAsking(claudeLive.tty) ? 'asking' : claudeLive.status === 'busy' ? 'working' : 'open', livePid:claudeLive.pid, tty:claudeLive.tty });
    } else if (pid && processes.get(pid) === session.harness) {
      const tty = ttyOf(pid);
      states.set(session.id, { liveState:session.harness === 'codex' ? (terminalIsAsking(tty, 'codex') ? 'asking' : codexWorkState(session.file)) : Date.now() - Date.parse(session.updatedAt) < 90000 ? 'working' : 'open', livePid:pid, tty });
    } else if (session.harness === 'opencode' && statuses.has(session.nativeId)) {
      const status = statuses.get(session.nativeId);
      states.set(session.id, { liveState:status?.type === 'busy' ? 'working' : 'open' });
    }
  }
  return states;
}
