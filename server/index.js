import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { discoverSessions, publicSession, sessionMessages, codexQueuedProgress, claudeTerminalProgress, findCodexTranscript } from './sessions.js';
import { codexWorkState, terminalIsAsking, terminalState } from './live.js';
import { claudeLiveSessions, typeIntoTerminal, readTerminal, openTerminal, pidOnTty, agentInForeground, typeIntoTerminalAsync, readTerminalAsync, openTerminalAsync } from './terminal.js';
import { rankSessions } from './router.js';
import { decideRoute, decideFollowup, decideModel, probeLaya, getLaya, layaStatus } from './laya.js';
import { harnesses, modelConfig, validateModelConfig } from './models.js';
import { harnessHealth, refreshHarnessHealth } from './health.js';
import { initPush, pushPublicKey, subscribe, unsubscribe, notify, isSubscribed, pushCount } from './notify.js';
import { listArtifacts, resolveInside, sendFile } from './files.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const dataDir = process.env.LAYA_DATA_DIR || process.env.JEV_DATA_DIR || path.join(root, '.jev-data');
const taskFile = path.join(dataDir, 'tasks.json');
const settingsFile = path.join(dataDir, 'settings.json');
const remoteUrlFile = path.join(dataDir, 'remote-url');
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
const available = Object.fromEntries(['codex', 'claude', 'gemini', 'pi', 'opencode'].map(name => [name, commandExists(name)]));
const active = new Map();
let cached = { at: 0, sessions: [] };
let tasks = loadTasks();
let settings = loadSettings();
initPush(dataDir);
const attempts = new Map();

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
function remoteUrl() {
  try {
    const value = fs.readFileSync(remoteUrlFile, 'utf8').trim();
    return /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(value) ? value : '';
  } catch { return ''; }
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
const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded'];
// A request typed on this Mac: loopback, and not relayed by the tunnel (which also connects over loopback).
function isDirectLocal(req) {
  return LOOPBACK.includes(req.socket.remoteAddress) && !PROXY_HEADERS.some(h => req.headers[h] !== undefined);
}
// The visitor's real address: cloudflared connects locally and reports the original one in CF-Connecting-IP.
function clientIp(req) {
  if (LOOPBACK.includes(req.socket.remoteAddress) && typeof req.headers['cf-connecting-ip'] === 'string') return req.headers['cf-connecting-ip'].slice(0, 64);
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
function sessions(force = false) {
  if (force || Date.now() - cached.at > 10000) cached = { at: Date.now(), sessions: withCodexTerminals(discoverSessions()) };
  return cached.sessions;
}
// Codex runs through a background service, so its Terminal windows can't be found from open files.
// Shed remembers the windows it opened (on the task) and treats a session as live while Codex still runs there.
function codexTerminals() {
  const found = new Map();
  for (const task of tasks) {
    if (task.harness !== 'codex' || task.delivery !== 'terminal' || !task.nativeSessionId || !task.tty || found.has(task.nativeSessionId)) continue;
    found.set(task.nativeSessionId, task.tty);
  }
  for (const [id, tty] of found) if (!pidOnTty(tty, 'codex')) found.delete(id);
  return found;
}
function withCodexTerminals(list) {
  const terminals = codexTerminals();
  if (!terminals.size) return list;
  return list.map(session => {
    const tty = session.harness === 'codex' && !session.tty && terminals.get(session.nativeId);
    if (!tty) return session;
    const screen = terminalState(tty, 'codex');
    return { ...session, tty, liveState:screen.asking ? 'asking' : screen.active ? 'working' : codexWorkState(session.file) };
  });
}
// A new Claude or Codex window can stop at a startup question (trust this folder, install an update, pick an option)
// before it takes the message. Shed reads the window, keeps the task open while it waits, and tells the person once.
const STARTUP_PROMPT = /trust|Update available|update now|Press enter|Enter to confirm|Esc to cancel|❯\s*1\.|›\s*1\.\s|Would you like|Do you want/i;
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
function refreshTerminalTasks() {
  const running = tasks.filter(task => task.delivery === 'terminal' && task.status === 'running' && !task.starting);
  if (!running.length) return;
  const live = claudeLiveSessions();
  let changed = false;
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
  for (const task of running) if (task.status === 'failed' && task.undelivered && task.handoffFrom) returnToOrigin(task);
}
// Runs whether or not anyone has Shed open: keeps task progress current and sends push notifications for
// finished tasks and for agents that start waiting on a permission prompt.
const seen = { tasks:null, asking:null, at:0 };
const label = { claude:'Claude', codex:'Codex', gemini:'Gemini', pi:'Pi', opencode:'OpenCode' };
const notifyPrefs = () => ({ finished:true, asking:true, ...(settings.notify || {}) });
function firstLine(text) { return String(text || '').replace(/[#*`>_]/g, '').split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 140) || ''; }
async function watchAndNotify() {
  try { refreshQueuedTasks(); } catch (error) { console.error(`Task refresh failed: ${error.message}`); }
  const statuses = new Map(tasks.map(t => [t.id, t.status]));
  const asking = new Set(sessions().filter(s => s.liveState === 'asking').map(s => s.id));
  const first = !seen.tasks;
  const prefs = notifyPrefs();
  if (!first && pushCount()) {
    for (const task of tasks) {
      // A task created since the last check counts as running, so one that finishes within a single interval still notifies.
      const before = seen.tasks.get(task.id) ?? (Date.parse(task.createdAt) >= seen.at ? 'running' : undefined);
      if (!['running', 'queued'].includes(before) || !['completed', 'failed'].includes(task.status) || !prefs.finished) continue;
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
// Shared by sending and the drawer preview, so the preview shows exactly what a send would do.
async function planTask(input) {
  let { route, cwd, healthyHarnesses, health } = await routeInput(input);
  if (input.sessionId) {
    const origin = route.session;
    const currentReady = healthyHarnesses.includes(origin.harness) && available[origin.harness];
    const followup = await decideFollowup(input.prompt, origin, { mode:input.followup || 'auto', availableHarnesses:healthyHarnesses.filter(name => available[name]), currentReady, currentDetail:health[origin.harness]?.detail });
    if (followup.handoff) {
      route = { ...followup, handoffFrom:origin.id };
      cwd = origin.cwd;
      input = { ...input, agentPrompt:handoffPrompt(origin, input.prompt), model:followup.source === 'selected' ? input.model : '' };
    } else route = { ...followup, session:origin };
  }
  const selectedHarness = route.session?.harness || route.harness;
  const model = selectedHarness === 'codex' && route.session?.liveState !== 'history' && route.session && !route.session.tty
    ? { model:'', reason:'The open Codex session keeps its current model.', source:'session' }
    : ['claude', 'codex'].includes(selectedHarness) && route.session?.tty
    ? { model:'', reason:'Typed into the open terminal, so the session keeps its own model and permissions.', source:'session' }
    : await decideModel(input.prompt, selectedHarness, modelConfig(selectedHarness, settings.modelRouting), { override:input.model || '', session:route.session });
  return { input, route, cwd, model };
}

async function routeInput(input, preview = false) {
  const cachedHealth = harnessHealth();
  const health = Object.keys(cachedHealth || {}).length ? cachedHealth : await refreshHarnessHealth();
  if (Object.keys(cachedHealth || {}).length) refreshHarnessHealth().catch(() => {});
  const healthyHarnesses = Object.entries(health).filter(([, status]) => status.state === 'ready').map(([name]) => name);
  if (input.harness && input.harness !== 'auto' && !healthyHarnesses.includes(input.harness)) throw new Error(health[input.harness]?.detail || `${input.harness} is not ready.`);
  const all = sessions();
  let requestedCwd = typeof input.cwd === 'string' && all.some(s => s.cwd === input.cwd) ? input.cwd : '';
  if (input.newWorkspace) {
    const name = String(input.newWorkspace).trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,59}$/.test(name) || name === '.' || name === '..') throw new Error('Workspace names must be 1–60 letters, numbers, spaces, dots, dashes, or underscores.');
    const workspaceRoot = path.join(os.homedir(), 'Shed Workspaces');
    requestedCwd = path.join(workspaceRoot, name);
    if (!preview) fs.mkdirSync(requestedCwd, { recursive:true });
  }
  const candidates = input.newSession ? [] : all.filter(s => s.liveState !== 'working' && (!requestedCwd || s.cwd === requestedCwd) && (s.harness !== 'gemini' || Boolean(s.cwd)) && (input.harness && input.harness !== 'auto' ? s.harness === input.harness : healthyHarnesses.includes(s.harness)));
  const fallback = input.harness && input.harness !== 'auto' ? input.harness : healthyHarnesses[0];
  if (!fallback && !input.sessionId) throw new Error('No coding harness is ready. Check the harness status in the sidebar.');
  // The task planner checks follow-up health and permits only explicit handoffs.
  if (input.sessionId && preview) {
    const selected = all.find(s => s.id === input.sessionId);
    if (selected && !healthyHarnesses.includes(selected.harness)) throw new Error(health[selected.harness]?.detail || `${selected.harness} is not ready.`);
  }
  const route = await decideRoute(input.prompt, input.sessionId ? all : candidates, input.harness || 'auto', input.sessionId || null, { preview, availableHarnesses:healthyHarnesses });
  if (!route.session && route.source !== 'laya') route.harness = fallback;
  return { route, cwd: requestedCwd, healthyHarnesses, health };
}
// Sent with every response: no framing (stops tap-jacking of approve buttons), no referrer leaks, scripts only from Shed.
const SECURITY_HEADERS = {
  'X-Frame-Options':'DENY',
  'Referrer-Policy':'no-referrer',
  'X-Content-Type-Options':'nosniff',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
};
// Polled data carries a short version tag. When the page already has that version, the reply is just {"same":true},
// so a phone re-downloads and re-renders only what changed.
function sendVersioned(req, res, value) {
  const body = JSON.stringify(value);
  const v = crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16);
  if (new URL(req.url, 'http://x').searchParams.get('v') === v) return send(res, 200, { same:true, v });
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
  res.end(`${body.slice(0, -1)},"v":"${v}"}`);
}
// Lists only need what a row shows; the full task (reply text and all) loads when one is opened.
const taskSummary = t => ({ id:t.id, title:t.title, status:t.status, harness:t.harness, sessionId:t.sessionId, cwd:t.cwd, createdAt:t.createdAt, updatedAt:t.updatedAt, delivery:t.delivery, tty:t.tty, waitingOn:t.waitingOn, handoffFrom:t.handoffFrom, returnedTo:t.returnedTo, model:t.model, modelSource:t.modelSource, routeSource:t.routeSource, error:(t.error || '').slice(0, 300) });
const publicTask = ({ agentPrompt, transcriptFile, claudeSessionId, nativeSessionId, submitRetries, lastSubmitRetry, waitNotified, ...rest }) => rest;
function send(res, status, value, headers = {}) {
  const data = JSON.stringify(value);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
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
const pairingCodes = new Map(); // code -> expiry time; single use
function newPairingCode() {
  for (const [code, expires] of pairingCodes) if (expires < Date.now()) pairingCodes.delete(code);
  const code = crypto.randomBytes(18).toString('base64url');
  pairingCodes.set(code, Date.now() + 10 * 60 * 1000);
  return code;
}
function usePairingCode(code) {
  if (typeof code !== 'string' || !pairingCodes.has(code)) return false;
  const valid = pairingCodes.get(code) > Date.now();
  pairingCodes.delete(code);
  return valid;
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
    const { input, route, cwd, model } = await planTask({ prompt:task.prompt, sessionId:task.handoffFrom, followup:'stay', harness:'auto', model:'', newSession:false });
    const back = startTask(input, route, model, cwd);
    Object.assign(task, { returnedTo:back.id, error:`${task.error} Shed sent your message back to the original ${back.harness} session instead.`.trim() }); saveTasks();
    notify({ title:`Handoff to ${label[task.harness] || task.harness} did not start`, body:`Your message went back to the original ${label[back.harness] || back.harness} session.`, url:`/?task=${encodeURIComponent(back.id)}`, tag:`task-${task.id}` }).catch(() => {});
  } catch (error) {
    Object.assign(task, { error:`${task.error} Shed could not send it back to the original session either: ${error.message}`.trim() }); saveTasks();
  }
}
function titleFor(prompt) { return prompt.replace(/\s+/g, ' ').trim().slice(0, 90); }
function updateTask(task, patch) { Object.assign(task, patch); saveTasks(); }

function queueCodexTask(task, session) {
  Object.assign(task, { status:'queued', delivery:'queue', transcriptFile:session.file, model:'', modelReason:'The open Codex session keeps its current model.', modelSource:'session', error:'', output:'Waiting for the open Codex session to accept this message.', updatedAt:new Date().toISOString() });
  saveTasks();
  const child = spawn('codex', ['queue', '--thread', session.nativeId, '--message', task.prompt], { cwd:task.cwd, env:{ ...process.env, NO_COLOR:'1' }, stdio:['ignore', 'pipe', 'pipe'] });
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
const CONTROL_KEYS = ['\u0003', '\u001b[Z', '1', '2', '3', ''];
const loginCommands = { codex:['codex', 'login'], claude:['claude', 'auth', 'login'], gemini:['gemini'], opencode:['opencode', 'auth', 'login'], pi:['pi'] };
const loginTerminals = new Map();

// Claude runs in a visible Terminal: typed into the tab that already holds the session, or a new window that resumes it.
// The request returns as soon as the task exists; typing into Terminal (about a second of AppleScript and a pause)
// runs in the background, so sending feels instant and the server keeps answering other requests meanwhile.
function startTerminalTask(task, route, modelDecision, cwd, agentPrompt, skipPermissions) {
  Object.assign(task, { delivery:'terminal', agentPrompt, starting:true, output:'Sending to the terminal…' });
  saveTasks();
  deliverToTerminal(task, route, modelDecision, cwd, agentPrompt, skipPermissions).finally(() => { delete task.starting; saveTasks(); });
}
async function deliverToTerminal(task, route, modelDecision, cwd, agentPrompt, skipPermissions) {
  const session = route.session;
  const label = task.harness === 'codex' ? 'Codex' : 'Claude';
  try {
    // Only type into a session's window while the agent is still running there; otherwise resume it in a new window.
    if (session?.tty && agentInForeground(session.tty, task.harness)) {
      Object.assign(task, { tty:session.tty });
      await typeIntoTerminalAsync(session.tty, agentPrompt, { prompt:true, agent:task.harness });
      Object.assign(task, { tty:session.tty, transcriptFile:session.file, [task.harness === 'codex' ? 'nativeSessionId' : 'claudeSessionId']:session.nativeId, permissions:'terminal', output:`Typed into the open Terminal tab. Waiting for ${label} to pick it up.` });
    } else if (task.harness === 'codex') {
      const promptDir = path.join(dataDir, 'prompts');
      fs.mkdirSync(promptDir, { recursive:true, mode:0o700 });
      const promptFile = path.join(promptDir, `${task.id}.txt`);
      fs.writeFileSync(promptFile, agentPrompt, { mode:0o600 });
      // --no-alt-screen keeps Codex's output in Terminal's scrollback, which is what the drawer's terminal view reads.
      const argv = ['codex', ...(session ? ['resume', session.nativeId] : []), '--no-alt-screen', ...(modelDecision.model ? ['--model', modelDecision.model] : []), ...(skipPermissions ? ['--dangerously-bypass-approvals-and-sandbox'] : [])];
      const tty = await openTerminalAsync(cwd, argv, promptFile);
      Object.assign(task, { tty, permissions:skipPermissions ? 'skip' : 'default', ...(session ? { transcriptFile:session.file, nativeSessionId:session.nativeId } : {}), output:`Opened a new Terminal window on the Mac (${tty.replace('/dev/', '')}).${skipPermissions ? '' : ' Codex will ask there before running commands; answer from the Terminal view.'}` });
    } else {
      const promptDir = path.join(dataDir, 'prompts');
      fs.mkdirSync(promptDir, { recursive:true, mode:0o700 });
      const promptFile = path.join(promptDir, `${task.id}.txt`);
      fs.writeFileSync(promptFile, agentPrompt, { mode:0o600 });
      const argv = ['claude', ...(session ? ['--resume', session.nativeId] : []), ...(modelDecision.model ? ['--model', modelDecision.model] : []), ...(skipPermissions ? ['--dangerously-skip-permissions'] : [])];
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
  const agentPrompt = (input.agentPrompt || input.prompt).trim();
  const harness = route.session?.harness || route.harness;
  if (!available[harness]) throw new Error(`${harness} CLI is not installed on this desktop.`);
  if (harness === 'gemini' && route.session && !route.session.cwd && !requestedCwd) throw new Error('This Gemini record does not include its original project path, so it cannot be resumed safely.');
  const cwd = route.session?.cwd && fs.existsSync(route.session.cwd) ? route.session.cwd :
    requestedCwd && fs.existsSync(requestedCwd) && fs.statSync(requestedCwd).isDirectory() ? requestedCwd : root;
  const task = {
    id: crypto.randomUUID(), prompt: input.prompt.trim(), title: titleFor(input.prompt),
    status: 'running', harness, sessionId: route.session?.id || null,
    handoffFrom: route.handoffFrom || null,
    routeReason: route.reason, routeSource: route.source || 'local', routeFallbackReason:route.fallbackReason || '',
    model:modelDecision.model, modelReason:modelDecision.reason, modelSource:modelDecision.source, modelFallbackReason:modelDecision.fallbackReason || '', cwd, output: '', error: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  tasks.unshift(task); saveTasks();
  // Codex open in the desktop app (no terminal) takes queued messages; everything else runs in a visible Terminal.
  if (harness === 'codex' && route.session && !route.session.tty && route.session.liveState !== 'history') {
    queueCodexTask(task, route.session);
    return task;
  }
  if ((harness === 'claude' && process.env.LAYA_HEADLESS_CLAUDE !== '1') || (harness === 'codex' && process.env.LAYA_HEADLESS_CODEX !== '1')) {
    startTerminalTask(task, route, modelDecision, cwd, agentPrompt, Boolean(input.skipPermissions));
    return task;
  }
  let command = harness;
  let args;
  const modelArgs = modelDecision.model ? ['--model', modelDecision.model] : [];
  if (harness === 'codex') {
    args = route.session ? ['exec', 'resume', '--json', '--skip-git-repo-check', ...modelArgs, route.session.nativeId, '-'] : ['exec', '--json', '--skip-git-repo-check', ...modelArgs, '-C', cwd, '-'];
  } else if (harness === 'claude') {
    args = ['-p', agentPrompt, '--output-format', 'stream-json', '--verbose', ...modelArgs, ...(route.session ? ['--resume', route.session.nativeId] : [])];
  } else if (harness === 'gemini') {
    args = ['-p', agentPrompt, '-o', 'stream-json', ...modelArgs, ...(route.session ? ['--resume', route.session.nativeId] : [])];
  } else if (harness === 'pi') {
    args = ['-p', '--mode', 'json', ...modelArgs, ...(route.session ? ['--session', route.session.file] : []), agentPrompt];
  } else {
    args = ['run', '--format', 'json', ...modelArgs, ...(route.session ? ['--session', route.session.nativeId] : []), agentPrompt];
  }
  const child = spawn(command, args, { cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  active.set(task.id, child);
  if (harness === 'codex') child.stdin.end(agentPrompt); else child.stdin.end();
  let pending = '';
  function acceptLine(line) {
    let item;
    try { item = JSON.parse(line); } catch { if (line.trim()) task.output += line + '\n'; return; }
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
    if (harness === 'codex' && route.session && task.status !== 'cancelling' && code !== 0 && /already has an active writer|thread-store conflict/i.test(task.error)) {
      active.delete(task.id);
      queueCodexTask(task, route.session);
      return;
    }
    updateTask(task, { status: task.status === 'cancelling' ? 'cancelled' : code === 0 ? 'completed' : 'failed', exitCode: code, updatedAt: new Date().toISOString() });
    active.delete(task.id); sessions(true);
  });
  return task;
}

function serveStatic(req, res, pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(publicDir, name);
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'Not found' });
  const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
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
      return send(res, device.status === 'approved' ? 200 : 202, { ok:true, status:device.status, device:publicDevice(device, device) }, { 'Set-Cookie':sessionCookie(req, key) });
    }
    // Lets a device that signed in with the password see whether the Mac has approved it yet.
    if (pathname === '/api/auth/device' && req.method === 'GET') {
      const device = deviceFor(req);
      return send(res, 200, { status:device?.status || 'none', name:device?.name || '' });
    }
    if (!isAuthorized(req)) return send(res, 401, { error: 'Authentication required.' });
    if (pathname === '/api/connect' && req.method === 'GET') {
      const base = remoteUrl() || (lanEnabled ? `http://${lanAddress()}:${port}` : '');
      if (!base) return send(res, 200, { url:'', secure:false, qr:'', phoneConnectedAt:settings.phoneConnectedAt || null });
      // The QR code carries a one-time pairing code (10 minutes), so a phone that scans it is approved without a second step.
      const url = isLocalRequest(req) ? `${base}/#pair=${newPairingCode()}` : base;
      const svg = await QRCode.toString(url, { type:'svg', margin:1, errorCorrectionLevel:'M', color:{ dark:'#1e1c19', light:'#fffdf8' } });
      return send(res, 200, { url, link:base, secure:Boolean(remoteUrl()), qr:svg, phoneConnectedAt:settings.phoneConnectedAt || null });
    }
    if (pathname === '/api/me' && req.method === 'GET') return send(res, 200, { ok:true, local:isLocalRequest(req), lanEnabled, pendingDevices:isLocalRequest(req) ? devices().filter(d => d.status === 'pending' && Date.now() - Date.parse(d.createdAt) < 86400000).map(d => publicDevice(d)) : [], phoneConnectedAt:settings.phoneConnectedAt || null, available, laya:layaStatus(), hostname:os.hostname(), phoneUrl:lanEnabled ? `http://${lanAddress()}:${port}` : '', remoteUrl:remoteUrl() });
    if (pathname === '/api/harness-health' && req.method === 'GET') return send(res, 200, { harnesses:await refreshHarnessHealth(new URL(req.url, 'http://x').searchParams.get('force') === '1') });
    if (pathname === '/api/settings' && req.method === 'GET') return send(res, 200, { laya:layaStatus(), local:true });
    if (pathname === '/api/laya/test' && req.method === 'POST') return send(res, 200, await probeLaya());
    if (pathname === '/api/models' && req.method === 'GET') return send(res, 200, { configs:Object.fromEntries(harnesses.map(harness => [harness, modelConfig(harness, settings.modelRouting)])) });
    if (pathname === '/api/models' && req.method === 'POST') {
      const input = await body(req);
      const validated = validateModelConfig(input.harness, input);
      settings = { ...settings, modelRouting:{ ...(settings.modelRouting || {}), [input.harness]:validated } };
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
      return send(res, 200, { ok:true });
    }
    if (pathname === '/api/devices/revoke-others' && req.method === 'POST') {
      const current = deviceFor(req);
      settings = { ...settings, devices:devices().filter(d => d.id === current?.id) }; saveSettings();
      return send(res, 200, { ok:true });
    }
    if (pathname === '/api/sessions' && req.method === 'GET') return sendVersioned(req, res, { sessions: sessions().map(publicSession) });
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
      if (filesMatch[3] === 'files') return send(res, 200, { root:path.basename(root), files:listArtifacts(root) });
      const query = new URL(req.url, 'http://x').searchParams;
      const file = resolveInside(root, query.get('path'));
      if (!file) return send(res, 404, { error:'That file is not available.' });
      return sendFile(req, res, file, query.get('download') === '1');
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
        return sendVersioned(req, res, { tty, text });
      }
      if (req.method === 'POST') {
        const input = await body(req);
        if (typeof input.text !== 'string' || input.text.length > 4000) return send(res, 400, { error:'Send up to 4,000 characters.' });
        if (!agentInForeground(tty, [loginCommands[name][0], 'node'])) return send(res, 409, { error:'The sign-in has finished in that window, so Shed will not type into it.' });
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
        return text === null ? send(res, 404, { error:'That Terminal window is closed.' }) : sendVersioned(req, res, { tty:task.tty, text });
      }
      if (req.method === 'POST') {
        const input = await body(req);
        if (!CONTROL_KEYS.includes(input.text)) return send(res, 400, { error:'Only the terminal control keys can be sent here.' });
        if (!agentInForeground(task.tty, [task.harness, 'node'])) return send(res, 409, { error:`${task.harness} is no longer running in that Terminal window.` });
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
        return text === null ? send(res, 404, { error:'That Terminal tab is no longer open.' }) : sendVersioned(req, res, { tty:session.tty, text });
      }
      if (req.method === 'POST') {
        const input = await body(req);
        // Only the on-screen control keys, and only while the agent is the foreground program: never free text into a shell.
        if (!CONTROL_KEYS.includes(input.text)) return send(res, 400, { error:'Only the terminal control keys can be sent here. Send messages from the message box.' });
        if (!agentInForeground(session.tty, session.harness)) return send(res, 409, { error:`${session.harness} is no longer running in that Terminal tab.` });
        await typeIntoTerminalAsync(session.tty, input.text);
        return send(res, 200, { ok:true });
      }
    }
    if (pathname.startsWith('/api/sessions/') && req.method === 'GET') {
      const id = decodeURIComponent(pathname.slice('/api/sessions/'.length));
      const session = sessions().find(s => s.id === id);
      return session ? sendVersioned(req, res, { session: publicSession(session), messages: sessionMessages(session) }) : send(res, 404, { error: 'Session not found.' });
    }
    if (pathname === '/api/route' && req.method === 'POST') {
      const input = await body(req);
      if (!input.prompt || typeof input.prompt !== 'string') return send(res, 400, { error: 'Enter a prompt.' });
      const { route, cwd } = await routeInput(input, true);
      const selectedHarness = route.session?.harness || route.harness;
      const model = await decideModel(input.prompt, selectedHarness, modelConfig(selectedHarness, settings.modelRouting), { preview:true, override:input.model || '', session:route.session });
      const ranked = rankSessions(input.prompt, sessions().filter(s => (!cwd || s.cwd === cwd) && (s.harness !== 'gemini' || Boolean(s.cwd)) && (input.harness && input.harness !== 'auto' ? s.harness === input.harness : harnessHealth()[s.harness]?.state === 'ready')), input.harness || 'auto').slice(0, 3);
      return send(res, 200, { route: { session: route.session && publicSession(route.session), harness:selectedHarness, reason: route.reason, confidence: route.confidence, source: 'local preview', model:model.model, modelReason:model.reason }, suggestions: ranked.map(x => ({ session: publicSession(x.session), score: x.score, reason: x.reason })) });
    }
    if (pathname === '/api/followup-preview' && req.method === 'POST') {
      const input = await body(req);
      if (typeof input.prompt !== 'string' || !input.prompt.trim() || !input.sessionId) return send(res, 400, { error: 'Enter a follow-up for a session.' });
      const { route, model } = await planTask({ ...input, prompt:input.prompt.slice(0, 20000), harness:'auto', newSession:false });
      return send(res, 200, { route: { harness:route.session?.harness || route.harness, handoff:Boolean(route.handoff), reason:route.reason, fallbackReason:route.fallbackReason || '', confidence:route.score ?? null, source:route.source, model:model.model, modelSource:model.source, modelReason:model.reason } });
    }
    if (pathname === '/api/tasks' && req.method === 'GET') { refreshQueuedTasks(); return sendVersioned(req, res, { tasks: tasks.slice(0, 60).map(taskSummary) }); }
    if (pathname === '/api/tasks' && req.method === 'POST') {
      let input = await body(req);
      if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20000) return send(res, 400, { error: 'Prompt must be between 1 and 20,000 characters.' });
      let { input:planned, route, cwd, model } = await planTask(input);
      input = planned;
      if (route.session?.liveState === 'working' && !['codex', 'claude'].includes(route.session.harness)) return send(res, 409, { error: 'This desktop session is still working. Wait for it to finish before sending a follow-up.' });
      if (route.session && [...active.values()].some(child => child.layaSessionId === route.session.id)) return send(res, 409, { error: 'This session is already running a task.' });
      const task = startTask(input, route, model, cwd);
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
      if (!task || !child) return send(res, 404, { error: 'Running task not found.' });
      updateTask(task, { status: 'cancelling' }); child.kill('SIGTERM');
      return send(res, 200, { task });
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
  refreshHarnessHealth().catch(error => console.error(`Harness health check failed: ${error.message}`));
  setInterval(() => refreshHarnessHealth().catch(error => console.error(`Harness health check failed: ${error.message}`)), 60000).unref();
  watchAndNotify();
  setInterval(() => { sessions(true); watchAndNotify(); }, 10000).unref();
});
