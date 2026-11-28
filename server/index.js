import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { discoverSessions, publicSession, sessionMessages, codexQueuedProgress, claudeTerminalProgress, findCodexTranscript, antigravityCliTranscriptPath, antigravityRunStatus, antigravityTerminalProgress, findAntigravityTranscript } from './sessions.js';
import { codexWorkState, terminalIsAsking, terminalState, claudeLiveState, footerMode, activeOnScreen, antigravityLiveState, antigravityConversationForPid } from './live.js';
import { claudeLiveSessions, typeIntoTerminal, readTerminal, openTerminal, pidOnTty, agentInForeground, typeIntoTerminalAsync, readTerminalAsync, openTerminalAsync, stopAgent, closeTerminalTab, ttyOf, runInTab, canSkipPermissions } from './terminal.js';
import { autoClosePrefs, idleSessions } from './idle.js';
import { exchangeStore, exchangeSummary, refusal, depthFor, messagePrompt, introductionPrompt, describe } from './exchanges.js';
import { rankSessions, autoRoutePrefs, routableHarnesses } from './router.js';
import { decideRoute, decideFollowup, decideModel, probeLaya, getLaya, layaStatus } from './laya.js';
import { harnesses, cliCommand, cliProcessNames, modelConfig, validateModelConfig, offeredModels } from './models.js';
import { harnessHealth, refreshHarnessHealth } from './health.js';
import { initPush, pushPublicKey, subscribe, unsubscribe, notify, isSubscribed, pushCount } from './notify.js';
import { listArtifacts, resolveInside, sendFile } from './files.js';
import { repoRoot, changes as gitChanges, fileDiff, branchChanges, branchFileDiff, commitAll, discardFile, push as gitPush, pullRequest, createPullRequest, failedCheckLogs, sessionWorktree, listWorktrees, removeWorktree, mergeWorktree, listIssues } from './git.js';
import { compareStore, compareSummary, buildReviewPrompt } from './compare.js';
import { checkpointStore, captureCheckpoint, revertToCheckpoint, checkpointChanges, checkpointFileDiff } from './checkpoints.js';
import { queueStore, queueSummary, planModePrompt, steerPrompt } from './queue.js';
import { discoverScripts, scriptResultsFor, runProjectScript } from './scripts.js';
import { remoteStore, probeTailscale, findCloudflared } from './remote.js';
import { interruptCodexThread } from './codex-app.js';
import { uploadStore, attachmentNote, UPLOAD_ID } from './uploads.js';
import { parseMenu, keysToChoose } from './menu.js';
import { extractUrl, fetchShared, sharePrompt, signedShortcut } from './share.js';
import { cleanupSuggestions } from './cleanup.js';
import { trustShedWorkspace } from './trust.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const dataDir = process.env.LAYA_DATA_DIR || process.env.JEV_DATA_DIR || path.join(root, '.jev-data');
const taskFile = path.join(dataDir, 'tasks.json');
const settingsFile = path.join(dataDir, 'settings.json');
const tokenFile = path.join(root, '.laya-token');
const legacyTokenFile = path.join(root, '.jev-token');
const port = Number(process.env.PORT || 4378);
// Only the Mac itself (and the https tunnel, which connects locally) can reach Shed unless Wi-Fi access is turned on.
// Wi-Fi access is plain http, so passwords and cookies would cross the network unencrypted.
const lanEnabled = process.env.SHED_LAN === '1';
const host = process.env.HOST || (lanEnabled ? '0.0.0.0' : '127.0.0.1');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.chmodSync(dataDir, 0o700);
const token = process.env.LAYA_TOKEN || process.env.JEV_TOKEN || getToken();
const available = Object.fromEntries(harnesses.map(name => [name, commandExists(cliCommand(name))]));
const active = new Map();
let cached = { at: 0, sessions: [] };
let tasks = loadTasks();
let settings = loadSettings();
initPush(dataDir);
const remote = remoteStore(dataDir);
const uploads = uploadStore(dataDir);
const attempts = new Map();
const exchanges = exchangeStore(dataDir);
const comparisons = compareStore(dataDir);
const checkpoints = checkpointStore(dataDir);
const queue = queueStore(dataDir);
// The `shed` command agents run (bin/shed) finds Shed through agent.json: this port and a key that only works from this Mac.
const agentKey = crypto.randomBytes(24).toString('base64url');
fs.writeFileSync(path.join(dataDir, 'agent.json'), JSON.stringify({ port, key:agentKey }), { mode:0o600 });
const shedCli = (cli => /^[\w./-]+$/.test(cli) ? cli : `'${cli.replace(/'/g, `'\\''`)}'`)(path.join(root, 'bin', 'shed'));

// Reflect CLIs installed or removed after Shed started as soon as the next health check runs.
function syncAvailable(health = harnessHealth()) {
  for (const name of harnesses) {
    if (health?.[name]?.checkedAt) available[name] = Boolean(health[name].installed);
  }
  return available;
}
function checkHealth(force = false) {
  return refreshHarnessHealth(force).then(health => { syncAvailable(health); return health; });
}
function getToken() {
  if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, 'utf8').trim();
  if (fs.existsSync(legacyTokenFile)) {
    fs.renameSync(legacyTokenFile, tokenFile);
    fs.chmodSync(tokenFile, 0o600);
    return fs.readFileSync(tokenFile, 'utf8').trim();
  }
  const value = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(tokenFile, value + '\n', { mode: 0o600, flag: 'wx' });
  return value;
}
function remoteStatus() {
  return remote.readStatus();
}
function remoteUrl() {
  return remote.url();
}
function commandExists(command) {
  return spawnSync('which', [command], { encoding: 'utf8' }).status === 0;
}
function loadTasks() {
  try { return JSON.parse(fs.readFileSync(taskFile, 'utf8')).map(t => !t.delivery && (t.status === 'running' || t.status === 'queued') ? { ...t, status: 'interrupted' } : t); }
  catch { return []; }
}
function loadSettings() {
  try {
    const loaded = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (Object.hasOwn(loaded, 'typesafeApiKey')) {
      delete loaded.typesafeApiKey;
      fs.writeFileSync(settingsFile, JSON.stringify(loaded), { mode:0o600 });
    }
    return loaded;
  } catch { return {}; }
}
function lanAddress() { return Object.values(os.networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address || 'localhost'; }
function saveTasks() {
  fs.writeFileSync(taskFile, JSON.stringify(tasks.slice(0, 200), null, 2), { mode: 0o600 });
  fs.chmodSync(taskFile, 0o600);
}
function passwordConfigured() { return typeof settings.passwordHash === 'string' && settings.passwordHash.startsWith('scrypt$'); }
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const derived = crypto.scryptSync(password, salt, 32).toString('base64url');
  return `scrypt$${salt}$${derived}`;
}
function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [, salt, encoded] = stored.split('$');
  if (!salt || !encoded) return false;
  try {
    const expected = Buffer.from(encoded, 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'tailscale-user-login', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded'];
// A request typed on this Mac: loopback, and not relayed by a tunnel or reverse proxy (which also connect over loopback).
function isDirectLocal(req) {
  return LOOPBACK.includes(req.socket.remoteAddress) && !PROXY_HEADERS.some(h => req.headers[h] !== undefined);
}
// The visitor's real address: cloudflared reports CF-Connecting-IP, Tailscale and reverse proxies report X-Forwarded-For.
function clientIp(req) {
  if (LOOPBACK.includes(req.socket.remoteAddress)) {
    if (typeof req.headers['cf-connecting-ip'] === 'string') return req.headers['cf-connecting-ip'].slice(0, 64);
    if (typeof req.headers['x-forwarded-for'] === 'string') {
      const first = req.headers['x-forwarded-for'].split(',')[0]?.trim();
      if (first) return first.slice(0, 64);
    }
    if (typeof req.headers['tailscale-user-login'] === 'string') return req.headers['tailscale-user-login'].slice(0, 64);
  }
  return req.socket.remoteAddress || 'unknown';
}
function isLocalRequest(req) {
  if (!isDirectLocal(req)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
  } catch { return false; }
}
function saveSettings() {
  fs.writeFileSync(settingsFile, JSON.stringify(settings), { mode:0o600 });
  fs.chmodSync(settingsFile, 0o600);
}
// Every session, with whether it was cleared from the list and, if not, why it looks like clutter. Clearing only hides a
// session in Shed; one that comes back to life (resumed on the Mac or from Shed) is back in the list.
function sessions(force = false) {
  if (force || Date.now() - cached.at > 10000) {
    const list = withTrackedTerminals(discoverSessions());
    const hidden = new Set(settings.hiddenSessions || []);
    const revived = list.filter(s => s.liveState !== 'history' && hidden.has(s.id));
    if (revived.length) { for (const s of revived) hidden.delete(s.id); settings = { ...settings, hiddenSessions:[...hidden] }; saveSettings(); }
    const clutter = cleanupSuggestions(list.filter(s => !hidden.has(s.id)));
    cached = { at: Date.now(), sessions: list.map(s => ({ ...s, hidden:hidden.has(s.id), cleanup:clutter.get(s.id) || '' })) };
  }
  return cached.sessions;
}
function hideSessions(ids, hide) {
  const known = new Set(sessions().map(s => s.id));
  const hidden = new Set(settings.hiddenSessions || []);
  for (const id of ids) { if (!hide) hidden.delete(id); else if (known.has(id)) hidden.add(id); }
  settings = { ...settings, hiddenSessions:[...hidden].slice(-5000) }; saveSettings();
  return sessions(true);
}
// Codex runs through a background service and Antigravity can switch or reopen files in its Terminal tab.
// Shed remembers the Terminal windows it opened (on the task) and treats a session as live while its agent still runs there.
function trackedTerminals() {
  const found = new Map();
  for (const task of tasks) {
    if (!['codex', 'antigravity'].includes(task.harness) || task.delivery !== 'terminal' || !task.nativeSessionId || !task.tty) continue;
    const key = `${task.harness}:${task.nativeSessionId}`;
    if (found.has(key)) continue;
    found.set(key, { harness:task.harness, tty:task.tty });
  }
  for (const [key, info] of found) {
    const pid = pidOnTty(info.tty, cliProcessNames(info.harness));
    if (!pid) found.delete(key);
    else info.pid = pid;
  }
  return found;
}
function withTrackedTerminals(list) {
  const terminals = trackedTerminals();
  if (!terminals.size) return list;
  return list.map(session => {
    const info = ['codex', 'antigravity'].includes(session.harness) && !session.tty && !session.agAppOnly && terminals.get(session.id);
    if (!info) return session;
    const { tty, pid } = info;
    if (session.harness === 'codex') {
      const screen = terminalState(tty, 'codex');
      return { ...session, tty, liveState:screen.asking ? 'asking' : screen.active ? 'working' : codexWorkState(session.file) };
    }
    const screen = terminalState(tty, 'antigravity');
    const run = antigravityRunStatus(session.nativeId);
    const dbState = antigravityLiveState({ agStatus:run.status || session.agStatus, updatedAt:run.updatedAt || session.updatedAt }, true);
    const permissions = canSkipPermissions(pid) ? 'skip' : screen.mode || session.permissions || '';
    return { ...session, tty, liveState:screen.asking ? 'asking' : dbState || (screen.active ? 'working' : 'open'), ...(permissions ? { permissions } : {}) };
  });
}
// A new Claude, Codex or Antigravity window can stop at a startup question (trust this folder, onboarding, update, pick an option)
// before it takes the message. Shed reads the window, keeps the task open while it waits, and tells the person once.
const STARTUP_PROMPT = /trust|Update available|update now|Press enter|Enter to confirm|Esc to cancel|enter Confirm|enter Toggle|Terms of Service|Choose your color scheme|Allow .*\?|\(y\/n\)|\[y\/n\]|❯\s*1\.|›\s*1\.\s|Would you like|Do you want/i;
const startupScreens = new Map(); // task id -> last background reading of its window
function startupPrompt(task) {
  if (!task.tty || Date.now() - Date.parse(task.createdAt) < 12000) return '';
  const reading = startupScreens.get(task.id) || { at:0, text:'', pending:false };
  startupScreens.set(task.id, reading);
  if (!reading.pending && Date.now() - reading.at > 8000) {
    reading.pending = true;
    readTerminalAsync(task.tty, 16).then(text => { reading.text = text || ''; }).catch(() => {}).finally(() => { reading.at = Date.now(); reading.pending = false; });
  }
  const screen = reading.text;
  if (!STARTUP_PROMPT.test(screen)) return '';
  const waiting = screen.split('\n').map(l => l.trim()).filter(Boolean).slice(-4).join(' · ').slice(0, 220);
  if (!task.waitNotified) {
    task.waitNotified = true;
    notify({ title:`${label[task.harness] || task.harness} is waiting for an answer`, body:waiting, url:`/?task=${encodeURIComponent(task.id)}`, tag:`task-${task.id}` }).catch(() => {});
  }
  task.waitingOn = waiting;
  return waiting;
}
function refreshCodexTerminalTask(task) {
  const age = Date.now() - Date.parse(task.createdAt);
  if (!task.transcriptFile) {
    const found = findCodexTranscript(task);
    if (!found) {
      if (startupPrompt(task)) return null;
      if (age > 120000) return { status:'failed', undelivered:true, error:pidOnTty(task.tty, 'codex') ? 'Codex has not recorded this message after two minutes. Check the Terminal window on the Mac.' : 'Codex did not start in the new Terminal window. Check that window on the Mac.' };
      return null;
    }
    task.waitingOn = '';
    Object.assign(task, { transcriptFile:found.file, nativeSessionId:found.id, sessionId:`codex:${found.id}` });
  }
  const progress = codexQueuedProgress(task);
  if (progress) return { status:progress.status, output:progress.output || task.output, error:progress.error || '' };
  // Typed but not in the transcript yet: if Codex is idle, the message is probably sitting unsent in its input box.
  const alive = pidOnTty(task.tty, 'codex');
  if (!alive) return { status:'failed', undelivered:true, error:'The Codex window closed before it received this message.' };
  if (age > 8000 && codexWorkState(task.transcriptFile) !== 'working' && (task.submitRetries || 0) < 3 && Date.now() - (task.lastSubmitRetry || 0) > 6000) {
    typeIntoTerminalAsync(task.tty, '', { agent:'codex' }).catch(() => {});
    task.submitRetries = (task.submitRetries || 0) + 1; task.lastSubmitRetry = Date.now();
  }
  if (age > 300000 && !startupPrompt(task)) return { status:'failed', undelivered:true, error:'Codex has not recorded this message after five minutes. Check the Terminal window on the Mac.' };
  return null;
}
function refreshAntigravityTerminalTask(task) {
  const age = Date.now() - Date.parse(task.createdAt);
  const procNames = cliProcessNames('antigravity');
  const pid = pidOnTty(task.tty, procNames);
  if (!task.nativeSessionId) {
    const liveId = pid ? antigravityConversationForPid(pid) : '';
    const found = liveId ? { id:liveId, file:antigravityCliTranscriptPath(liveId) } : findAntigravityTranscript(task);
    if (!found) {
      if (startupPrompt(task)) return null;
      if (age > 120000) return { status:'failed', undelivered:true, error:pid ? 'Antigravity has not started this conversation after two minutes. Check the Terminal window on the Mac.' : 'Antigravity did not start in the new Terminal window. Check that window on the Mac.' };
      return null;
    }
    task.waitingOn = '';
    Object.assign(task, { nativeSessionId:found.id, sessionId:`antigravity:${found.id}`, transcriptFile:found.file || antigravityCliTranscriptPath(found.id) });
  }
  if (!task.transcriptFile && task.nativeSessionId) task.transcriptFile = antigravityCliTranscriptPath(task.nativeSessionId);
  const progress = antigravityTerminalProgress(task);
  const run = antigravityRunStatus(task.nativeSessionId);
  const dbRunning = run.status === 'CASCADE_RUN_STATUS_RUNNING';
  const dbWaiting = /WAITING/i.test(run.status || '');
  const dbIdle = run.status === 'CASCADE_RUN_STATUS_IDLE' && (!run.updatedAt || !progress.foundAt || Date.parse(run.updatedAt) >= progress.foundAt - 2000);
  if (progress.found) {
    task.waitingOn = '';
    const done = (progress.finalReply && !dbRunning && !dbWaiting) || (Boolean(progress.output) && dbIdle) || !pid;
    return { status:done ? 'completed' : 'running', output:progress.output || task.output, error:'' };
  }
  if (!pid) return { status:'failed', undelivered:true, error:'The Antigravity window closed before it received this message.' };
  if (startupPrompt(task)) return null;
  if (task.permissions === 'terminal' && age > 8000 && !dbRunning && !dbWaiting && (task.submitRetries || 0) < 3 && Date.now() - (task.lastSubmitRetry || 0) > 6000) {
    typeIntoTerminalAsync(task.tty, '', { agent:procNames }).catch(() => {});
    task.submitRetries = (task.submitRetries || 0) + 1; task.lastSubmitRetry = Date.now();
  }
  if (age > 300000 && !startupPrompt(task)) return { status:'failed', undelivered:true, error:'Antigravity has not recorded this message after five minutes. Check the Terminal window on the Mac.' };
  return null;
}
function refreshTerminalTasks() {
  const running = tasks.filter(task => task.delivery === 'terminal' && task.status === 'running' && !task.starting);
  if (!running.length) return;
  const live = claudeLiveSessions();
  let changed = false;
  let sessionsChanged = false;
  for (const task of running) {
    if (task.harness === 'codex') {
      const before = JSON.stringify([task.transcriptFile, task.submitRetries]);
      const result = refreshCodexTerminalTask(task);
      if (before !== JSON.stringify([task.transcriptFile, task.submitRetries])) changed = true;
      if (result && (result.status !== task.status || (result.output ?? task.output) !== task.output || (result.error || '') !== task.error)) {
        Object.assign(task, { status:result.status, output:result.output ?? task.output, error:result.error || '', undelivered:Boolean(result.undelivered), updatedAt:new Date().toISOString() });
        changed = true;
      }
      continue;
    }
    if (task.harness === 'antigravity') {
      const before = JSON.stringify([task.nativeSessionId, task.transcriptFile, task.submitRetries, task.waitingOn]);
      const result = refreshAntigravityTerminalTask(task);
      if (before !== JSON.stringify([task.nativeSessionId, task.transcriptFile, task.submitRetries, task.waitingOn])) { changed = true; sessionsChanged = true; }
      if (result && (result.status !== task.status || (result.output ?? task.output) !== task.output || (result.error || '') !== task.error)) {
        Object.assign(task, { status:result.status, output:result.output ?? task.output, error:result.error || '', undelivered:Boolean(result.undelivered), updatedAt:new Date().toISOString() });
        changed = true;
        if (result.status !== 'running') sessionsChanged = true;
      }
      continue;
    }
    // A new window's session ID is only known once Claude starts and records its PID.
    if (!task.claudeSessionId) {
      const pid = pidOnTty(task.tty, 'claude');
      const record = pid && [...live].find(([, info]) => info.pid === pid);
      if (!record) {
        if (startupPrompt(task)) { changed = true; continue; }
        if (Date.now() - Date.parse(task.createdAt) > 120000) { Object.assign(task, { status:'failed', undelivered:true, error:'Claude did not start in the new Terminal window. Check that window on the Mac.', updatedAt:new Date().toISOString() }); changed = true; }
        continue;
      }
      task.claudeSessionId = record[0];
      task.sessionId = `claude:${record[0]}`;
      changed = true;
    }
    if (!task.transcriptFile) {
      task.transcriptFile = sessions(true).find(session => session.harness === 'claude' && session.nativeId === task.claudeSessionId)?.file || '';
      if (!task.transcriptFile) continue;
      changed = true;
    }
    const progress = claudeTerminalProgress(task);
    const info = live.get(task.claudeSessionId);
    let status = 'running', error = '';
    if (progress.found && (!info || (info.status === 'idle' && info.statusUpdatedAt > progress.foundAt))) status = 'completed';
    else if (!progress.found && !info) { status = 'failed'; error = 'The Claude session closed before it received this message.'; task.undelivered = true; }
    else if (!progress.found && Date.now() - Date.parse(task.createdAt) > 300000 && !startupPrompt(task)) { status = 'failed'; error = 'Claude has not recorded this message after five minutes. Check the terminal on the Mac.'; task.undelivered = true; }
    // An idle session that still has not recorded the message is most likely holding it unsent in its input box.
    else if (!progress.found && info?.status === 'idle' && task.tty && Date.now() - Date.parse(task.createdAt) > 8000 && (task.submitRetries || 0) < 3 && Date.now() - (task.lastSubmitRetry || 0) > 6000) {
      typeIntoTerminalAsync(task.tty, '', { agent:'claude' }).catch(() => {});
      task.submitRetries = (task.submitRetries || 0) + 1; task.lastSubmitRetry = Date.now(); changed = true;
    }
    const output = progress.output || task.output;
    if (status !== task.status || output !== task.output || error !== task.error) {
      Object.assign(task, { status, output, error, updatedAt:new Date().toISOString() });
      changed = true;
    }
  }
  if (changed) saveTasks();
  if (sessionsChanged) { sessions(true); broadcast('sessions', {}); }
  for (const task of running) if (task.status === 'failed' && task.undelivered && task.handoffFrom) returnToOrigin(task);
}
// Live status: every 2 seconds Shed re-reads each live agent's state (Claude's status files, Codex's transcript,
// Antigravity's DB status, and a background reading of each Terminal footer, none of which blocks) and pushes changes.
const eventClients = new Set();
function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of eventClients) {
    try { res.write(message); } catch { eventClients.delete(res); }
  }
}
setInterval(() => broadcast('ping', {}), 15000).unref();
const announcedLive = new Set();
let lastListedLive = new Set();
function refreshLiveStatus() {
  const list = sessions();
  const byId = new Map(list.map(session => [session.id, session]));
  const now = new Map();
  for (const [id, info] of claudeLiveSessions()) now.set(`claude:${id}`, claudeLiveState(info));
  for (const session of list) {
    if (session.liveState === 'history' || !session.tty) continue;
    if (session.harness === 'codex') {
      if (!pidOnTty(session.tty, 'codex')) continue;
      const screen = terminalState(session.tty, 'codex');
      now.set(session.id, screen.asking ? 'asking' : screen.active ? 'working' : codexWorkState(session.file));
    } else if (session.harness === 'antigravity') {
      if (!pidOnTty(session.tty, cliProcessNames('antigravity'))) continue;
      const screen = terminalState(session.tty, 'antigravity');
      const run = antigravityRunStatus(session.nativeId);
      const dbState = antigravityLiveState({ agStatus:run.status || session.agStatus, updatedAt:run.updatedAt || session.updatedAt }, true);
      now.set(session.id, screen.asking ? 'asking' : dbState || (screen.active ? 'working' : 'open'));
    }
  }
  // A live session that started or closed changes the list itself, so pages fetch it again.
  // Each new one is announced once (its transcript may not exist yet, so it can stay missing from the list for a while).
  const appeared = [...now.keys()].filter(id => !byId.has(id) && !announcedLive.has(id));
  appeared.forEach(id => announcedLive.add(id));
  const closed = list.some(s => (s.harness === 'claude' || (['codex', 'antigravity'].includes(s.harness) && s.tty)) && s.liveState !== 'history' && !now.has(s.id));
  // A live session whose transcript has just appeared in the list is news for open pages too.
  const listedLive = new Set(list.filter(s => now.has(s.id)).map(s => s.id));
  const newlyListed = [...listedLive].some(id => !lastListedLive.has(id));
  lastListedLive = listedLive;
  if (appeared.length || closed || newlyListed) { if (appeared.length || closed) sessions(true); return broadcast('sessions', {}); }
  const changes = [];
  for (const [id, liveState] of now) {
    const session = byId.get(id);
    if (session && session.liveState !== liveState) { session.liveState = liveState; changes.push({ id, liveState }); }
  }
  if (changes.length) broadcast('status', changes);
}
setInterval(() => { try { refreshLiveStatus(); } catch (error) { console.error(`Live status failed: ${error.message}`); } }, 2000).unref();
// Runs whether or not anyone has Shed open: keeps task progress current and sends push notifications for
// finished tasks and for agents that start waiting on a permission prompt.
const seen = { tasks:null, asking:null, at:0 };
const label = { claude:'Claude', codex:'Codex', gemini:'Gemini', pi:'Pi', opencode:'OpenCode', antigravity:'Antigravity' };
const notifyPrefs = () => ({ finished:true, asking:true, ...(settings.notify || {}) });
function firstLine(text) { return String(text || '').replace(/[#*`>_]/g, '').split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 140) || ''; }
async function watchAndNotify() {
  try { refreshQueuedTasks(); } catch (error) { console.error(`Task refresh failed: ${error.message}`); }
  syncExchanges();
  const statuses = new Map(tasks.map(t => [t.id, t.status]));
  const asking = new Set(sessions().filter(s => s.liveState === 'asking').map(s => s.id));
  const first = !seen.tasks;
  const prefs = notifyPrefs();
  if (!first && pushCount()) {
    for (const task of tasks) {
      // A task created since the last check counts as running, so one that finishes within a single interval still notifies.
      const before = seen.tasks.get(task.id) ?? (Date.parse(task.createdAt) >= seen.at ? 'running' : undefined);
      if (!['running', 'queued'].includes(before) || !['completed', 'failed'].includes(task.status) || !prefs.finished || task.exchangeKind === 'ask') continue;
      const done = task.status === 'completed';
      notify({ title:`${label[task.harness] || task.harness} ${done ? 'finished' : 'stopped'}: ${task.title}`, body:done ? firstLine(task.output) || 'Tap to see the reply.' : firstLine(task.error) || 'Tap to see what happened.', url:`/?task=${encodeURIComponent(task.id)}`, tag:`task-${task.id}` }).catch(() => {});
    }
    if (prefs.asking) for (const id of asking) {
      if (seen.asking.has(id)) continue;
      const session = sessions().find(s => s.id === id);
      notify({ title:`${label[session.harness] || session.harness} needs your OK`, body:`${projectLabel(session.cwd)}: ${session.title}`.slice(0, 160), url:`/?session=${encodeURIComponent(id)}`, tag:`ask-${id}` }).catch(() => {});
    }
  }
  seen.tasks = statuses; seen.asking = asking; seen.at = Date.now() - 1000;
}
function projectLabel(cwd) { return cwd ? path.basename(cwd) : 'A session'; }
function refreshQueuedTasks() {
  refreshTerminalTasks();
  const queued = tasks.filter(task => task.delivery === 'queue' && ['queued', 'running'].includes(task.status));
  if (!queued.length) return;
  let changed = false;
  for (const task of queued) {
    const progress = codexQueuedProgress(task);
    if (!progress) continue;
    if (task.status !== progress.status || task.output !== progress.output || task.error !== (progress.error || '')) {
      Object.assign(task, { status:progress.status, output:progress.output, error:progress.error || '', updatedAt:new Date().toISOString() });
      changed = true;
    }
  }
  if (changed) saveTasks();
}
// A model picked for an open Claude terminal: only an enabled model from Settings, and only a name safe to type after /model.
const terminalModel = id => typeof id === 'string' && /^[\w.\-\[\]]{1,80}$/.test(id) ? modelConfig('claude', settings.modelRouting).models.find(m => m.enabled && m.id === id) : null;

// Shared by sending and the drawer preview, so the preview shows exactly what a send would do.
async function planTask(input) {
  let { route, cwd, healthyHarnesses, health } = await routeInput(input);
  let modelSession = route.session;
  if (input.sessionId) {
    const origin = route.session;
    modelSession = origin;
    const currentReady = healthyHarnesses.includes(origin.harness) && available[origin.harness];
    const followup = await decideFollowup(input.prompt, origin, { mode:input.followup || 'auto', availableHarnesses:healthyHarnesses.filter(name => available[name]), currentReady, currentDetail:health[origin.harness]?.detail });
    if (followup.handoff) {
      route = { ...followup, handoffFrom:origin.id };
      cwd = origin.cwd;
      modelSession = null;
      input = { ...input, agentPrompt:handoffPrompt(origin, input.prompt), model:followup.source === 'selected' ? input.model : '' };
    } else if (origin.harness === 'antigravity' && origin.agAppOnly) {
      // Antigravity App trajectories live in ~/.gemini/antigravity, while `agy --conversation` only resumes
      // CLI trajectories in ~/.gemini/antigravity-cli. Continue in a new CLI session with its recent context.
      route = { session:null, harness:'antigravity', handoff:true, handoffFrom:origin.id, reason:'Continuing this Antigravity App conversation in a new Antigravity CLI session with its recent context', source:'selected' };
      cwd = origin.cwd;
      input = { ...input, agentPrompt:handoffPrompt(origin, input.prompt) };
    } else route = { ...followup, session:origin };
  }
  const selectedHarness = route.session?.harness || route.harness;
  const model = selectedHarness === 'codex' && route.session?.liveState !== 'history' && route.session && !route.session.tty
    ? { model:'', reason:'The open Codex session keeps its current model.', source:'session' }
    : selectedHarness === 'claude' && route.session?.tty && terminalModel(input.model)
    ? { model:input.model, reason:`Switches the open terminal to ${terminalModel(input.model).label || input.model} with /model, then types your message.`, source:'selected' }
    : ['claude', 'codex', 'antigravity'].includes(selectedHarness) && route.session?.tty
    ? { model:'', reason:'Typed into the open terminal, so the session keeps its own model and permissions.', source:'session' }
    : await decideModel(input.prompt, selectedHarness, modelConfig(selectedHarness, settings.modelRouting), { override:input.model || '', session:modelSession });
  return { input, route, cwd, model };
}

const FILLER = new Set(['a', 'an', 'the', 'to', 'for', 'my', 'me', 'of', 'and', 'in', 'on', 'with', 'please', 'can', 'you', 'i', 'it', 'this', 'that', 'is', 'are', 'be', 'some', 'our', 'we', 'us', 'hey', 'hi', 'could', 'would', 'should', 'let', 'lets']);
function autoWorkspace(prompt, preview) {
  const words = String(prompt || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w && !FILLER.has(w));
  const slug = words.slice(0, 4).join('-').replace(/-+/g, '-').slice(0, 40).replace(/^-|-$/g, '') || 'session';
  const root = path.join(os.homedir(), 'Shed Workspaces');
  let name = slug;
  for (let n = 2; fs.existsSync(path.join(root, name)); n++) name = `${slug}-${n}`;
  const folder = path.join(root, name);
  if (!preview) fs.mkdirSync(folder, { recursive:true });
  return folder;
}
async function routeInput(input, preview = false) {
  const cachedHealth = harnessHealth();
  const health = Object.keys(cachedHealth || {}).length ? cachedHealth : await checkHealth();
  if (Object.keys(cachedHealth || {}).length) checkHealth().catch(() => {});
  const healthyHarnesses = Object.entries(health).filter(([, status]) => status.state === 'ready').map(([name]) => name);
  if (input.harness && input.harness !== 'auto' && !healthyHarnesses.includes(input.harness)) throw new Error(health[input.harness]?.detail || `${input.harness} is not ready.`);
  const chosen = input.harness && input.harness !== 'auto';
  const pickable = chosen ? healthyHarnesses : routableHarnesses(healthyHarnesses, autoRoutePrefs(settings.autoRoute, harnesses));
  const all = sessions();
  let requestedCwd = typeof input.cwd === 'string' && all.some(s => s.cwd === input.cwd) ? input.cwd : '';
  if (input.newWorkspace) {
    const name = String(input.newWorkspace).trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,59}$/.test(name) || name === '.' || name === '..') throw new Error('Workspace names must be 1–60 letters, numbers, spaces, dots, dashes, or underscores.');
    const workspaceRoot = path.join(os.homedir(), 'Shed Workspaces');
    requestedCwd = path.join(workspaceRoot, name);
    if (!preview) fs.mkdirSync(requestedCwd, { recursive:true });
  }
  // A new session with no project gets a folder of its own, named from the message, never Shed's own code folder.
  if (!requestedCwd && !input.sessionId && input.newSession) requestedCwd = autoWorkspace(input.prompt, preview);
  const candidates = input.newSession ? [] : all.filter(s => s.liveState !== 'working' && !s.hidden && (!requestedCwd || s.cwd === requestedCwd) && (s.harness !== 'gemini' || Boolean(s.cwd)) && (chosen ? s.harness === input.harness : pickable.includes(s.harness)));
  const fallback = chosen ? input.harness : pickable[0];
  if (!fallback && !input.sessionId) throw new Error(healthyHarnesses.length ? 'Every ready harness is switched off for Laya. Pick one, or turn one back on in Settings.' : 'No coding harness is ready. Check the harness status in the sidebar.');
  // The task planner checks follow-up health and permits only explicit handoffs.
  if (input.sessionId && preview) {
    const selected = all.find(s => s.id === input.sessionId);
    if (selected && !healthyHarnesses.includes(selected.harness)) throw new Error(health[selected.harness]?.detail || `${selected.harness} is not ready.`);
  }
  const route = await decideRoute(input.prompt, input.sessionId ? all : candidates, input.harness || 'auto', input.sessionId || null, { preview, availableHarnesses:pickable });
  if (!route.session && route.source !== 'laya') route.harness = fallback;
  return { route, cwd: requestedCwd, healthyHarnesses, health };
}
// The version of the web app being served (a hash of public/). Every response carries it, so an open page, such as
// a Home Screen app that resumes without reloading, can tell that Shed was updated and reload itself.
const appVersion = (() => {
  const hash = crypto.createHash('sha1');
  for (const name of fs.readdirSync(publicDir).sort()) { const file = path.join(publicDir, name); if (fs.statSync(file).isFile()) hash.update(name).update(fs.readFileSync(file)); }
  return hash.digest('base64url').slice(0, 12);
})();
// Sent with every response: no framing (stops tap-jacking of approve buttons), no referrer leaks, scripts only from Shed.
const SECURITY_HEADERS = {
  'X-Shed-Version':appVersion,
  'X-Frame-Options':'DENY',
  'Referrer-Policy':'no-referrer',
  'X-Content-Type-Options':'nosniff',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
};
// Polled data carries a short version tag. When the page already has that version, the reply is just {"same":true},
// so a phone re-downloads and re-renders only what changed.
const versionOf = body => crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16);
function sendVersioned(req, res, value) {
  const body = JSON.stringify(value);
  const v = versionOf(body);
  if (new URL(req.url, 'http://x').searchParams.get('v') === v) return send(res, 200, { same:true, v });
  writeJson(res, 200, `${body.slice(0, -1)},"v":"${v}"}`);
}
// Large answers are compressed here, on the Mac: a home connection's upload speed, not the server, is what limits a
// phone on the tunnel. Brotli at a low quality costs ~1 ms for the 160 KB session list and makes it ~10× smaller.
function compressFor(req, text) {
  const accepts = String(req?.headers['accept-encoding'] || '');
  if (text.length < 2048) return null;
  if (/\bbr\b/.test(accepts)) return { encoding:'br', data:zlib.brotliCompressSync(text, { params:{ [zlib.constants.BROTLI_PARAM_QUALITY]:4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]:Buffer.byteLength(text) } }) };
  if (/\bgzip\b/.test(accepts)) return { encoding:'gzip', data:zlib.gzipSync(text, { level:4 }) };
  return null;
}
function writeJson(res, status, text, headers = {}) {
  const packed = compressFor(res.req, text);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', Vary:'Accept-Encoding', ...headers, ...(packed ? { 'Content-Encoding':packed.encoding } : {}) });
  res.end(packed ? packed.data : text);
}
// Lists only need what a row shows; the full task (reply text and all) loads when one is opened.
const taskSummary = t => ({ id:t.id, title:t.title, status:t.status, harness:t.harness, mode:t.mode || 'build', sessionId:t.sessionId, cwd:t.cwd, createdAt:t.createdAt, updatedAt:t.updatedAt, delivery:t.delivery, tty:t.tty, waitingOn:t.waitingOn, handoffFrom:t.handoffFrom, returnedTo:t.returnedTo, model:t.model, modelSource:t.modelSource, routeSource:t.routeSource, error:(t.error || '').slice(0, 300) });
const publicTask = ({ agentPrompt, transcriptFile, transcriptOffset, claudeSessionId, nativeSessionId, submitRetries, lastSubmitRetry, waitNotified, ...rest }) => rest;
function sendText(res, status, text) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type':'text/plain; charset=utf-8', 'Cache-Control':'no-store' });
  res.end(text);
}
function send(res, status, value, headers = {}) {
  writeJson(res, status, JSON.stringify(value), headers);
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=').map(decodeURIComponent)).filter(x => x.length === 2));
}
// Devices: every browser that signs in gets its own random session key (stored only as a hash), so one device can be
// signed out without touching the others. A device signing in from outside the Mac must be approved on the Mac, or
// carry a one-time pairing code from the QR code shown on the Mac.
const SESSION_IDLE_MS = 30 * 24 * 3600 * 1000;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const devices = () => (settings.devices ||= []);
const pairingCodes = new Map(); // QR token -> expiry time; single use
const shortPairingCodes = new Map(); // 6-digit code -> expiry time; single use
const PAIRING_TTL_MS = 10 * 60 * 1000;
function prunePairingCodes() {
  const now = Date.now();
  for (const [code, expires] of pairingCodes) if (expires < now) pairingCodes.delete(code);
  for (const [code, expires] of shortPairingCodes) if (expires < now) shortPairingCodes.delete(code);
}
function newPairingCode() {
  prunePairingCodes();
  const code = crypto.randomBytes(18).toString('base64url');
  pairingCodes.set(code, Date.now() + PAIRING_TTL_MS);
  return code;
}
function newShortPairingCode() {
  prunePairingCodes();
  const digits = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  shortPairingCodes.set(digits, Date.now() + PAIRING_TTL_MS);
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}
function usePairingCode(code) {
  if (typeof code !== 'string') return false;
  const trimmed = code.trim();
  if (!trimmed) return false;
  if (pairingCodes.has(trimmed)) {
    const valid = pairingCodes.get(trimmed) > Date.now();
    pairingCodes.delete(trimmed);
    return valid;
  }
  const digits = trimmed.replace(/[\s-]+/g, '');
  if (/^\d{6}$/.test(digits) && shortPairingCodes.has(digits)) {
    const valid = shortPairingCodes.get(digits) > Date.now();
    shortPairingCodes.delete(digits);
    return valid;
  }
  return false;
}
function deviceName(req) {
  const ua = String(req.headers['user-agent'] || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Browser';
  const app = /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'browser';
  return `${os} · ${app}`;
}
function createDevice(req, status) {
  const key = crypto.randomBytes(32).toString('base64url');
  const device = { id:crypto.randomUUID(), hash:sha256(key), name:deviceName(req), status, createdAt:new Date().toISOString(), lastSeenAt:new Date().toISOString(), lastIp:clientIp(req), local:isDirectLocal(req) };
  settings = { ...settings, devices:[...devices().filter(d => Date.now() - Date.parse(d.lastSeenAt) < SESSION_IDLE_MS), device] };
  saveSettings();
  return { device, key };
}
function sessionCookie(req, key, maxAge = SESSION_IDLE_MS / 1000) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  return `shed_session=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function deviceFor(req) {
  const key = cookies(req).shed_session;
  if (!key) return null;
  const hash = sha256(key);
  const device = devices().find(d => d.hash === hash);
  if (!device || Date.now() - Date.parse(device.lastSeenAt) > SESSION_IDLE_MS) return null;
  return device;
}
function isAuthorized(req) {
  // The master token (and the old shared cookie that carried it) only works typed on this Mac, never through the tunnel.
  const legacy = cookies(req).laya_auth || cookies(req).jev_auth || (req.headers.authorization || '').replace(/^Bearer /i, '');
  if (legacy && isDirectLocal(req) && legacy.length === token.length && crypto.timingSafeEqual(Buffer.from(legacy), Buffer.from(token))) return true;
  const device = deviceFor(req);
  if (!device || device.status !== 'approved') return false;
  if (Date.now() - Date.parse(device.lastSeenAt) > 5 * 60 * 1000 || device.lastIp !== clientIp(req)) { device.lastSeenAt = new Date().toISOString(); device.lastIp = clientIp(req); saveSettings(); }
  return true;
}
const publicDevice = (d, current) => ({ id:d.id, name:d.name, status:d.status, createdAt:d.createdAt, lastSeenAt:d.lastSeenAt, lastIp:d.lastIp, local:Boolean(d.local), current:d.id === current?.id });
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64 * 1024) throw new Error('Request is too large.');
  }
  try { return data ? JSON.parse(data) : {}; } catch { throw new Error('Invalid JSON.'); }
}
// A cross-harness handoff cannot resume natively, so the new agent gets the recent transcript as context.
function handoffPrompt(session, prompt) {
  const lines = [];
  let budget = 12000;
  for (const message of sessionMessages(session).slice(-16).reverse()) {
    const text = message.text.slice(0, 2000);
    if (budget - text.length < 0) break;
    budget -= text.length;
    lines.unshift(`[${message.role === 'user' ? 'user' : session.harness}] ${text}`);
  }
  const changes = uncommittedChanges(session.cwd);
  return [
    `You are continuing work that began in a ${session.harness} session${session.currentModel ? ` using ${session.currentModel}` : ''} in this project.`,
    `Session topic: ${session.title}`,
    lines.length ? `Recent conversation:\n${lines.join('\n\n')}` : 'The earlier transcript is unavailable.',
    // The summary above is partial; the full record lets the new agent look up anything it needs.
    session.file ? `The complete earlier transcript (JSON Lines, one event per line) is at:\n${session.file}\nRead it if you need details that are not above, such as commands run, files read or earlier decisions.` : '',
    changes ? `Uncommitted changes in the project right now:\n${changes}` : '',
    `New request:\n${prompt.trim()}`,
  ].filter(Boolean).join('\n\n');
}
// A short `git status` plus diff summary, so a handoff knows what the earlier agent changed but did not commit.
function uncommittedChanges(cwd) {
  if (!cwd || !fs.existsSync(path.join(cwd, '.git'))) return '';
  const run = args => spawnSync('git', args, { cwd, encoding:'utf8', timeout:4000, maxBuffer:1024 * 1024 }).stdout || '';
  const status = run(['status', '--short']).trim();
  if (!status) return '';
  const stat = run(['diff', '--stat', 'HEAD']).trim().split('\n').slice(-25).join('\n');
  return [status.split('\n').slice(0, 40).join('\n'), stat].filter(Boolean).join('\n\n').slice(0, 3000);
}
// A handoff whose new window never took the message goes back to the original session, so the message is never lost.
async function returnToOrigin(task) {
  if (!task.handoffFrom || task.returnedTo || task.returnedAt) return;
  task.returnedAt = new Date().toISOString(); saveTasks();
  try {
    const { input, route, cwd, model } = await planTask({ prompt:task.prompt, attachmentPaths:task.attachments || [], sessionId:task.handoffFrom, followup:'stay', harness:'auto', model:'', newSession:false });
    const back = startTask(input, route, model, cwd);
    Object.assign(task, { returnedTo:back.id, error:`${task.error} Shed sent your message back to the original ${back.harness} session instead.`.trim() }); saveTasks();
    notify({ title:`Handoff to ${label[task.harness] || task.harness} did not start`, body:`Your message went back to the original ${label[back.harness] || back.harness} session.`, url:`/?task=${encodeURIComponent(back.id)}`, tag:`task-${task.id}` }).catch(() => {});
  } catch (error) {
    Object.assign(task, { error:`${task.error} Shed could not send it back to the original session either: ${error.message}`.trim() }); saveTasks();
  }
}
// Ending a session: the agent process that holds it (in its Terminal tab, or a background run Shed started).
// The Terminal window stays open at its shell prompt, so the person can still read what happened.
function endTarget(session) {
  if (!session || session.liveState === 'history') return null;
  if (session.harness === 'claude') {
    const pid = claudeLiveSessions().get(session.nativeId)?.pid;
    if (pid) return { pid, command:'claude' };
  }
  if (session.harness === 'codex' && session.tty) {
    const pid = pidOnTty(session.tty, 'codex');
    if (pid) return { pid, command:'codex', codexThread:session.nativeId };
  }
  // Open in the Codex desktop app: no process of its own, so Shed asks the Codex app to stop the running turn.
  if (session.harness === 'codex' && !session.tty) return { codexThread:session.nativeId };
  if (session.harness === 'antigravity' && session.tty) {
    const command = cliProcessNames('antigravity');
    const pid = pidOnTty(session.tty, command);
    if (pid) return { pid, command };
  }
  const task = tasks.find(t => t.sessionId === session.id && active.has(t.id));
  return task ? { task } : null;
}
function cancelSessionTasks(sessionId, error) {
  let changed = false;
  for (const task of tasks) if (task.sessionId === sessionId && ['running', 'queued', 'cancelling'].includes(task.status) && task.delivery !== 'queue') {
    Object.assign(task, { status:'cancelled', error, updatedAt:new Date().toISOString() }); changed = true;
  }
  if (changed) saveTasks();
}
async function endAgent(target) {
  // Codex in Terminal runs its turn in the shared Codex daemon: stop the turn there first, then end the process.
  if (target.codexThread && target.pid) {
    await interruptCodexThread(target.codexThread).catch(() => {});
    return stopAgent(target.pid, target.command);
  }
  if (target.codexThread) {
    const { interrupted, commandsStopped } = await interruptCodexThread(target.codexThread);
    return { stopped:true, forced:false, mode:interrupted || commandsStopped ? 'interrupted' : 'idle' };
  }
  if (target.task) {
    updateTask(target.task, { status:'cancelling' });
    active.get(target.task.id)?.kill('SIGTERM');
    return { stopped:true, forced:false };
  }
  return stopAgent(target.pid, target.command);
}
// Auto-close: every 10 minutes, live Terminal sessions with no activity for settings.autoClose.hours (12 by default)
// are ended the same way as "End session", then their Terminal tab is closed. They stay in the list and can be resumed.
let autoClosing = false;
async function autoCloseIdle() {
  const prefs = autoClosePrefs(settings.autoClose);
  if (!prefs.enabled || autoClosing) return;
  autoClosing = true;
  try {
    const claudeLive = claudeLiveSessions();
    const idle = idleSessions(sessions(true), { hours:prefs.hours, tasks, statusOf:s => s.harness === 'claude' ? claudeLive.get(s.nativeId)?.statusUpdatedAt || 0 : 0 });
    for (const session of idle) {
      const target = endTarget(session);
      if (!target?.pid) continue;
      const result = await endAgent(target).catch(error => ({ stopped:false, error }));
      if (!result.stopped) { console.error(`Auto-close: ${session.id} did not stop${result.error ? `: ${result.error.message}` : ''}`); continue; }
      cancelSessionTasks(session.id, `Closed after ${prefs.hours} hours without activity.`);
      const tab = await closeTerminalTab(session.tty).catch(error => ({ closed:false, reason:error.message }));
      console.log(`Auto-close: ended ${session.id} (${projectLabel(session.cwd)}), idle over ${prefs.hours}h; tab ${tab.closed ? 'closed' : `left open (${tab.reason})`}.`);
    }
    if (idle.length) { sessions(true); broadcast('sessions', {}); }
  } finally { autoClosing = false; }
}
// Sessions talking to each other. An agent runs `shed ask`; Shed finds which session it is from the command's parent
// processes, then sends the message to the other session as a task, whose reply goes back to the asking agent.
const TALKERS = ['claude', 'codex'];
function syncExchanges() { if (exchanges.sync(id => tasks.find(t => t.id === id))) broadcast('exchanges', {}); }
function syncComparisons() { const list = sessions(); if (comparisons.sync(id => tasks.find(t => t.id === id), id => list.find(s => s.id === id))) broadcast('comparisons', {}); }
// Automatically dispatches the next queued follow-up for any session that has become idle.
const drainingSessions = new Set();
async function drainQueue(targetSessionId = '') {
  const ids = targetSessionId ? [targetSessionId] : queue.sessionsWithQueued();
  if (!ids.length) return;
  const list = sessions();
  for (const sid of ids) {
    if (drainingSessions.has(sid)) continue;
    const session = list.find(s => s.id === sid);
    if (!session) continue;
    const busyProcess = [...active.values()].some(child => child.layaSessionId === sid);
    const busyTask = tasks.some(t => t.sessionId === sid && ['running', 'queued', 'cancelling'].includes(t.status));
    if (busyProcess || busyTask || session.liveState === 'working' || session.liveState === 'asking') continue;
    const next = queue.takeNext(sid);
    if (!next) continue;
    drainingSessions.add(sid);
    try {
      const { input:planned, route, cwd, model } = await planTask({
        prompt: next.prompt, mode: next.mode, harness: 'auto', model: next.model || '',
        sessionId: sid, followup: next.followup || 'stay', newSession: false,
        attachments: next.attachments || [], attachmentPaths: [], skipPermissions: Boolean(next.skipPermissions),
      });
      const targetCwd = route.session?.cwd || cwd;
      if (next.mode !== 'plan' && targetCwd) {
        const cp = await captureCheckpoint(targetCwd, { sessionId:sid, label:`Before: ${titleFor(next.prompt)}`, kind:'pre-turn' }).catch(() => null);
        if (cp) checkpoints.add(cp);
      }
      const task = startTask({ ...planned, mode:next.mode }, route, model, cwd);
      if (active.has(task.id)) active.get(task.id).layaSessionId = sid;
      broadcast('queue', { sessionId:sid });
      broadcast('sessions', {});
    } catch (error) {
      console.error(`Queue dispatch failed for ${sid}: ${error.message}`);
    } finally {
      drainingSessions.delete(sid);
    }
  }
}
function recordPostTurnCheckpoint(task) {
  if (!task || task.mode === 'plan' || task.status !== 'completed' || !task.cwd || task.postCheckpointRecorded) return;
  task.postCheckpointRecorded = true;
  if (task.sessionId) checkpoints.attachSession(task.id, task.sessionId);
  captureCheckpoint(task.cwd, { sessionId:task.sessionId || '', taskId:task.id, label:`After: ${task.title}`, kind:'post-turn' })
    .then(cp => { if (cp) checkpoints.add(cp); })
    .catch(() => {});
}
function parentOf(pid) {
  const result = spawnSync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding:'utf8', timeout:2000 });
  const match = (result.stdout || '').trim().match(/^(\d+)\s+(.+)$/);
  return match ? { ppid:Number(match[1]), command:path.basename(match[2]) } : null;
}
function callerSession(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const list = sessions();
  const claudeByPid = new Map([...claudeLiveSessions()].map(([id, info]) => [info.pid, id]));
  for (let current = pid, hops = 0; current > 1 && hops < 20; hops++) {
    if (claudeByPid.has(current)) return list.find(s => s.id === `claude:${claudeByPid.get(current)}`) || null;
    const info = parentOf(current);
    if (!info) return null;
    if (info.command === 'codex') {
      const tty = ttyOf(current);
      const session = tty && list.find(s => s.harness === 'codex' && s.tty === tty);
      if (session) return session;
    }
    current = info.ppid;
  }
  return null;
}
async function sendExchange({ kind, from, to, message, prompt, agentPrompt, target, depth = 0 }) {
  const { input, route, cwd, model } = await planTask({ prompt, agentPrompt, sessionId:target.id, followup:'stay', harness:'auto', model:'', newSession:false });
  const task = startTask({ ...input, agentPrompt }, route, model, cwd);
  Object.assign(task, { exchangeKind:kind }); saveTasks();
  const exchange = exchanges.add({ id:crypto.randomUUID().slice(0, 8), kind, from:from.id, to:to.id, message, taskId:task.id, depth, status:'sending', createdAt:new Date().toISOString() });
  task.exchangeId = exchange.id; saveTasks();
  broadcast('exchanges', {});
  return { exchange, task };
}
const sessionState = s => s.liveState === 'working' ? 'working' : s.liveState === 'asking' ? 'waiting for its person to answer a question' : 'open, idle';
async function agentRoute(req, res, pathname) {
  if (pathname === '/api/agent/sessions' && req.method === 'POST') {
    const input = await body(req);
    const me = callerSession(Number(input.pid));
    const list = sessions(true).filter(s => s.liveState !== 'history' && TALKERS.includes(s.harness));
    return send(res, 200, { sessions:list.map(s => ({ id:s.id, you:s.id === me?.id, label:label[s.harness] || s.harness, project:projectLabel(s.cwd), title:s.title, state:sessionState(s) })) });
  }
  if (pathname === '/api/agent/ask' && req.method === 'POST') {
    const input = await body(req);
    const message = typeof input.message === 'string' ? input.message.trim().slice(0, 20000) : '';
    if (!message) return send(res, 400, { error:'Say what to send.' });
    const list = sessions(true);
    const from = callerSession(Number(input.pid)), to = list.find(s => s.id === input.to);
    const open = exchanges.open();
    const why = refusal({ from, to, open, recent:from ? exchanges.sentWithin(from.id, 3600000) : 0 }) || (TALKERS.includes(to.harness) ? '' : 'Only Claude and Codex sessions can take messages for now.');
    if (why) return send(res, 409, { error:why });
    const { exchange } = await sendExchange({ kind:'ask', from, to, message, prompt:`↔ From ${label[from.harness] || from.harness} · ${projectLabel(from.cwd)}: ${message}`, agentPrompt:messagePrompt(from, message, shedCli), target:to, depth:depthFor(from.id, open) });
    return send(res, 201, { exchange:{ id:exchange.id, toLabel:describe(to) } });
  }
  const match = pathname.match(/^\/api\/agent\/exchanges\/([\w-]{1,40})$/);
  if (match && req.method === 'GET') {
    refreshQueuedTasks(); syncExchanges();
    const exchange = exchanges.get(match[1]);
    if (!exchange) return send(res, 404, { error:'There is no exchange with that id.' });
    const to = sessions().find(s => s.id === exchange.to);
    return send(res, 200, { exchange:{ id:exchange.id, status:exchange.status, reply:exchange.reply || '', error:exchange.error || '', toLabel:to ? describe(to) : 'the other session' } });
  }
  return send(res, 404, { error:'Unknown command.' });
}
function transcriptSize(file) { try { return fs.statSync(file).size; } catch { return 0; } }
function titleFor(prompt) { return prompt.replace(/\s+/g, ' ').trim().slice(0, 90); }
function updateTask(task, patch) { Object.assign(task, patch); saveTasks(); }

function queueCodexTask(task, session) {
  Object.assign(task, { status:'queued', delivery:'queue', transcriptFile:session.file, model:'', modelReason:'The open Codex session keeps its current model.', modelSource:'session', error:'', output:'Waiting for the open Codex session to accept this message.', updatedAt:new Date().toISOString() });
  saveTasks();
  const child = spawn('codex', ['queue', '--thread', session.nativeId, '--message', task.agentPrompt || task.prompt], { cwd:task.cwd, env:{ ...process.env, NO_COLOR:'1' }, stdio:['ignore', 'pipe', 'pipe'] });
  active.set(task.id, child);
  let result = '';
  child.stdout.on('data', chunk => { result += chunk.toString(); });
  child.stderr.on('data', chunk => { task.error = (task.error + chunk.toString()).slice(-12000); saveTasks(); });
  child.on('error', error => { updateTask(task, { status:'failed', error:error.message, updatedAt:new Date().toISOString() }); active.delete(task.id); });
  child.on('close', code => {
    active.delete(task.id);
    if (task.status === 'failed') return;
    if (code !== 0) updateTask(task, { status:'failed', error:task.error || result.trim() || 'Codex could not queue this message.', updatedAt:new Date().toISOString() });
    else {
      if (task.status === 'queued') task.output = result.trim() || 'Queued for this Codex session.';
      task.error = '';
      saveTasks();
      refreshQueuedTasks();
    }
  });
}

// Sign-in runs each CLI's own login flow in a Terminal window on the Mac; the drawer mirrors it so it can be followed from a phone.
const CONTROL_KEYS = ['\u0003', '\u001b[Z', '1', '2', '3', 'y', 'n', ''];
const loginCommands = { codex:['codex', 'login'], claude:['claude', 'auth', 'login'], gemini:['gemini'], opencode:['opencode', 'auth', 'login'], pi:['pi'], antigravity:['agy'] };
const loginTerminals = new Map();
// A terminal reading for the phone: the screen text plus, when the agent is asking, the options it offers.
function terminalReading(tty, text) { return { tty, text, menu:parseMenu(text.split('\n').slice(-40).join('\n')) }; }
// Choosing an option: the screen is read again and the option must still be there with the same text, so a tap made
// while the question changed cannot land on something else. The pointer moves with arrow keys, then Return chooses.
async function chooseOption(tty, input) {
  const index = Number(input.option);
  const menu = parseMenu(((await readTerminalAsync(tty, 40)) || '').split('\n').slice(-40).join('\n'));
  if (!menu || !Number.isInteger(index) || menu.options[index] !== input.label) return { status:409, error:'The question on the Mac has changed. Look at the terminal again, then choose.' };
  await typeIntoTerminalAsync(tty, keysToChoose(menu, index));
  return { status:200 };
}

// Claude, Codex and Antigravity run in a visible Terminal: typed into the tab that already holds the session, or a new window that resumes it.
const QUESTION_ON_SCREEN = /Do you want to|Esc to cancel|Enter to confirm|enter Confirm|enter Toggle|Allow .*\?|\(y\/n\)|\[y\/n\]|Terms of Service|Choose your color scheme|❯\s*1\.|›\s*1\.\s|Would you like to|Press enter to confirm|trust this folder/i;
// The request returns as soon as the task exists; typing into Terminal (about a second of AppleScript and a pause)
// runs in the background, so sending feels instant and the server keeps answering other requests meanwhile.
function startTerminalTask(task, route, modelDecision, cwd, agentPrompt, skipPermissions) {
  Object.assign(task, { delivery:'terminal', agentPrompt, starting:true, output:'Sending to the terminal…' });
  saveTasks();
  deliverToTerminal(task, route, modelDecision, cwd, agentPrompt, skipPermissions).finally(() => { delete task.starting; saveTasks(); });
}
async function deliverToTerminal(task, route, modelDecision, cwd, agentPrompt, skipPermissions) {
  const session = route.session;
  const harnessName = label[task.harness] || task.harness;
  const procNames = cliProcessNames(task.harness);
  try {
    // Only type into a session's window while the agent is still running there; otherwise resume it in a new window.
    if (session?.tty && agentInForeground(session.tty, procNames)) {
      Object.assign(task, { tty:session.tty });
      // Never type a message while the agent shows a question: the Return would pick whatever option is highlighted
      // (for example "No, exit" on a folder-trust question).
      if (QUESTION_ON_SCREEN.test(await readTerminalAsync(session.tty, 14) || '')) throw new Error(`${harnessName} is waiting for an answer in its Terminal. Answer it from the Terminal tab first, then send your message again.`);
      // A model picked in the drawer: Claude switches with /model first, and the message follows once it's done.
      if (task.harness === 'claude' && modelDecision.source === 'selected' && terminalModel(modelDecision.model)) {
        await typeIntoTerminalAsync(session.tty, `/model ${modelDecision.model}`, { prompt:true, agent:'claude' });
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (QUESTION_ON_SCREEN.test(await readTerminalAsync(session.tty, 14) || '')) throw new Error(`Claude asked something after /model ${modelDecision.model}. Answer it from the Terminal tab, then send your message again.`);
      }
      // Where the transcript ends now: Shed looks for the message (and the reply) from here on.
      const transcriptFile = session.file || (task.harness === 'antigravity' ? antigravityCliTranscriptPath(session.nativeId) : '');
      task.transcriptOffset = transcriptSize(transcriptFile);
      await typeIntoTerminalAsync(session.tty, agentPrompt, { prompt:true, agent:procNames });
      Object.assign(task, { tty:session.tty, transcriptFile, [task.harness === 'claude' ? 'claudeSessionId' : 'nativeSessionId']:session.nativeId, permissions:'terminal', output:`Typed into the open Terminal tab. Waiting for ${harnessName} to pick it up.` });
    } else if (task.harness === 'codex') {
      const promptDir = path.join(dataDir, 'prompts');
      fs.mkdirSync(promptDir, { recursive:true, mode:0o700 });
      const promptFile = path.join(promptDir, `${task.id}.txt`);
      fs.writeFileSync(promptFile, agentPrompt, { mode:0o600 });
      // --no-alt-screen keeps Codex's output in Terminal's scrollback, which is what the drawer's terminal view reads.
      const argv = ['codex', ...(session ? ['resume', session.nativeId] : []), '--no-alt-screen', ...(modelDecision.model ? ['--model', modelDecision.model] : []), ...(skipPermissions ? ['--dangerously-bypass-approvals-and-sandbox'] : [])];
      trustShedWorkspace(task.harness, cwd);
      const tty = await openTerminalAsync(cwd, argv, promptFile);
      Object.assign(task, { tty, permissions:skipPermissions ? 'skip' : 'default', ...(session ? { transcriptFile:session.file, nativeSessionId:session.nativeId } : {}), output:`Opened a new Terminal window on the Mac (${tty.replace('/dev/', '')}).${skipPermissions ? '' : ' Codex will ask there before running commands; answer from the Terminal view.'}` });
    } else if (task.harness === 'antigravity') {
      const promptDir = path.join(dataDir, 'prompts');
      fs.mkdirSync(promptDir, { recursive:true, mode:0o700 });
      const promptFile = path.join(promptDir, `${task.id}.txt`);
      fs.writeFileSync(promptFile, agentPrompt, { mode:0o600 });
      const transcriptFile = session ? session.file || antigravityCliTranscriptPath(session.nativeId) : '';
      if (session) task.transcriptOffset = transcriptSize(transcriptFile);
      // altScreenMode:"never" keeps Antigravity's TUI in Terminal's scrollback for Shed's Terminal view, and -i keeps the session open after responding.
      const argv = ['agy', ...(session ? ['--conversation', session.nativeId] : []), '--settings', '{"altScreenMode":"never"}', ...(modelDecision.model ? ['--model', modelDecision.model] : []), ...(skipPermissions ? ['--dangerously-skip-permissions'] : []), '-i'];
      trustShedWorkspace(task.harness, cwd);
      const tty = await openTerminalAsync(cwd, argv, promptFile);
      Object.assign(task, { tty, permissions:skipPermissions ? 'skip' : 'default', ...(session ? { transcriptFile, nativeSessionId:session.nativeId } : {}), output:`Opened a new Terminal window on the Mac (${tty.replace('/dev/', '')}).${skipPermissions ? '' : ' Antigravity will ask there before running commands; answer from the Terminal view.'}` });
    } else {
      const promptDir = path.join(dataDir, 'prompts');
      fs.mkdirSync(promptDir, { recursive:true, mode:0o700 });
      const promptFile = path.join(promptDir, `${task.id}.txt`);
      fs.writeFileSync(promptFile, agentPrompt, { mode:0o600 });
      if (session) task.transcriptOffset = transcriptSize(session.file);
      const argv = ['claude', ...(session ? ['--resume', session.nativeId] : []), ...(modelDecision.model ? ['--model', modelDecision.model] : []), ...(skipPermissions ? ['--dangerously-skip-permissions'] : ['--allow-dangerously-skip-permissions'])];
      trustShedWorkspace(task.harness, cwd);
      const tty = await openTerminalAsync(cwd, argv, promptFile);
      Object.assign(task, { tty, permissions:skipPermissions ? 'skip' : 'default', output:`Opened a new Terminal window on the Mac (${tty.replace('/dev/', '')}).${skipPermissions ? '' : ' Claude will ask there before using tools; answer from the Terminal view.'}` });
    }
    task.updatedAt = new Date().toISOString();
    saveTasks();
  } catch (error) {
    updateTask(task, { status:'failed', error:error.message, updatedAt:new Date().toISOString() });
  }
}

function startTask(input, route, modelDecision, requestedCwd = '') {
  const mode = input.mode === 'plan' ? 'plan' : 'build';
  let agentPrompt = (input.agentPrompt || input.prompt).trim();
  if (mode === 'plan' && !input.agentPrompt) agentPrompt = planModePrompt(agentPrompt);
  const harness = route.session?.harness || route.harness;
  if (!available[harness]) throw new Error(`${harness} CLI is not installed on this desktop.`);
  if (harness === 'gemini' && route.session && !route.session.cwd && !requestedCwd) throw new Error('This Gemini record does not include its original project path, so it cannot be resumed safely.');
  const cwd = route.session?.cwd && fs.existsSync(route.session.cwd) ? route.session.cwd :
    requestedCwd && fs.existsSync(requestedCwd) && fs.statSync(requestedCwd).isDirectory() ? requestedCwd : root;
  // Attached files move into the project, and the agent is told where they are.
  const attachments = [...(input.attachmentPaths || []), ...uploads.place(input.attachments || [], cwd === root ? '' : cwd)];
  agentPrompt += attachmentNote(attachments);
  const task = {
    id: crypto.randomUUID(), prompt: input.prompt.trim(), title: titleFor(input.prompt), mode,
    status: 'running', harness, sessionId: route.session?.id || null,
    handoffFrom: route.handoffFrom || null,
    routeReason: route.reason, routeSource: route.source || 'local', routeFallbackReason:route.fallbackReason || '',
    model:modelDecision.model, modelReason:modelDecision.reason, modelSource:modelDecision.source, modelFallbackReason:modelDecision.fallbackReason || '', cwd, output: '', error: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...(attachments.length ? { attachments, agentPrompt } : {}),
  };
  tasks.unshift(task); saveTasks();
  // Codex open in the desktop app (no terminal) takes queued messages; everything else runs in a visible Terminal.
  if (harness === 'codex' && route.session && !route.session.tty && route.session.liveState !== 'history') {
    queueCodexTask(task, route.session);
    return task;
  }
  if ((harness === 'claude' && process.env.LAYA_HEADLESS_CLAUDE !== '1') || (harness === 'codex' && process.env.LAYA_HEADLESS_CODEX !== '1') || (harness === 'antigravity' && process.env.LAYA_HEADLESS_ANTIGRAVITY !== '1')) {
    startTerminalTask(task, route, modelDecision, cwd, agentPrompt, Boolean(input.skipPermissions));
    return task;
  }
  let command = cliCommand(harness);
  const modelArgs = modelDecision.model ? ['--model', modelDecision.model] : [];
  function buildArgs(resumeSession, promptText) {
    if (harness === 'codex') return resumeSession ? ['exec', 'resume', '--json', '--skip-git-repo-check', ...modelArgs, resumeSession.nativeId, '-'] : ['exec', '--json', '--skip-git-repo-check', ...modelArgs, '-C', cwd, '-'];
    if (harness === 'claude') return ['-p', promptText, '--output-format', 'stream-json', '--verbose', ...(mode === 'plan' ? ['--permission-mode', 'plan'] : []), ...modelArgs, ...(resumeSession ? ['--resume', resumeSession.nativeId] : [])];
    if (harness === 'gemini') return ['-p', promptText, '-o', 'stream-json', ...modelArgs, ...(resumeSession ? ['--resume', resumeSession.nativeId] : [])];
    if (harness === 'pi') return ['-p', '--mode', 'json', ...modelArgs, ...(resumeSession ? ['--session', resumeSession.file] : []), promptText];
    if (harness === 'antigravity') {
      trustShedWorkspace('antigravity', cwd);
      return ['-p', promptText, '--output-format', 'stream-json', ...modelArgs, ...(resumeSession ? ['--conversation', resumeSession.nativeId] : []), ...(input.skipPermissions ? ['--dangerously-skip-permissions'] : [])];
    }
    return ['run', '--format', 'json', ...modelArgs, ...(resumeSession ? ['--session', resumeSession.nativeId] : []), promptText];
  }
  function launch(resumeSession, promptText, retried = false) {
    const args = buildArgs(resumeSession, promptText);
    const child = spawn(command, args, { cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    active.set(task.id, child);
    if (harness === 'codex') child.stdin.end(promptText); else child.stdin.end();
    let pending = '';
    let agStreamed = '';
    let agResultStatus = '';
    function acceptLine(line) {
      let item;
      try { item = JSON.parse(line); } catch { if (line.trim()) task.output += line + '\n'; return; }
      if (harness === 'antigravity') {
        const cid = item.conversation_id || item.step_update?.conversation_id || item.result?.conversation_id;
        if (cid && !task.sessionId) task.sessionId = `antigravity:${cid}`;
        if (item.event === 'step_update' && item.step_update?.text_delta) {
          agStreamed += item.step_update.text_delta;
          task.output = agStreamed.slice(-120000);
        } else if (item.event === 'result' && item.result) {
          agResultStatus = String(item.result.status || '');
          if (item.result.response) task.output = String(item.result.response).slice(-120000);
          if (item.result.error) task.error = (task.error + item.result.error + '\n').slice(-12000);
          else if (agResultStatus && agResultStatus !== 'SUCCESS' && !task.error) task.error = `Antigravity ended with status ${agResultStatus}.\n`;
        } else if (!item.event) {
          if (item.status) agResultStatus = String(item.status);
          if (item.response) task.output = String(item.response).slice(-120000);
          if (item.error) task.error = (task.error + item.error + '\n').slice(-12000);
        }
        task.updatedAt = new Date().toISOString();
        return;
      }
      if (item.type === 'thread.started' && item.thread_id) task.sessionId = `codex:${item.thread_id}`;
      if (item.session_id && !task.sessionId) task.sessionId = `${harness}:${item.session_id}`;
      if (item.sessionID && !task.sessionId) task.sessionId = `${harness}:${item.sessionID}`;
      const message = item.type === 'item.completed' && item.item?.type === 'agent_message' ? item.item.text :
        item.type === 'message' && (item.role === 'assistant' || item.message?.role === 'assistant') ? (item.content || item.message?.content) :
        item.type === 'result' ? (item.result || item.content) :
        item.type === 'message_end' && item.message?.role === 'assistant' ? item.message.content?.map?.(part => part.text || '').join(' ') :
        item.type === 'text' ? item.part?.text : null;
      if (message) task.output += (typeof message === 'string' ? message : JSON.stringify(message)) + '\n\n';
      if (item.type === 'error') task.error += (item.message || JSON.stringify(item)) + '\n';
      task.output = task.output.slice(-120000);
      task.updatedAt = new Date().toISOString();
    }
    child.stdout.on('data', chunk => {
      pending += chunk.toString();
      const lines = pending.split('\n'); pending = lines.pop() || '';
      for (const line of lines) acceptLine(line);
      saveTasks();
    });
    child.stderr.on('data', chunk => {
      task.error = (task.error + chunk.toString()).slice(-12000);
      task.updatedAt = new Date().toISOString();
      saveTasks();
    });
    child.on('error', err => { updateTask(task, { status: 'failed', error: err.message, updatedAt: new Date().toISOString() }); active.delete(task.id); });
    child.on('close', code => {
      if (pending.trim()) acceptLine(pending);
      if (harness === 'codex' && resumeSession && task.status !== 'cancelling' && code !== 0 && /already has an active writer|thread-store conflict/i.test(task.error)) {
        active.delete(task.id);
        queueCodexTask(task, resumeSession);
        return;
      }
      if (harness === 'antigravity' && resumeSession && !retried && task.status !== 'cancelling' && code !== 0 && /trajectory not found/i.test(task.error)) {
        active.delete(task.id);
        updateTask(task, { sessionId:null, handoffFrom:resumeSession.id, routeReason:'Continuing this Antigravity conversation in a new CLI session with its recent context', output:'', error:'', updatedAt:new Date().toISOString() });
        launch(null, handoffPrompt(resumeSession, input.prompt) + attachmentNote(attachments), true);
        return;
      }
      const agFailed = harness === 'antigravity' && ['ERROR', 'INVALID'].includes(agResultStatus);
      updateTask(task, { status: task.status === 'cancelling' ? 'cancelled' : code === 0 && !agFailed ? 'completed' : 'failed', exitCode: code, updatedAt: new Date().toISOString() });
      active.delete(task.id); sessions(true);
      recordPostTurnCheckpoint(task);
      if (task.sessionId) drainQueue(task.sessionId).catch(() => {});
    });
  }
  launch(route.session, agentPrompt);
  return task;
}

// Who is asking and what this Mac offers: the first thing the app reads.
function meInfo(req) {
  const status = remoteStatus();
  return { ok:true, local:isLocalRequest(req), lanEnabled, pendingDevices:isLocalRequest(req) ? devices().filter(d => d.status === 'pending' && Date.now() - Date.parse(d.createdAt) < 86400000).map(d => publicDevice(d)) : [], phoneConnectedAt:settings.phoneConnectedAt || null, available, laya:layaStatus(), hostname:os.hostname(), phoneUrl:lanEnabled ? `http://${lanAddress()}:${port}` : '', remoteUrl:status.url, remote:status };
}
// Static files are kept in memory with an ETag and ready-compressed copies (rebuilt when a file changes on disk), so a
// phone that already has the app gets a 304 with no body, and one that doesn't gets a small download.
const staticCache = new Map();
function staticEntry(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (!stat.isFile()) return null;
  const hit = staticCache.get(file);
  if (hit && hit.mtime === stat.mtimeMs && hit.size === stat.size) return hit;
  let data = fs.readFileSync(file);
  const text = /\.(html|css|js|svg|webmanifest|json)$/.test(file);
  // The page says which version of Shed it is, so a copy cached on the phone knows when it is out of date.
  if (file === path.join(publicDir, 'index.html')) data = Buffer.from(data.toString('utf8').replace('<head>', `<head><meta name="shed-version" content="${appVersion}">`));
  const entry = { mtime:stat.mtimeMs, size:stat.size, data, etag:`"${crypto.createHash('sha1').update(data).digest('base64url').slice(0, 20)}"`,
    br:text ? zlib.brotliCompressSync(data, { params:{ [zlib.constants.BROTLI_PARAM_QUALITY]:11 } }) : null, gzip:text ? zlib.gzipSync(data, { level:9 }) : null };
  staticCache.set(file, entry);
  return entry;
}
function serveStatic(req, res, pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(publicDir, name);
  const entry = file.startsWith(publicDir + path.sep) ? staticEntry(file) : null;
  if (!entry) return send(res, 404, { error: 'Not found' });
  const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }[path.extname(file)] || 'application/octet-stream';
  const headers = { ...SECURITY_HEADERS, 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache', ETag:entry.etag, Vary:'Accept-Encoding' };
  if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); return res.end(); }
  const accepts = String(req.headers['accept-encoding'] || '');
  const [encoding, data] = entry.br && /\bbr\b/.test(accepts) ? ['br', entry.br] : entry.gzip && /\bgzip\b/.test(accepts) ? ['gzip', entry.gzip] : ['', entry.data];
  res.writeHead(200, { ...headers, ...(encoding ? { 'Content-Encoding':encoding } : {}), 'Content-Length':data.length });
  res.end(req.method === 'HEAD' ? undefined : data);
}

// Commit, push and open a pull request, one step at a time or all three ("ship"). One git action per project at a time,
// so a double tap can't commit twice. A pull request's description defaults to the agent's last reply, which is
// usually its own summary of the work.
const gitBusy = new Set();
async function gitAction(session, input) {
  const action = String(input.action || '');
  if (!['commit', 'push', 'pr', 'ship', 'discard', 'merge', 'remove-worktree'].includes(action)) throw new Error('Unknown git action.');
  if (gitBusy.has(session.cwd)) throw new Error('Git is already busy with this project. Try again in a moment.');
  gitBusy.add(session.cwd);
  try {
    const done = {};
    if (action === 'discard') {
      done.discarded = await discardFile(session.cwd, String(input.file || ''));
      return { ok:true, ...done, changes:await gitChanges(session.cwd) };
    }
    if (action === 'merge') {
      done.merge = await mergeWorktree(session.cwd, { targetBranch:String(input.targetBranch || ''), removeAfter:Boolean(input.removeAfter) });
      if (done.merge.removed) { hideSessions([session.id], true); broadcast('sessions', {}); }
      return { ok:true, ...done, changes:done.merge.removed ? { repo:false, removed:true } : await gitChanges(session.cwd) };
    }
    if (action === 'remove-worktree') {
      done.removed = await removeWorktree(session.cwd, { force:Boolean(input.force), deleteBranch:input.deleteBranch !== false });
      hideSessions([session.id], true);
      broadcast('sessions', {});
      return { ok:true, ...done, changes:{ repo:false, removed:true } };
    }
    if (action === 'commit' || action === 'ship') {
      const state = await gitChanges(session.cwd);
      if (state.files.length) done.commit = await commitAll(session.cwd, input.message, { verify:Boolean(input.verify) });
      else if (action === 'commit') throw new Error('There is nothing to commit.');
    }
    if (action === 'push' || action === 'ship') done.push = await gitPush(session.cwd);
    if (action === 'pr' || action === 'ship') {
      const existing = await pullRequest(session.cwd, { fresh:true });
      if (existing?.url) done.pr = { url:existing.url, existing:true };
      else {
        if (action === 'pr') await gitPush(session.cwd);
        const last = [...sessionMessages(session)].reverse().find(m => m.role === 'assistant')?.text || '';
        const bodyText = String(input.body ?? '').trim() || `${last.slice(0, 6000)}\n\n---\nOpened from Shed.`;
        done.pr = await createPullRequest(session.cwd, { title:input.title || input.message || done.commit?.subject || session.title, body:bodyText, draft:Boolean(input.draft) });
      }
    }
    return { ok:true, ...done, changes:await gitChanges(session.cwd) };
  } finally { gitBusy.delete(session.cwd); }
}

// Share keys: what the "Send to Shed" Shortcut carries. A key can only post shares, never read anything, and is
// revoked from Settings. Only its hash is stored.
const shareKeys = () => settings.shareKeys || [];
const SHARE_BROWSERS = ['', 'chrome', 'safari', 'firefox', 'brave', 'edge', 'arc', 'vivaldi', 'opera', 'chromium'];
function shareKeyFor(req) {
  const supplied = (req.headers.authorization || '').replace(/^Bearer /i, '').trim();
  if (!supplied || supplied.length > 200) return null;
  const hash = sha256(supplied);
  return shareKeys().find(k => k.hash.length === hash.length && crypto.timingSafeEqual(Buffer.from(k.hash), Buffer.from(hash))) || null;
}
const publicShareKey = k => ({ id:k.id, name:k.name, createdAt:k.createdAt, lastUsedAt:k.lastUsedAt || null, uses:k.uses || 0 });
const shareUses = new Map(), shortcutDownloads = new Map();
// Fetches the shared post, then starts a new session with its media attached. Runs after the Shortcut has its answer.
async function runShare({ url, text, note }) {
  let fetched = null;
  try {
    fetched = url ? await fetchShared(url, { cookiesBrowser:settings.shareCookiesBrowser || '' }) : null;
    const attachments = (fetched?.files || []).slice(0, 10).map(file => uploads.adopt(file));
    const input = { prompt:sharePrompt({ url, text, note, fetched }), harness:'auto', model:'', cwd:'', newWorkspace:'', newSession:true, sessionId:null, followup:'auto', attachments, attachmentPaths:[], skipPermissions:false };
    const { input:planned, route, cwd, model } = await planTask(input);
    startTask(planned, route, model, cwd);
  } catch (error) {
    notify({ title:'Shed could not start your share', body:error.message.slice(0, 180), url:'/', tag:'shed-share' }).catch(() => {});
  } finally {
    if (fetched?.dir) fs.rmSync(fetched.dir, { recursive:true, force:true });
  }
}
// The address the Shortcut posts to: the one this phone reached Shed on, or the tunnel when asked from the Mac.
function publicBase(req) {
  const host = String(req.headers.host || '');
  if (req.headers['x-forwarded-proto'] === 'https' && /^[\w.-]+(:\d+)?$/.test(host) && !isDirectLocal(req)) return `https://${host}`;
  return remoteUrl() || '';
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
  try {
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    if (!checkOrigin(req)) return send(res, 403, { error: 'Invalid origin.' });
    if (pathname === '/api/auth/status' && req.method === 'GET') return send(res, 200, { passwordConfigured:passwordConfigured(), canSetup:isLocalRequest(req) && !passwordConfigured() });
    if (pathname === '/api/password/setup' && req.method === 'POST') {
      if (passwordConfigured()) return send(res, 409, { error:'A password is already set. Use it to sign in.' });
      if (!isLocalRequest(req)) return send(res, 403, { error:'Open Shed on the Mac first to create your password.' });
      const input = await body(req);
      const password = typeof input.password === 'string' ? input.password : '';
      if (password.length < 8 || password.length > 128 || !password.trim()) return send(res, 400, { error:'Choose a password between 8 and 128 characters.' });
      settings = { ...settings, passwordHash:hashPassword(password) };
      saveSettings();
      return send(res, 200, { ok:true });
    }
    if (pathname === '/api/auth' && req.method === 'POST') {
      // Failed sign-ins are limited per visitor (their real address, not the tunnel's) and in total per hour.
      const ip = clientIp(req);
      const recent = (attempts.get(ip) || []).filter(at => Date.now() - at < 60000);
      const hourly = (attempts.get('*') || []).filter(at => Date.now() - at < 3600000);
      if (recent.length >= 8 || hourly.length >= 60) return send(res, 429, { error:'Too many sign-in attempts. Try again later.' });
      const input = await body(req);
      const suppliedToken = typeof input.token === 'string' ? input.token.trim() : '';
      const suppliedPassword = typeof input.password === 'string' ? input.password : '';
      const validToken = isDirectLocal(req) && suppliedToken.length === token.length && crypto.timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(token));
      const validPassword = passwordConfigured() && verifyPassword(suppliedPassword, settings.passwordHash);
      if (!validToken && !validPassword) {
        recent.push(Date.now()); hourly.push(Date.now()); attempts.set(ip, recent); attempts.set('*', hourly);
        if (hourly.length === 20) notify({ title:'Repeated failed sign-ins to Shed', body:`20 wrong passwords in the last hour, most recently from ${ip}.`, url:'/?view=settings', tag:'shed-failed-signins' }).catch(() => {});
        return send(res, 401, { error:passwordConfigured() ? 'Incorrect password.' : 'Set a password on the Mac first.' });
      }
      attempts.delete(ip);
      const local = isDirectLocal(req);
      const paired = !local && usePairingCode(input.pairCode);
      const { device, key } = createDevice(req, local || paired ? 'approved' : 'pending');
      if (!local && !settings.phoneConnectedAt) { settings = { ...settings, phoneConnectedAt:new Date().toISOString() }; saveSettings(); }
      if (device.status === 'pending') notify({ title:'New device wants to use Shed', body:`${device.name} from ${device.lastIp}. Approve it on your Mac, or ignore this to keep it out.`, url:'/?view=settings', tag:`device-${device.id}` }).catch(() => {});
      broadcast('devices', {});
      return send(res, device.status === 'approved' ? 200 : 202, { ok:true, status:device.status, device:publicDevice(device, device) }, { 'Set-Cookie':sessionCookie(req, key) });
    }
    // Lets a device that signed in with the password see whether the Mac has approved it yet.
    if (pathname === '/api/auth/device' && req.method === 'GET') {
      const device = deviceFor(req);
      return send(res, 200, { status:device?.status || 'none', name:device?.name || '' });
    }
    // A share from the iPhone Shortcut: answered in plain text, which the Shortcut shows as a notification.
    if (pathname === '/api/share' && req.method === 'POST') {
      const key = shareKeyFor(req);
      if (!key && !isAuthorized(req)) return sendText(res, 401, 'Shed did not accept this Shortcut. Download a new one from Shed → Settings → Share from iPhone.');
      const recent = (shareUses.get(key?.id || 'web') || []).filter(at => Date.now() - at < 3600000);
      if (recent.length >= 30) return sendText(res, 429, 'Too many shares this hour. Try again later.');
      shareUses.set(key?.id || 'web', [...recent, Date.now()]);
      const input = await body(req);
      const flat = value => Array.isArray(value) ? value.map(flat).join('\n') : typeof value === 'string' ? value : value && typeof value === 'object' ? String(value.url || value.link || value.text || '') : '';
      const text = flat(input.shared || input.url || input.text).slice(0, 10000), note = flat(input.note).slice(0, 4000);
      const url = extractUrl(text);
      if (!url && !text.trim()) return sendText(res, 400, 'Nothing came through to share. Share a post or a link.');
      if (key) { key.lastUsedAt = new Date().toISOString(); key.uses = (key.uses || 0) + 1; saveSettings(); }
      runShare({ url, text, note });
      return sendText(res, 202, url ? `Got it. Fetching the ${url.includes('instagram.com') ? 'post' : 'link'}, then an agent gets to work. I'll ping you when it's done.` : "Got it. An agent is on it; I'll ping you when it's done.");
    }
    const downloadMatch = pathname.match(/^\/api\/share\/download\/([\w-]{20,64})$/);
    if (downloadMatch && req.method === 'GET') {
      const pending = shortcutDownloads.get(downloadMatch[1]);
      shortcutDownloads.delete(downloadMatch[1]);
      if (!pending || pending.expires < Date.now()) return sendText(res, 410, 'This link has expired. Go back to Shed → Settings and tap "Get the Shortcut" again.');
      const key = crypto.randomBytes(32).toString('base64url');
      const file = await signedShortcut(pending.base, key);
      const record = { id:crypto.randomUUID(), hash:sha256(key), name:`Send to Shed · ${new Date().toLocaleDateString('en-US', { month:'short', day:'numeric' })}`, createdAt:new Date().toISOString(), base:pending.base };
      settings = { ...settings, shareKeys:[...shareKeys(), record].slice(-10) };
      saveSettings();
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type':'application/octet-stream', 'Content-Disposition':'attachment; filename="Send to Shed.shortcut"', 'Content-Length':file.length, 'Cache-Control':'no-store' });
      return res.end(file);
    }
    if (pathname.startsWith('/api/agent/')) {
      const supplied = (req.headers.authorization || '').replace(/^Bearer /i, '');
      if (!isDirectLocal(req) || supplied.length !== agentKey.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(agentKey))) return send(res, 401, { error:'Shed did not accept this command. Run it from an agent session on the Mac where Shed runs.' });
      return agentRoute(req, res, pathname);
    }
    if (!isAuthorized(req)) return send(res, 401, { error: 'Authentication required.' });
    // Getting the Shortcut takes two steps: a signed-in request makes a one-time link, and opening that link (a plain
    // download, which iOS hands to the Shortcuts app) makes the key and the signed file.
    if (pathname === '/api/share/shortcut' && req.method === 'POST') {
      const base = publicBase(req);
      if (!base) return send(res, 409, { error:'Shed has no address the phone can reach yet. Start the tunnel first.' });
      for (const [c, d] of shortcutDownloads) if (d.expires < Date.now()) shortcutDownloads.delete(c);
      if (shortcutDownloads.size > 50) return send(res, 429, { error:'Too many Shortcut links. Try again in a few minutes.' });
      const code = crypto.randomBytes(24).toString('base64url');
      shortcutDownloads.set(code, { base, expires:Date.now() + 5 * 60 * 1000 });
      const full = `${base}/api/share/download/${code}`;
      // On the Mac, a QR code: the iPhone camera opens it in Safari, which hands the file to the Shortcuts app.
      const qr = await QRCode.toString(full, { type:'svg', margin:1, errorCorrectionLevel:'M', color:{ dark:'#1e1c19', light:'#fffdf8' } });
      return send(res, 200, { download:`/api/share/download/${code}`, url:full, qr });
    }
    // On the Mac itself: opens the Shortcut in the Shortcuts app, which syncs it to the iPhone over iCloud.
    if (pathname === '/api/share/install-on-mac' && req.method === 'POST') {
      if (!isLocalRequest(req)) return send(res, 403, { error:'This only works from Shed on the Mac.' });
      const base = publicBase(req);
      if (!base) return send(res, 409, { error:'Shed has no address the phone can reach yet. Start the tunnel first.' });
      const key = crypto.randomBytes(32).toString('base64url');
      const file = await signedShortcut(base, key);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-install-')), target = path.join(dir, 'Send to Shed.shortcut');
      fs.writeFileSync(target, file, { mode:0o600 });
      settings = { ...settings, shareKeys:[...shareKeys(), { id:crypto.randomUUID(), hash:sha256(key), name:`Send to Shed · ${new Date().toLocaleDateString('en-US', { month:'short', day:'numeric' })}`, createdAt:new Date().toISOString(), base }].slice(-10) };
      saveSettings();
      spawn('/usr/bin/open', [target], { stdio:'ignore', detached:true }).unref();
      setTimeout(() => fs.rmSync(dir, { recursive:true, force:true }), 10 * 60 * 1000);
      return send(res, 200, { ok:true });
    }
    // For building the Shortcut by hand on the phone: the address and a new key, shown once.
    if (pathname === '/api/share/manual-key' && req.method === 'POST') {
      const base = publicBase(req);
      if (!base) return send(res, 409, { error:'Shed has no address the phone can reach yet. Start the tunnel first.' });
      const key = crypto.randomBytes(32).toString('base64url');
      settings = { ...settings, shareKeys:[...shareKeys(), { id:crypto.randomUUID(), hash:sha256(key), name:`Send to Shed (built by hand) · ${new Date().toLocaleDateString('en-US', { month:'short', day:'numeric' })}`, createdAt:new Date().toISOString(), base }].slice(-10) };
      saveSettings();
      return send(res, 200, { url:`${base}/api/share`, header:`Bearer ${key}` });
    }
    if (pathname === '/api/share/settings' && req.method === 'GET') return send(res, 200, { keys:shareKeys().map(publicShareKey), cookiesBrowser:settings.shareCookiesBrowser || '', browsers:SHARE_BROWSERS, base:publicBase(req) });
    if (pathname === '/api/share/settings' && req.method === 'POST') {
      const input = await body(req);
      if (!SHARE_BROWSERS.includes(input.cookiesBrowser)) return send(res, 400, { error:'Unknown browser.' });
      settings = { ...settings, shareCookiesBrowser:input.cookiesBrowser };
      saveSettings();
      return send(res, 200, { cookiesBrowser:input.cookiesBrowser });
    }
    const shareKeyMatch = pathname.match(/^\/api\/share\/keys\/([\w-]+)$/);
    if (shareKeyMatch && req.method === 'DELETE') {
      settings = { ...settings, shareKeys:shareKeys().filter(k => k.id !== shareKeyMatch[1]) };
      saveSettings();
      return send(res, 200, { keys:shareKeys().map(publicShareKey) });
    }
    if (pathname === '/api/connect' && req.method === 'GET') {
      const status = remoteStatus();
      const base = status.url || (lanEnabled ? `http://${lanAddress()}:${port}` : '');
      if (!base) return send(res, 200, { url:'', link:'', secure:false, permanent:status.permanent, mode:status.mode, state:status.state, detail:status.detail, qr:'', shortCode:'', phoneConnectedAt:settings.phoneConnectedAt || null });
      // The QR code and 6-digit code both approve one device immediately for 10 minutes (only minted on the Mac).
      const local = isLocalRequest(req);
      const url = local ? `${base}/#pair=${newPairingCode()}` : base;
      const shortCode = local ? newShortPairingCode() : '';
      const svg = await QRCode.toString(url, { type:'svg', margin:1, errorCorrectionLevel:'M', color:{ dark:'#1e1c19', light:'#fffdf8' } });
      return send(res, 200, { url, link:base, secure:Boolean(status.url), permanent:status.permanent, mode:status.mode, state:status.state, detail:status.detail, qr:svg, shortCode, expiresInSec:600, phoneConnectedAt:settings.phoneConnectedAt || null });
    }
    if (pathname === '/api/bootstrap' && req.method === 'GET') {
      // Everything the app needs to open, in one round trip: who you are, sessions, tasks, harness health and models.
      // The list versions match what /api/sessions and /api/tasks give, so the next poll answers "same".
      refreshQueuedTasks(); syncExchanges(); syncComparisons();
      const sessionList = JSON.stringify({ sessions:sessions().map(publicSession) }), taskList = JSON.stringify({ tasks:tasks.slice(0, 60).map(taskSummary), exchanges:exchanges.all().slice(0, 40).map(exchangeSummary) });
      const cached = harnessHealth(), health = Object.keys(cached || {}).length ? cached : await checkHealth();
      return writeJson(res, 200, `{"me":${JSON.stringify(meInfo(req))},"sessions":${sessionList.slice(12, -1)},"sessionsV":"${versionOf(sessionList)}","tasks":${taskList.slice(9, taskList.indexOf(',"exchanges":'))},"exchanges":${taskList.slice(taskList.indexOf(',"exchanges":') + 13, -1)},"tasksV":"${versionOf(taskList)}","comparisons":${JSON.stringify(comparisons.all().slice(0, 20).map(compareSummary))},"harnesses":${JSON.stringify(health)},"models":${JSON.stringify(Object.fromEntries(harnesses.map(harness => [harness, modelConfig(harness, settings.modelRouting)])))}}`);
    }
    if (pathname === '/api/me' && req.method === 'GET') return send(res, 200, meInfo(req));
    // Remote access (Tailscale, own Cloudflare Named Tunnel, Quick Tunnel, custom URL, or local only).
    // Changing remote access alters how phones reach this Mac, so only the Mac itself can change it.
    if (pathname === '/api/remote' && req.method === 'GET') {
      const fresh = new URL(req.url, 'http://x').searchParams.get('fresh') === '1';
      return send(res, 200, {
        config: remote.publicConfig(),
        status: remoteStatus(),
        capabilities: { cloudflared:Boolean(findCloudflared()), tailscale:await probeTailscale({ fresh }) },
        lanUrl: lanEnabled ? `http://${lanAddress()}:${port}` : '',
        canChange: isLocalRequest(req),
      });
    }
    if (pathname === '/api/remote' && req.method === 'POST') {
      if (!isLocalRequest(req)) return send(res, 403, { error:'Change remote access settings on the Mac.' });
      const input = await body(req);
      const config = remote.saveConfig(input);
      const status = remoteStatus();
      broadcast('remote', status);
      return send(res, 200, {
        config,
        status,
        capabilities: { cloudflared:Boolean(findCloudflared()), tailscale:await probeTailscale({ fresh:true }) },
        lanUrl: lanEnabled ? `http://${lanAddress()}:${port}` : '',
        canChange: true,
      });
    }
    if (pathname === '/api/harness-health' && req.method === 'GET') return send(res, 200, { harnesses:await checkHealth(new URL(req.url, 'http://x').searchParams.get('force') === '1') });
    if (pathname === '/api/settings' && req.method === 'GET') return send(res, 200, { laya:layaStatus(), local:true });
    if (pathname === '/api/laya/test' && req.method === 'POST') return send(res, 200, await probeLaya());
    if (pathname === '/api/models' && req.method === 'GET') return send(res, 200, { configs:Object.fromEntries(harnesses.map(harness => [harness, modelConfig(harness, settings.modelRouting)])) });
    if (pathname === '/api/models' && req.method === 'POST') {
      const input = await body(req);
      const validated = validateModelConfig(input.harness, input);
      settings = { ...settings, modelRouting:{ ...(settings.modelRouting || {}), [input.harness]:{ ...validated, seen:offeredModels(input.harness) } } };
      fs.writeFileSync(settingsFile, JSON.stringify(settings), { mode:0o600 });
      fs.chmodSync(settingsFile, 0o600);
      return send(res, 200, { harness:input.harness, config:validated });
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      const current = deviceFor(req);
      if (current) { settings = { ...settings, devices:devices().filter(d => d.id !== current.id) }; saveSettings(); }
      return send(res, 200, { ok:true }, { 'Set-Cookie':[sessionCookie(req, '', 0), 'laya_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0', 'jev_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'] });
    }
    if (pathname === '/api/devices' && req.method === 'GET') {
      const current = deviceFor(req);
      return send(res, 200, { devices:devices().filter(d => Date.now() - Date.parse(d.lastSeenAt) < SESSION_IDLE_MS).map(d => publicDevice(d, current)), canApprove:isLocalRequest(req) });
    }
    const deviceMatch = pathname.match(/^\/api\/devices\/([\w-]+)\/(approve|revoke)$/);
    if (deviceMatch && req.method === 'POST') {
      const device = devices().find(d => d.id === deviceMatch[1]);
      if (!device) return send(res, 404, { error:'That device is no longer listed.' });
      // Approving is only possible on the Mac itself, so a stolen phone session cannot let in more devices.
      if (deviceMatch[2] === 'approve') {
        if (!isLocalRequest(req)) return send(res, 403, { error:'Approve new devices on the Mac.' });
        device.status = 'approved'; device.approvedAt = new Date().toISOString();
      } else settings = { ...settings, devices:devices().filter(d => d.id !== device.id) };
      saveSettings();
      broadcast('devices', {});
      return send(res, 200, { ok:true });
    }
    if (pathname === '/api/devices/revoke-others' && req.method === 'POST') {
      const current = deviceFor(req);
      settings = { ...settings, devices:devices().filter(d => d.id === current?.id) }; saveSettings();
      broadcast('devices', {});
      return send(res, 200, { ok:true });
    }
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-store', 'Connection':'keep-alive', 'X-Accel-Buffering':'no' });
      res.write('retry: 3000\n: connected\n\n');
      res.flushHeaders?.();
      eventClients.add(res);
      req.on('close', () => eventClients.delete(res));
      return;
    }
    if (pathname === '/api/sessions' && req.method === 'GET') return sendVersioned(req, res, { sessions: sessions().map(publicSession) });
    if (pathname === '/api/sessions/hide' && req.method === 'POST') {
      const input = await body(req);
      if (!Array.isArray(input.ids) || input.ids.length > 2000 || !input.ids.every(id => typeof id === 'string')) throw new Error('Send the sessions to clear as a list.');
      const list = hideSessions(input.ids, input.hidden !== false);
      return send(res, 200, { hidden:list.filter(s => s.hidden).length });
    }
    if (pathname === '/api/push' && req.method === 'GET') {
      const endpoint = new URL(req.url, 'http://x').searchParams.get('endpoint') || '';
      return send(res, 200, { publicKey:pushPublicKey(), subscribed:endpoint ? isSubscribed(endpoint) : false, devices:pushCount(), prefs:notifyPrefs() });
    }
    if (pathname === '/api/push/subscribe' && req.method === 'POST') {
      const input = await body(req);
      subscribe(input.subscription, input.label);
      await notify({ title:'Notifications are on', body:'Shed will tell you when an agent finishes or needs your OK.', url:'/', tag:'shed-welcome' }, input.subscription.endpoint);
      return send(res, 200, { ok:true });
    }
    if (pathname === '/api/push/unsubscribe' && req.method === 'POST') { const input = await body(req); unsubscribe(String(input.endpoint || '')); return send(res, 200, { ok:true }); }
    if (pathname === '/api/autoclose' && req.method === 'GET') return send(res, 200, { prefs:autoClosePrefs(settings.autoClose) });
    if (pathname === '/api/autoclose' && req.method === 'POST') {
      const input = await body(req);
      settings = { ...settings, autoClose:autoClosePrefs({ enabled:input.enabled !== false, hours:input.hours ?? settings.autoClose?.hours }) }; saveSettings();
      autoCloseIdle().catch(error => console.error(`Auto-close failed: ${error.message}`));
      return send(res, 200, { prefs:settings.autoClose });
    }
    if (pathname === '/api/branches' && req.method === 'GET') return send(res, 200, { ownBranch:settings.ownBranch !== false });
    if (pathname === '/api/branches' && req.method === 'POST') { const input = await body(req); settings = { ...settings, ownBranch:input.ownBranch !== false }; saveSettings(); return send(res, 200, { ownBranch:settings.ownBranch }); }
    // Worktree management: list Shed-managed branch worktrees, remove one, or clean up all merged worktrees in one tap.
    if (pathname === '/api/worktrees' && req.method === 'GET') return send(res, 200, { worktrees:await listWorktrees() });
    if (pathname === '/api/worktrees/remove' && req.method === 'POST') {
      const input = await body(req);
      if (typeof input.path !== 'string' || !input.path.trim()) return send(res, 400, { error:'Choose a worktree to remove.' });
      const removed = await removeWorktree(input.path, { force:Boolean(input.force), deleteBranch:input.deleteBranch !== false });
      const affected = sessions().filter(s => s.cwd === removed.removed).map(s => s.id);
      if (affected.length) hideSessions(affected, true);
      broadcast('sessions', {});
      return send(res, 200, { ok:true, removed, worktrees:await listWorktrees() });
    }
    if (pathname === '/api/worktrees/cleanup' && req.method === 'POST') {
      const input = await body(req);
      const all = await listWorktrees();
      const targets = Array.isArray(input.paths) && input.paths.length
        ? all.filter(w => input.paths.includes(w.path))
        : all.filter(w => w.merged && !w.dirty);
      const removed = [], failed = [];
      for (const wt of targets) {
        try {
          const resWt = await removeWorktree(wt.path, { force:Boolean(input.force), deleteBranch:true });
          removed.push(resWt);
        } catch (error) { failed.push({ path:wt.path, branch:wt.branch, error:error.message }); }
      }
      const removedPaths = new Set(removed.map(r => r.removed));
      const affected = sessions().filter(s => removedPaths.has(s.cwd)).map(s => s.id);
      if (affected.length) hideSessions(affected, true);
      if (removed.length) broadcast('sessions', {});
      return send(res, 200, { ok:true, removed, failed, worktrees:await listWorktrees() });
    }
    // Open GitHub issues for a known session project, so you can start a session straight from an issue.
    if (pathname === '/api/issues' && req.method === 'GET') {
      const query = new URL(req.url, 'http://x').searchParams;
      const cwd = String(query.get('cwd') || '');
      const allowed = cwd && sessions().some(s => s.cwd === cwd) && fs.existsSync(cwd);
      if (!allowed) return send(res, 400, { error:'Pick an existing git project first.' });
      return send(res, 200, await listIssues(cwd, { fresh:query.get('fresh') === '1' }));
    }
    // Fan-out & Compare: launch the same prompt across 2–4 harnesses in parallel isolated worktrees and pick a winner.
    if (pathname === '/api/comparisons' && req.method === 'GET') {
      refreshQueuedTasks(); syncComparisons();
      return sendVersioned(req, res, { comparisons:comparisons.all().slice(0, 25).map(compareSummary) });
    }
    const comparePickMatch = pathname.match(/^\/api\/comparisons\/([\w-]{1,40})\/pick$/);
    if (comparePickMatch && req.method === 'POST') {
      const comp = comparisons.get(comparePickMatch[1]);
      if (!comp) return send(res, 404, { error:'Comparison not found.' });
      const input = await body(req);
      const winner = (comp.entries || []).find(e => e.taskId === input.taskId || (input.sessionId && e.sessionId === input.sessionId));
      if (!winner) return send(res, 400, { error:'Choose one of the comparison entries as the winner.' });
      const cleaned = [], errors = [];
      if (input.cleanupOthers !== false) {
        const losers = comp.entries.filter(e => e.taskId !== winner.taskId);
        const loserSessions = [];
        for (const loser of losers) {
          if (loser.sessionId) loserSessions.push(loser.sessionId);
          // End running loser agent if active
          const session = loser.sessionId ? sessions().find(s => s.id === loser.sessionId) : null;
          const target = session ? endTarget(session) : null;
          if (target) await endAgent(target).catch(() => {});
          if (loser.branch && loser.cwd && loser.cwd !== winner.cwd && fs.existsSync(loser.cwd)) {
            try {
              await removeWorktree(loser.cwd, { force:Boolean(input.force), deleteBranch:true });
              loser.cleaned = true;
              cleaned.push(loser.branch);
            } catch (error) { errors.push({ harness:loser.harness, branch:loser.branch, error:error.message }); }
          }
        }
        if (loserSessions.length) hideSessions(loserSessions, true);
      }
      const updated = comparisons.update(comp.id, { status:'decided', winnerTaskId:winner.taskId, winnerHarness:winner.harness, entries:comp.entries });
      broadcast('comparisons', {}); broadcast('sessions', {});
      return send(res, 200, { ok:true, comparison:compareSummary(updated), cleaned, errors });
    }
    const compareDetailMatch = pathname.match(/^\/api\/comparisons\/([\w-]{1,40})$/);
    if (compareDetailMatch && req.method === 'GET') {
      refreshQueuedTasks(); syncComparisons();
      const comp = comparisons.get(compareDetailMatch[1]);
      if (!comp) return send(res, 404, { error:'Comparison not found.' });
      const entries = await Promise.all((comp.entries || []).map(async entry => {
        let diff = null;
        if (entry.cwd && fs.existsSync(entry.cwd)) {
          try {
            const st = await gitChanges(entry.cwd);
            if (st.repo) diff = { branch:st.branch, filesCount:st.files.length, additions:st.additions, deletions:st.deletions, files:st.files.slice(0, 20).map(f => ({ path:f.path, status:f.status, additions:f.additions, deletions:f.deletions })) };
          } catch {}
        }
        const task = tasks.find(t => t.id === entry.taskId);
        return { ...entry, output:String(task?.output || entry.output || '').slice(-4000), error:String(task?.error || entry.error || '').slice(-600), diff };
      }));
      return send(res, 200, { comparison:{ ...compareSummary(comp), prompt:comp.prompt, entries } });
    }
    if (pathname === '/api/comparisons' && req.method === 'POST') {
      const input = await body(req);
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt || prompt.length > 20000) return send(res, 400, { error:'Prompt must be between 1 and 20,000 characters.' });
      const chosen = [...new Set((Array.isArray(input.harnesses) ? input.harnesses : []).filter(h => harnesses.includes(h)))].slice(0, 4);
      if (chosen.length < 2) return send(res, 400, { error:'Pick at least 2 harnesses to compare.' });
      const health = Object.keys(harnessHealth() || {}).length ? harnessHealth() : await checkHealth();
      const notReady = chosen.filter(h => health[h]?.state !== 'ready');
      if (notReady.length) return send(res, 400, { error:`Not ready: ${notReady.join(', ')}.` });
      const attachmentIds = Array.isArray(input.attachments) ? input.attachments.filter(id => typeof id === 'string' && UPLOAD_ID.test(id)).slice(0, 10) : [];
      const baseCwdInput = typeof input.cwd === 'string' && sessions().some(s => s.cwd === input.cwd) ? input.cwd : '';
      let baseCwd = baseCwdInput;
      if (input.newWorkspace) {
        const name = String(input.newWorkspace).trim();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,59}$/.test(name) || name === '.' || name === '..') return send(res, 400, { error:'Workspace names must be 1–60 letters, numbers, spaces, dots, dashes, or underscores.' });
        baseCwd = path.join(os.homedir(), 'Shed Workspaces', name);
        fs.mkdirSync(baseCwd, { recursive:true });
      }
      const isGitRepo = baseCwd ? Boolean(await repoRoot(baseCwd)) : false;
      const sharedAttachments = attachmentIds.length ? uploads.place(attachmentIds, baseCwd || '') : [];
      const compId = crypto.randomUUID().slice(0, 8);
      const entries = [];
      for (const h of chosen) {
        let entryCwd = baseCwd || autoWorkspace(`${prompt} ${h}`, false);
        let branch = '';
        let project = baseCwd || entryCwd;
        if (isGitRepo) {
          const wt = await sessionWorktree(baseCwd, prompt, { suffix:h });
          if (wt) { entryCwd = wt.path; branch = wt.branch; project = wt.project; }
        } else if (baseCwd) {
          entryCwd = autoWorkspace(`${path.basename(baseCwd)}-${h}`, false);
        }
        const planned = await planTask({ prompt, harness:h, model:String(input.models?.[h] || ''), cwd:entryCwd, newSession:true, sessionId:null, followup:'auto', attachments:[], attachmentPaths:sharedAttachments, skipPermissions:Boolean(input.skipPermissions) });
        // planTask may normalize cwd only against known sessions, so pass our isolated entryCwd explicitly to startTask
        const task = startTask(planned.input, planned.route, planned.model, entryCwd);
        Object.assign(task, { compareId:compId, ...(branch ? { branch, project } : {}) });
        saveTasks();
        entries.push({ harness:h, model:task.model || '', taskId:task.id, sessionId:task.sessionId || null, cwd:entryCwd, branch, status:task.status, liveState:'working', output:'', error:'' });
      }
      const record = comparisons.add({
        id: compId,
        title: titleFor(prompt),
        prompt,
        project: baseCwd || entries[0]?.cwd || '',
        status: 'running',
        winnerTaskId: null,
        winnerHarness: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        entries,
      });
      broadcast('comparisons', {});
      return send(res, 201, { comparison:compareSummary(record) });
    }
    // Cross-harness code review: start another ready harness on the same checkout to review this session's changes.
    const reviewMatch = pathname.match(/^\/api\/sessions\/(.+)\/review$/);
    if (reviewMatch && req.method === 'POST') {
      const author = sessions(true).find(s => s.id === decodeURIComponent(reviewMatch[1]));
      if (!author) return send(res, 404, { error:'Session not found.' });
      if (!author.cwd || !fs.existsSync(author.cwd)) return send(res, 404, { error:'This session has no project folder on the Mac.' });
      const input = await body(req);
      const health = Object.keys(harnessHealth() || {}).length ? harnessHealth() : await checkHealth();
      const ready = Object.entries(health).filter(([, st]) => st.state === 'ready').map(([name]) => name);
      const requested = typeof input.harness === 'string' && input.harness && input.harness !== 'auto' ? input.harness : '';
      const targetHarness = requested || ready.find(h => h !== author.harness) || ready[0];
      if (!targetHarness || !ready.includes(targetHarness)) return send(res, 400, { error:requested ? `${requested} is not ready.` : 'No ready harness available to run a review.' });
      const st = await gitChanges(author.cwd).catch(() => ({ repo:false, files:[] }));
      const canAskAuthor = author.liveState !== 'history' && TALKERS.includes(author.harness) && TALKERS.includes(targetHarness);
      const reviewText = buildReviewPrompt({ authorSession:author, branch:st.branch || '', files:st.files || [], focus:String(input.focus || '').slice(0, 2000), shedCli, canAskAuthor });
      const planned = await planTask({ prompt:`Review ${label[author.harness] || author.harness}'s changes in ${projectLabel(author.cwd)}`, agentPrompt:reviewText, harness:targetHarness, model:String(input.model || ''), cwd:author.cwd, newSession:true, sessionId:null, followup:'auto', attachments:[], attachmentPaths:[], skipPermissions:Boolean(input.skipPermissions) });
      const task = startTask({ ...planned.input, agentPrompt:reviewText }, planned.route, planned.model, author.cwd);
      Object.assign(task, { reviewOf:author.id });
      saveTasks();
      return send(res, 201, { task:publicTask(task) });
    }
    if (pathname === '/api/autoroute' && req.method === 'GET') return send(res, 200, { prefs:autoRoutePrefs(settings.autoRoute, harnesses) });
    if (pathname === '/api/autoroute' && req.method === 'POST') {
      const input = await body(req);
      settings = { ...settings, autoRoute:autoRoutePrefs({ off:input.off }, harnesses) }; saveSettings();
      return send(res, 200, { prefs:settings.autoRoute });
    }
    if (pathname === '/api/push/prefs' && req.method === 'POST') {
      const input = await body(req);
      settings = { ...settings, notify:{ finished:input.finished !== false, asking:input.asking !== false } }; saveSettings();
      return send(res, 200, { prefs:notifyPrefs() });
    }
    // Files an agent made in its project folder: listed for a session or task, streamed only from inside that folder.
    const filesMatch = pathname.match(/^\/api\/(sessions|tasks)\/(.+)\/(files|file)$/);
    if (filesMatch && req.method === 'GET') {
      const id = decodeURIComponent(filesMatch[2]);
      const owner = filesMatch[1] === 'sessions' ? sessions().find(s => s.id === id) : tasks.find(t => t.id === id);
      const root = owner?.cwd;
      if (!root || root === '/' || !fs.existsSync(root)) return send(res, 404, { error:'This session has no project folder on the Mac.' });
      if (filesMatch[3] === 'files') return send(res, 200, { root:path.basename(root), ...listArtifacts(root) });
      const query = new URL(req.url, 'http://x').searchParams;
      const file = resolveInside(root, query.get('path'));
      if (!file) return send(res, 404, { error:'That file is not available.' });
      return sendFile(req, res, file, query.get('download') === '1');
    }
    // Git for developers: what a session changed (uncommitted or whole branch), diffs, checkpoints, scripts, and shipping.
    const cpActionMatch = pathname.match(/^\/api\/sessions\/(.+)\/checkpoints\/(cp-[a-f0-9]+)\/(changes|diff|revert)$/);
    if (cpActionMatch) {
      const session = sessions().find(s => s.id === decodeURIComponent(cpActionMatch[1]));
      const cwd = session?.cwd, cpId = cpActionMatch[2], action = cpActionMatch[3], query = new URL(req.url, 'http://x').searchParams;
      if (!cwd || cwd === '/' || !fs.existsSync(cwd)) return send(res, 404, { error:'This session has no project folder on the Mac.' });
      const cp = checkpoints.get(cpId);
      const root = await repoRoot(cwd);
      if (!cp || (root && cp.root !== root)) return send(res, 404, { error:'Checkpoint not found for this project.' });
      if (action === 'changes' && req.method === 'GET') {
        const toId = query.get('to') || '';
        const toCp = toId && toId !== 'working' ? checkpoints.get(toId) : null;
        return send(res, 200, await checkpointChanges(cwd, cp.commit, toCp?.commit || ''));
      }
      if (action === 'diff' && req.method === 'GET') {
        const toId = query.get('to') || '';
        const toCp = toId && toId !== 'working' ? checkpoints.get(toId) : null;
        return send(res, 200, await checkpointFileDiff(cwd, cp.commit, toCp?.commit || '', String(query.get('path') || '')));
      }
      if (action === 'revert' && req.method === 'POST') {
        if (gitBusy.has(cwd)) return send(res, 409, { error:'Git is already busy with this project. Try again in a moment.' });
        gitBusy.add(cwd);
        try {
          const backup = await captureCheckpoint(cwd, { sessionId:session.id, label:`Backup before rewind to "${cp.label}"`, kind:'pre-revert' }).catch(() => null);
          if (backup) checkpoints.add(backup);
          await revertToCheckpoint(cwd, cp.commit);
          return send(res, 200, { ok:true, reverted:cp, backup, changes:await gitChanges(cwd), checkpoints:checkpoints.forSession(session.id, root) });
        } finally { gitBusy.delete(cwd); }
      }
      return send(res, 405, { error:'Not allowed.' });
    }
    const cpListMatch = pathname.match(/^\/api\/sessions\/(.+)\/checkpoints$/);
    if (cpListMatch) {
      const session = sessions().find(s => s.id === decodeURIComponent(cpListMatch[1]));
      const cwd = session?.cwd;
      if (!cwd || cwd === '/' || !fs.existsSync(cwd)) return send(res, 404, { error:'This session has no project folder on the Mac.' });
      const root = await repoRoot(cwd);
      if (req.method === 'GET') return send(res, 200, { repo:Boolean(root), checkpoints:root ? checkpoints.forSession(session.id, root) : [] });
      if (req.method === 'POST') {
        if (!root) return send(res, 400, { error:'This folder is not a git repository.' });
        const input = await body(req);
        const cp = await captureCheckpoint(cwd, { sessionId:session.id, label:String(input.label || 'Manual checkpoint').trim().slice(0, 120) || 'Manual checkpoint', kind:'manual' });
        if (cp) checkpoints.add(cp);
        return send(res, 201, { checkpoint:cp, checkpoints:checkpoints.forSession(session.id, root) });
      }
      return send(res, 405, { error:'Not allowed.' });
    }
    // Per-project quick scripts (test, lint, build, or custom .shed.yaml scripts) run in the session's folder.
    const scriptsMatch = pathname.match(/^\/api\/sessions\/(.+)\/scripts(\/run)?$/);
    if (scriptsMatch) {
      const session = sessions().find(s => s.id === decodeURIComponent(scriptsMatch[1]));
      const cwd = session?.cwd;
      if (!cwd || cwd === '/' || !fs.existsSync(cwd)) return send(res, 404, { error:'This session has no project folder on the Mac.' });
      if (!scriptsMatch[2] && req.method === 'GET') {
        return send(res, 200, { scripts:discoverScripts(cwd), runs:scriptResultsFor(cwd) });
      }
      if (scriptsMatch[2] === '/run' && req.method === 'POST') {
        const input = await body(req);
        const result = await runProjectScript(cwd, String(input.id || ''));
        return send(res, 200, { result, runs:scriptResultsFor(cwd) });
      }
      return send(res, 405, { error:'Not allowed.' });
    }
    // Universal per-session follow-up queue & mid-run steering.
    const queueCancelMatch = pathname.match(/^\/api\/queue\/(q-[a-f0-9]+)$/);
    if (queueCancelMatch && req.method === 'DELETE') {
      const removed = queue.cancel(queueCancelMatch[1]);
      if (!removed) return send(res, 404, { error:'Queued message not found.' });
      broadcast('queue', { sessionId:removed.sessionId });
      return send(res, 200, { ok:true, items:queue.forSession(removed.sessionId).map(queueSummary) });
    }
    const sessionQueueMatch = pathname.match(/^\/api\/sessions\/(.+)\/(queue|steer)$/);
    if (sessionQueueMatch) {
      const sid = decodeURIComponent(sessionQueueMatch[1]), kind = sessionQueueMatch[2];
      const session = sessions(true).find(s => s.id === sid);
      if (!session) return send(res, 404, { error:'Session not found.' });
      if (kind === 'queue' && req.method === 'GET') return send(res, 200, { items:queue.forSession(sid).map(queueSummary) });
      if (kind === 'queue' && req.method === 'POST') {
        const input = await body(req);
        const attachmentIds = Array.isArray(input.attachments) ? input.attachments.filter(id => typeof id === 'string' && UPLOAD_ID.test(id)).slice(0, 10) : [];
        const item = queue.enqueue({ sessionId:sid, prompt:input.prompt, mode:input.mode, model:input.model, followup:input.followup, attachments:attachmentIds, skipPermissions:Boolean(input.skipPermissions) });
        broadcast('queue', { sessionId:sid });
        // If the session is already idle, drain immediately!
        drainQueue(sid).catch(() => {});
        return send(res, 201, { item:queueSummary(item), items:queue.forSession(sid).map(queueSummary) });
      }
      if (kind === 'steer' && req.method === 'POST') {
        const input = await body(req);
        let prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
        let mode = input.mode === 'plan' ? 'plan' : 'build';
        let modelChoice = typeof input.model === 'string' ? input.model : '';
        let attachments = [];
        if (input.queueId) {
          const promoted = queue.takeById(String(input.queueId));
          if (!promoted) return send(res, 404, { error:'Queued message is no longer pending.' });
          prompt = promoted.prompt; mode = promoted.mode || 'build'; modelChoice = promoted.model || ''; attachments = promoted.attachments || [];
          broadcast('queue', { sessionId:sid });
        }
        if (!prompt || prompt.length > 20000) return send(res, 400, { error:'Write a steering message first.' });
        // Interrupt an active turn first so the steering message lands immediately.
        const runningTask = tasks.find(t => t.sessionId === sid && active.has(t.id));
        if (runningTask) {
          const child = active.get(runningTask.id);
          updateTask(runningTask, { status:'cancelling' });
          child?.kill('SIGTERM');
          await new Promise(resolve => setTimeout(resolve, 250));
          active.delete(runningTask.id);
          updateTask(runningTask, { status:'cancelled', error:'Interrupted for mid-run steering.', updatedAt:new Date().toISOString() });
        } else if (session.liveState === 'working' && session.tty) {
          await typeIntoTerminalAsync(session.tty, '\u0003').catch(() => {});
          await new Promise(resolve => setTimeout(resolve, 400));
        } else if (session.liveState === 'working' && session.harness === 'codex' && !session.tty) {
          await interruptCodexThread(session.nativeId).catch(() => {});
        }
        const { input:planned, route, cwd, model } = await planTask({ prompt, agentPrompt:mode === 'plan' ? planModePrompt(prompt) : steerPrompt(prompt), mode, sessionId:sid, followup:'stay', harness:'auto', model:modelChoice, newSession:false, attachments, attachmentPaths:[] });
        const targetCwd = route.session?.cwd || cwd;
        if (mode !== 'plan' && targetCwd) {
          const cp = await captureCheckpoint(targetCwd, { sessionId:sid, label:`Before steer: ${titleFor(prompt)}`, kind:'pre-turn' }).catch(() => null);
          if (cp) checkpoints.add(cp);
        }
        const task = startTask({ ...planned, mode }, route, model, cwd);
        if (active.has(task.id)) active.get(task.id).layaSessionId = sid;
        return send(res, 201, { task:publicTask(task) });
      }
      return send(res, 405, { error:'Not allowed.' });
    }
    const gitMatch = pathname.match(/^\/api\/sessions\/(.+)\/(changes|diff|git|pr|check-logs)$/);
    if (gitMatch) {
      const session = sessions().find(s => s.id === decodeURIComponent(gitMatch[1]));
      const cwd = session?.cwd, kind = gitMatch[2], query = new URL(req.url, 'http://x').searchParams;
      if (!cwd || cwd === '/' || !fs.existsSync(cwd)) return send(res, 404, { error:'This session has no project folder on the Mac.' });
      const scope = query.get('scope') === 'branch' ? 'branch' : 'uncommitted';
      if (kind === 'changes' && req.method === 'GET') return sendVersioned(req, res, scope === 'branch' ? await branchChanges(cwd) : await gitChanges(cwd));
      if (kind === 'diff' && req.method === 'GET') return send(res, 200, scope === 'branch' ? await branchFileDiff(cwd, String(query.get('path') || '')) : await fileDiff(cwd, String(query.get('path') || '')));
      if (kind === 'pr' && req.method === 'GET') return send(res, 200, { pr:await pullRequest(cwd, { fresh:query.get('fresh') === '1' }) });
      if (kind === 'check-logs' && req.method === 'GET') {
        const { pr, failed, logs } = await failedCheckLogs(cwd);
        const prompt = `The checks on pull request #${pr.number} failed: ${failed.map(c => c.name).join(', ')}. Find the cause and fix it, then commit and push.\n\n${logs.map(log => `\`\`\`\n${log}\n\`\`\``).join('\n\n')}`;
        return send(res, 200, { prompt, failed:failed.map(c => c.name) });
      }
      if (kind === 'git' && req.method === 'POST') return send(res, 200, await gitAction(session, await body(req)));
      return send(res, 405, { error:'Not allowed.' });
    }
    const loginMatch = pathname.match(/^\/api\/harnesses\/([a-z]+)\/(login|terminal)$/);
    if (loginMatch && loginCommands[loginMatch[1]]) {
      const name = loginMatch[1];
      if (loginMatch[2] === 'login' && req.method === 'POST') {
        if (!available[name]) return send(res, 400, { error:`${name} is not installed on this Mac.` });
        const existing = loginTerminals.get(name);
        if (existing && (await readTerminalAsync(existing, 1)) !== null) return send(res, 200, { tty:existing });
        const tty = await openTerminalAsync(os.homedir(), loginCommands[name]);
        loginTerminals.set(name, tty);
        return send(res, 200, { tty });
      }
      const tty = loginTerminals.get(name);
      if (!tty) return send(res, 404, { error:'No sign-in window is open for this harness.' });
      if (req.method === 'GET') {
        const text = await readTerminalAsync(tty);
        if (text === null) { loginTerminals.delete(name); return send(res, 404, { error:'The sign-in window was closed.' }); }
        return sendVersioned(req, res, terminalReading(tty, text));
      }
      if (req.method === 'POST') {
        const input = await body(req);
        if (!agentInForeground(tty, [...cliProcessNames(name), 'node'])) return send(res, 409, { error:'The sign-in has finished in that window, so Shed will not type into it.' });
        if (input.option !== undefined) { const result = await chooseOption(tty, input); return send(res, result.status, result.error ? { error:result.error } : { ok:true }); }
        if (typeof input.text !== 'string' || input.text.length > 4000) return send(res, 400, { error:'Send up to 4,000 characters.' });
        await typeIntoTerminalAsync(tty, input.text);
        return send(res, 200, { ok:true });
      }
    }
    // A task's own Terminal window (for example a new session still answering a startup question).
    const taskTerminal = pathname.match(/^\/api\/tasks\/([\w-]+)\/terminal$/);
    if (taskTerminal) {
      const task = tasks.find(t => t.id === taskTerminal[1]);
      if (!task?.tty) return send(res, 404, { error:'This task has no Terminal window.' });
      if (req.method === 'GET') {
        const text = await readTerminalAsync(task.tty);
        return text === null ? send(res, 404, { error:'That Terminal window is closed.' }) : sendVersioned(req, res, terminalReading(task.tty, text));
      }
      if (req.method === 'POST') {
        const input = await body(req);
        if (!agentInForeground(task.tty, [...cliProcessNames(task.harness), 'node'])) return send(res, 409, { error:`${task.harness} is no longer running in that Terminal window.` });
        if (input.option !== undefined) { const result = await chooseOption(task.tty, input); return send(res, result.status, result.error ? { error:result.error } : { ok:true }); }
        if (!CONTROL_KEYS.includes(input.text)) return send(res, 400, { error:'Only the terminal control keys can be sent here.' });
        await typeIntoTerminalAsync(task.tty, input.text);
        return send(res, 200, { ok:true });
      }
    }
    const terminalMatch = pathname.match(/^\/api\/sessions\/(.+)\/terminal$/);
    if (terminalMatch) {
      // The cached list (refreshed every 10 seconds) is enough here; a full rescan would block the server on every 2-second poll.
      const wanted = decodeURIComponent(terminalMatch[1]);
      let session = sessions().find(s => s.id === wanted);
      if (!session?.tty) session = sessions(true).find(s => s.id === wanted);
      if (!session) return send(res, 404, { error:'Session not found.' });
      if (!session.tty) return send(res, 404, { error:'This session is not open in a Terminal tab.' });
      if (req.method === 'GET') {
        const text = await readTerminalAsync(session.tty);
        return text === null ? send(res, 404, { error:'That Terminal tab is no longer open.' }) : sendVersioned(req, res, terminalReading(session.tty, text));
      }
      if (req.method === 'POST') {
        const input = await body(req);
        // Only the on-screen control keys or a listed option, and only while the agent is the foreground program: never free text into a shell.
        if (!agentInForeground(session.tty, cliProcessNames(session.harness))) return send(res, 409, { error:`${session.harness} is no longer running in that Terminal tab.` });
        if (input.option !== undefined) { const result = await chooseOption(session.tty, input); return send(res, result.status, result.error ? { error:result.error } : { ok:true }); }
        if (!CONTROL_KEYS.includes(input.text)) return send(res, 400, { error:'Only the terminal control keys can be sent here. Send messages from the message box.' });
        await typeIntoTerminalAsync(session.tty, input.text);
        return send(res, 200, { ok:true });
      }
    }
    // Changing an open Claude session's permission mode: Shift+Tab until its footer names the mode asked for.
    // Skipping permissions is only in that cycle when Claude was started with --allow-dangerously-skip-permissions.
    // Otherwise, asked with restart:true, Shed ends Claude and resumes the same conversation in the same tab with skip on.
    const permMatch = pathname.match(/^\/api\/sessions\/(.+)\/permissions$/);
    if (permMatch && req.method === 'POST') {
      const input = await body(req);
      const target = input.mode;
      if (!['ask', 'edits', 'plan', 'auto', 'skip'].includes(target)) return send(res, 400, { error:'That mode can\'t be chosen from Shed.' });
      const session = sessions(true).find(s => s.id === decodeURIComponent(permMatch[1]));
      if (!session || session.harness !== 'claude' || !session.tty) return send(res, 409, { error:'Only Claude sessions open in a Terminal window can change mode here.' });
      if (!agentInForeground(session.tty, 'claude')) return send(res, 409, { error:'Claude is no longer running in that Terminal tab.' });
      let screen = await readTerminalAsync(session.tty, 14) || '';
      if (QUESTION_ON_SCREEN.test(screen)) return send(res, 409, { error:'Claude is asking something. Answer it from the Terminal tab first.' });
      if (/\n\s*❯ *\S/.test(screen)) return send(res, 409, { error:'There is unsent text on the Terminal\'s input line. Clear it on the Mac first.' });
      const start = footerMode(screen);
      if (!start) return send(res, 409, { error:'Shed can\'t read Claude\'s mode from its Terminal right now. Try again in a moment.' });
      // Shift+Tab steps through the modes Claude offers. If the one asked for never comes up, step on round to where it began.
      const press = async () => { await typeIntoTerminalAsync(session.tty, '\u001b[Z'); await new Promise(resolve => setTimeout(resolve, 800)); return footerMode(await readTerminalAsync(session.tty, 14) || ''); };
      let mode = start;
      // Skip is only in the cycle when Claude's command line offers it; without that, stepping through can't reach it.
      if (target === 'skip' && start !== 'skip' && input.restart !== true && !canSkipPermissions(claudeLiveSessions().get(session.nativeId)?.pid)) return send(res, 409, { error:'This session was started without the option to skip permissions.', mode:start, restart:true });
      const restart = target === 'skip' && input.restart === true && start !== 'skip';
      // A restart is asked for only after the cycle was already tried, so it isn't stepped through again.
      if (!restart) {
        for (let presses = 0; mode !== target && presses < 5; presses++) mode = await press();
        for (let presses = 0; mode !== target && mode !== start && presses < 5; presses++) mode = await press();
      }
      if (restart) {
        if (session.liveState === 'working' || activeOnScreen(screen)) return send(res, 409, { error:'Claude is in the middle of a reply. Wait for it to finish, or Stop it, then try again.' });
        const result = await endAgent(endTarget(session) || {});
        if (!result.stopped) return send(res, 409, { error:'Claude did not stop. Close its Terminal window on the Mac.' });
        cancelSessionTasks(session.id, 'Restarted with permissions skipped.');
        const model = /^[\w.:\[\]-]{1,80}$/.test(session.currentModel || '') ? ['--model', session.currentModel] : [];
        await runInTab(session.tty, session.cwd || os.homedir(), ['claude', '--resume', session.nativeId, ...model, '--dangerously-skip-permissions']);
        for (let waited = 0; mode !== 'skip' && waited < 12000; waited += 1000) { await new Promise(resolve => setTimeout(resolve, 1000)); mode = footerMode(await readTerminalAsync(session.tty, 14) || ''); }
        sessions(true); broadcast('sessions', {});
        if (mode === 'skip') return send(res, 200, { ok:true, mode, restarted:true });
        return send(res, 409, { error:'Claude was restarted with permissions skipped, but Shed can\'t see it ready yet. Check the Terminal tab.', mode });
      }
      sessions(true); broadcast('sessions', {});
      if (mode === target) return send(res, 200, { ok:true, mode });
      if (target === 'skip') return send(res, 409, { error:'This session was started without the option to skip permissions.', mode, restart:true });
      return send(res, 409, { error:'Claude doesn\'t offer that mode in this session, so it was left as it was.', mode });
    }
    const endMatch = pathname.match(/^\/api\/sessions\/(.+)\/end$/);
    if (endMatch && req.method === 'POST') {
      const session = sessions(true).find(s => s.id === decodeURIComponent(endMatch[1]));
      if (!session) return send(res, 404, { error:'Session not found.' });
      const target = endTarget(session);
      if (!target) return send(res, 409, { error:'This session is not running anything Shed can end.' });
      const result = await endAgent(target);
      cancelSessionTasks(session.id, 'Session ended from Shed.');
      sessions(true); broadcast('sessions', {});
      if (!result.stopped) return send(res, 409, { error:`${label[session.harness] || session.harness} did not stop. Close its Terminal window on the Mac.` });
      return send(res, 200, { ok:true, forced:Boolean(result.forced), mode:result.mode || 'ended' });
    }
    if (pathname.startsWith('/api/sessions/') && req.method === 'GET') {
      const id = decodeURIComponent(pathname.slice('/api/sessions/'.length));
      const session = sessions().find(s => s.id === id);
      // Whether the drawer offers "End session": something Shed can stop is running for it.
      const canEnd = Boolean(session && session.liveState !== 'history' && (session.tty || ['claude', 'codex'].includes(session.harness) || tasks.some(t => t.sessionId === session.id && active.has(t.id))));
      return session ? sendVersioned(req, res, { session:{ ...publicSession(session), canEnd }, messages: sessionMessages(session) }) : send(res, 404, { error: 'Session not found.' });
    }
    if (pathname === '/api/route' && req.method === 'POST') {
      const input = await body(req);
      if (!input.prompt || typeof input.prompt !== 'string') return send(res, 400, { error: 'Enter a prompt.' });
      const { route, cwd } = await routeInput(input, true);
      const selectedHarness = route.session?.harness || route.harness;
      const model = await decideModel(input.prompt, selectedHarness, modelConfig(selectedHarness, settings.modelRouting), { preview:true, override:input.model || '', session:route.session });
      const ranked = rankSessions(input.prompt, sessions().filter(s => !s.hidden && (!cwd || s.cwd === cwd) && (s.harness !== 'gemini' || Boolean(s.cwd)) && (input.harness && input.harness !== 'auto' ? s.harness === input.harness : harnessHealth()[s.harness]?.state === 'ready')), input.harness || 'auto').slice(0, 3);
      return send(res, 200, { route: { session: route.session && publicSession(route.session), harness:selectedHarness, reason: route.reason, confidence: route.confidence, source: 'local preview', model:model.model, modelReason:model.reason }, suggestions: ranked.map(x => ({ session: publicSession(x.session), score: x.score, reason: x.reason })) });
    }
    if (pathname === '/api/followup-preview' && req.method === 'POST') {
      const input = await body(req);
      if (typeof input.prompt !== 'string' || !input.prompt.trim() || !input.sessionId) return send(res, 400, { error: 'Enter a follow-up for a session.' });
      const { route, model } = await planTask({ ...input, prompt:input.prompt.slice(0, 20000), harness:'auto', newSession:false });
      return send(res, 200, { route: { harness:route.session?.harness || route.harness, handoff:Boolean(route.handoff), reason:route.reason, fallbackReason:route.fallbackReason || '', confidence:route.score ?? null, source:route.source, model:model.model, modelSource:model.source, modelReason:model.reason } });
    }
    if (pathname === '/api/tasks' && req.method === 'GET') { refreshQueuedTasks(); syncExchanges(); syncComparisons(); return sendVersioned(req, res, { tasks: tasks.slice(0, 60).map(taskSummary), exchanges:exchanges.all().slice(0, 40).map(exchangeSummary) }); }
    // Introducing two sessions: the first is told how to reach the second, with the person's note on what to work out.
    if (pathname === '/api/exchanges/introduce' && req.method === 'POST') {
      const input = await body(req);
      const list = sessions(true);
      const from = list.find(s => s.id === input.from), to = list.find(s => s.id === input.to);
      const note = typeof input.note === 'string' ? input.note.slice(0, 4000) : '';
      const why = !from || !to ? 'Pick two open sessions.' : from.id === to.id ? 'Pick a different session to talk to.' : [from, to].some(s => s.liveState === 'history') ? 'Both sessions need to be open.' : [from, to].some(s => !TALKERS.includes(s.harness)) ? 'Only Claude and Codex sessions can talk to each other for now.' : '';
      if (why) return send(res, 400, { error:why });
      const { exchange } = await sendExchange({ kind:'intro', from, to, message:note, prompt:`↔ Talk to ${label[to.harness] || to.harness} · ${projectLabel(to.cwd)}${note ? `: ${note}` : ''}`, agentPrompt:introductionPrompt(to, note, shedCli), target:from });
      return send(res, 201, { exchange:exchangeSummary(exchange) });
    }
    // Attachments: the file is the request body; its name comes in X-File-Name (URI-encoded).
    if (pathname === '/api/uploads' && req.method === 'POST') {
      let name = '';
      try { name = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { name = ''; }
      try { return send(res, 201, await uploads.stage(req, name)); }
      catch (error) { return send(res, error.status || 400, { error:error.message }); }
    }
    const uploadMatch = pathname.match(/^\/api\/uploads\/([\w-]+)$/);
    if (uploadMatch && req.method === 'DELETE') { uploads.discard(uploadMatch[1]); return send(res, 200, { ok:true }); }
    if (pathname === '/api/tasks' && req.method === 'POST') {
      let input = await body(req);
      const attachmentIds = Array.isArray(input.attachments) ? input.attachments.filter(id => typeof id === 'string' && UPLOAD_ID.test(id)).slice(0, 10) : [];
      input = { ...input, attachments:attachmentIds, attachmentPaths:[] };
      if (attachmentIds.length && typeof input.prompt === 'string' && !input.prompt.trim()) input.prompt = attachmentIds.length > 1 ? 'Take a look at these files.' : 'Take a look at this file.';
      if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20000) return send(res, 400, { error: 'Prompt must be between 1 and 20,000 characters.' });
      let { input:planned, route, cwd, model } = await planTask(input);
      input = planned;
      // A new session in a git project works on a branch of its own, in its own checkout (continuations/handoffs stay in the original folder).
      const ownBranch = !route.session && !route.handoffFrom && cwd && input.ownBranch !== false && settings.ownBranch !== false ? await sessionWorktree(cwd, input.prompt) : null;
      if (ownBranch) cwd = ownBranch.path;
      if (route.session?.liveState === 'working' && !['codex', 'claude'].includes(route.session.harness) && !(route.session.harness === 'antigravity' && route.session.tty)) {
        if (input.queueIfBusy) {
          const item = queue.enqueue({ sessionId:route.session.id, prompt:input.prompt, mode:input.mode, model:input.model, followup:input.followup, attachments:attachmentIds, skipPermissions:Boolean(input.skipPermissions) });
          broadcast('queue', { sessionId:route.session.id });
          return send(res, 202, { queued:true, item:queueSummary(item), items:queue.forSession(route.session.id).map(queueSummary) });
        }
        return send(res, 409, { error: 'This desktop session is still working. Wait for it to finish before sending a follow-up.' });
      }
      if (route.session && [...active.values()].some(child => child.layaSessionId === route.session.id)) {
        if (input.queueIfBusy) {
          const item = queue.enqueue({ sessionId:route.session.id, prompt:input.prompt, mode:input.mode, model:input.model, followup:input.followup, attachments:attachmentIds, skipPermissions:Boolean(input.skipPermissions) });
          broadcast('queue', { sessionId:route.session.id });
          return send(res, 202, { queued:true, item:queueSummary(item), items:queue.forSession(route.session.id).map(queueSummary) });
        }
        return send(res, 409, { error: 'This session is already running a task.' });
      }
      // Capture an automatic hidden Git checkpoint before a Build-mode turn so the user can rewind in one tap.
      let preCheckpoint = null;
      const targetCwd = route.session?.cwd || cwd;
      if (input.mode !== 'plan' && targetCwd && !ownBranch) {
        preCheckpoint = await captureCheckpoint(targetCwd, { sessionId:route.session?.id || '', label:`Before: ${titleFor(input.prompt)}`, kind:'pre-turn' }).catch(() => null);
      }
      const task = startTask(input, route, model, cwd);
      if (preCheckpoint) { preCheckpoint.taskId = task.id; checkpoints.add(preCheckpoint); task.preCheckpointId = preCheckpoint.id; saveTasks(); }
      if (ownBranch) { Object.assign(task, { branch:ownBranch.branch, project:ownBranch.project }); saveTasks(); }
      if (route.session && active.has(task.id)) active.get(task.id).layaSessionId = route.session.id;
      return send(res, 201, { task });
    }
    if (pathname.startsWith('/api/tasks/') && req.method === 'GET') {
      refreshQueuedTasks();
      const task = tasks.find(t => t.id === pathname.slice('/api/tasks/'.length));
      return task ? sendVersioned(req, res, { task:publicTask(task) }) : send(res, 404, { error: 'Task not found.' });
    }
    if (pathname.endsWith('/cancel') && pathname.startsWith('/api/tasks/') && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const task = tasks.find(t => t.id === id), child = active.get(id);
      if (task && child) { updateTask(task, { status: 'cancelling' }); child.kill('SIGTERM'); return send(res, 200, { task }); }
      // A task running in a Terminal window: end the agent in that window.
      if (task?.delivery === 'terminal' && task.tty && ['running', 'cancelling'].includes(task.status)) {
        const command = cliProcessNames(task.harness);
        const pid = pidOnTty(task.tty, command);
        const thread = task.harness === 'codex' && task.sessionId?.startsWith('codex:') ? task.sessionId.slice('codex:'.length) : '';
        const result = pid ? await endAgent({ pid, command, codexThread:thread }) : { stopped:true };
        if (!result.stopped) return send(res, 409, { error:`${label[task.harness] || task.harness} did not stop. Close its Terminal window on the Mac.` });
        updateTask(task, { status:'cancelled', error:'Cancelled from Shed.', updatedAt:new Date().toISOString() });
        if (task.sessionId) cancelSessionTasks(task.sessionId, 'Session ended from Shed.');
        sessions(true); broadcast('sessions', {});
        return send(res, 200, { task });
      }
      return send(res, 404, { error: 'Running task not found.' });
    }
    return send(res, 404, { error: 'Not found.' });
  } catch (error) { return send(res, 400, { error: error.message || 'Request failed.' }); }
});

server.listen(port, host, () => {
  console.log(`\nShed is ready at http://localhost:${port}`);
  if (lanEnabled) { for (const addresses of Object.values(os.networkInterfaces())) for (const address of addresses || []) if (address.family === 'IPv4' && !address.internal) console.log(`Phone on this network (plain http): http://${address.address}:${port}`); }
  else console.log('Wi-Fi access is off: phones connect through the secure link. Set SHED_LAN=1 to allow plain http on this network.');
  console.log('Sign in with the password set from the Mac browser.\n');
  console.log(`Harnesses: ${Object.entries(available).map(([name, yes]) => `${name} ${yes ? 'ready' : 'view only'}`).join(' · ')}`);
  if (process.env.LAYA_PRELOAD !== '0') getLaya().then(() => console.log('\nLaya local decision model is ready.')).catch(error => console.error(`\nLaya preload failed: ${error.message}`));
  checkHealth().catch(error => console.error(`Harness health check failed: ${error.message}`));
  // Warm-up, so no phone request pays a first-time cost: the app's files compressed, the Terminal helper running,
  // and the git root of every open session's folder known.
  setImmediate(() => {
    for (const name of fs.readdirSync(publicDir)) staticEntry(path.join(publicDir, name));
    if (process.env.SHED_TERMINAL_WORKER !== '0' && process.platform === 'darwin') readTerminalAsync('/dev/ttys-warmup', 1).catch(() => {});
    for (const session of sessions().filter(s => s.liveState !== 'history' && s.cwd)) repoRoot(session.cwd).catch(() => {});
  });
  setInterval(() => checkHealth().catch(error => console.error(`Harness health check failed: ${error.message}`)), 60000).unref();
  watchAndNotify();
  setInterval(() => { sessions(true); watchAndNotify(); drainQueue().catch(() => {}); }, 10000).unref();
  let lastRemoteKey = JSON.stringify(remoteStatus());
  setInterval(() => {
    const status = remoteStatus(), key = JSON.stringify(status);
    if (key !== lastRemoteKey) { lastRemoteKey = key; broadcast('remote', status); }
  }, 3000).unref();
  setInterval(() => autoCloseIdle().catch(error => console.error(`Auto-close failed: ${error.message}`)), 600000).unref();
});
