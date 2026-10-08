import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Claude Code writes ~/.claude/sessions/<pid>.json for each running interactive session, with its session ID and busy/idle status.
export function claudeLiveSessions() {
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  const live = new Map();
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => /^\d+\.json$/.test(name)); } catch { return live; }
  for (const name of names) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (!record.sessionId || !Number.isInteger(record.pid) || !processAlive(record.pid)) continue;
      live.set(record.sessionId, { pid:record.pid, status:record.status || '', statusUpdatedAt:record.statusUpdatedAt || 0, tty:ttyOf(record.pid) });
    } catch { /* A session may be writing its record. */ }
  }
  return live;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function ttyOf(pid) {
  const result = spawnSync('/bin/ps', ['-o', 'tty=', '-p', String(pid)], { encoding:'utf8', timeout:2000 });
  const name = (result.stdout || '').trim();
  return /^ttys\d+$/.test(name) ? `/dev/${name}` : '';
}

// True when `command` is the foreground program in that terminal, so typed text goes to it and not to the shell.
export function agentInForeground(tty, command) {
  if (!tty) return false;
  const names = Array.isArray(command) ? command : [command];
  const result = spawnSync('/bin/ps', ['-t', tty.replace('/dev/', ''), '-o', 'stat=,comm='], { encoding:'utf8', timeout:2000 });
  return (result.stdout || '').split('\n').some(line => {
    const match = line.trim().match(/^(\S+)\s+(.+)$/);
    return match && match[1].includes('+') && names.includes(path.basename(match[2]));
  });
}

export function pidOnTty(tty, command) {
  const result = spawnSync('/bin/ps', ['-t', tty.replace('/dev/', ''), '-o', 'pid=,comm='], { encoding:'utf8', timeout:2000 });
  for (const line of (result.stdout || '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (match && path.basename(match[2]) === command) return Number(match[1]);
  }
  return null;
}

// Arguments go through argv so prompt text is never parsed as AppleScript.
function osascript(script, args) {
  const result = spawnSync('/usr/bin/osascript', ['-', ...args], { input:script, encoding:'utf8', timeout:15000, maxBuffer:8 * 1024 * 1024 });
  if (result.error) throw new Error(`Terminal could not be reached: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim();
    if (/-1743|not allowed|Not authorized/i.test(detail)) throw new Error('macOS has not allowed the task plane to control Terminal. Approve it on the Mac under System Settings → Privacy & Security → Automation.');
    throw new Error(detail || 'Terminal did not respond.');
  }
  return result.stdout.replace(/\n$/, '');
}

const findTab = `
on findTab(ttyName)
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        -- Finished tabs keep their old tty name, which macOS reuses for new windows.
        if tty of t is ttyName and (count of processes of t) > 0 then return t
      end repeat
    end repeat
  end tell
  return missing value
end findTab
`;

// `do script ... in tab` types into whatever program holds the tab, then presses Return.
// Claude Code treats a fast burst of text as a paste, so that Return can land inside the input instead of submitting it.
// Prompts are therefore sent as one bracketed paste, followed by a separate Return a moment later.
// With `agent`, text is only typed while that agent is the terminal's foreground program, checked again before Return:
// if the agent has exited, Return would run the text as a shell command, so the line is wiped instead.
export function typeIntoTerminal(tty, text, { prompt = false, agent = '' } = {}) {
  if (agent && !agentInForeground(tty, agent)) throw new Error(`${agent} is no longer running in that Terminal tab.`);
  const send = value => {
    const result = osascript(`${findTab}
on run argv
  set t to findTab(item 1 of argv)
  if t is missing value then return "missing"
  tell application "Terminal" to do script (item 2 of argv) in t
  return "ok"
end run`, [tty, value]);
    if (result !== 'ok') throw new Error('That Terminal tab is no longer open.');
  };
  if (!prompt) return send(text);
  // do script always ends with Return; inside a bracketed paste that Return stays part of the text, and a separate Return submits it.
  send(`\u001b[200~${text}\u001b[201~`);
  spawnSync('/bin/sleep', ['0.6']);
  if (agent && !agentInForeground(tty, agent)) { send('\u0015'); throw new Error(`${agent} exited while the message was being typed.`); }
  send('');
}

export function readTerminal(tty, maxLines = 400) {
  const text = osascript(`${findTab}
on run argv
  set t to findTab(item 1 of argv)
  if t is missing value then return "__TAB_MISSING__"
  tell application "Terminal" to return history of t
end run`, [tty]);
  if (text === '__TAB_MISSING__') return null;
  return text.replace(/\s+$/, '').split('\n').slice(-maxLines).join('\n');
}

function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }

// Opens a new Terminal window running the command in cwd. The prompt is read from a private file so it needs no shell quoting.
export function openTerminal(cwd, argv, promptFile) {
  const command = `cd ${shellQuote(cwd)} && ${argv.map(shellQuote).join(' ')}${promptFile ? ` "$(cat ${shellQuote(promptFile)}; rm -f ${shellQuote(promptFile)})"` : ''}`;
  const tty = osascript(`on run argv
  tell application "Terminal"
    set t to do script (item 1 of argv)
    return tty of t
  end tell
end run`, [command]);
  if (!/^\/dev\/ttys\d+$/.test(tty)) throw new Error('Terminal did not open a new window.');
  return tty;
}
