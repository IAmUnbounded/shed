import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { remoteStore, probeTailscale, findCloudflared, findTailscale, effectiveMode, cleanHttpsUrl } from './remote.js';

// Gives Shed its HTTPS remote address. Supports:
//   - tailscale:  free private permanent HTTPS via `tailscale serve` (WireGuard E2EE)
//   - cloudflare: free permanent HTTPS on your own domain via a Cloudflare Named Tunnel token
//   - quick:      instant zero-setup Cloudflare Quick Tunnel (URL changes on restart)
//   - custom:     user-managed reverse proxy URL (Caddy, Nginx, Tailscale Funnel, etc.)
//   - off:        local Mac only
// Watches .jev-data/remote.json so switching modes or clicking Reconnect takes effect immediately.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.LAYA_DATA_DIR || process.env.JEV_DATA_DIR || path.join(root, '.jev-data');
const port = Number(process.env.PORT || 4378);
fs.mkdirSync(dataDir, { recursive:true, mode:0o700 });

const store = remoteStore(dataDir);
const quickUrl = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

let child = null;
let retryTimer = null;
let healthTimer = null;
let configKey = '';
let activeMode = '';
let backoffMs = 2000;
let stopping = false;
let generation = 0;

function runTailscale(args, timeout = 12000) {
  const bin = findTailscale();
  if (!bin) return Promise.resolve({ ok:false, stdout:'', stderr:'Tailscale is not installed.' });
  return new Promise(resolve => {
    execFile(bin, args, { encoding:'utf8', timeout }, (error, stdout, stderr) => {
      resolve({ ok:!error, stdout:stdout || '', stderr:stderr || '', error });
    });
  });
}

function keyOf(cfg) {
  return JSON.stringify([cfg.mode, cfg.cloudflare?.hostname || '', cfg.cloudflare?.token || '', cfg.customUrl || '', cfg.restartAt || 0]);
}

function clearTimers() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
}

async function teardownPrevious(nextMode) {
  clearTimers();
  const prev = child;
  child = null;
  if (prev) prev.kill('SIGTERM');
  if (activeMode === 'tailscale' && nextMode !== 'tailscale') {
    await runTailscale(['serve', '--https=443', 'off'], 5000).catch(() => {});
  }
  activeMode = '';
}

function scheduleRetry(gen, ms = backoffMs) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (!stopping && gen === generation) start(gen);
  }, ms);
  backoffMs = Math.min(backoffMs * 2, 30000);
}

async function startTailscale(gen, fallbackToQuick) {
  const ts = await probeTailscale({ fresh:true });
  if (gen !== generation) return;
  if (!ts.installed || !ts.running || !ts.hostname) {
    if (fallbackToQuick) return startCloudflareQuick(gen);
    store.writeStatus({ mode:'tailscale', state:'error', url:'', permanent:true, detail:ts.detail });
    return scheduleRetry(gen, 15000);
  }
  store.writeStatus({ mode:'tailscale', state:'connecting', url:'', permanent:true, detail:`Configuring Tailscale HTTPS for ${ts.hostname}…` });
  const serve = await runTailscale(['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`], 15000);
  if (gen !== generation) return;
  if (!serve.ok) {
    const raw = `${serve.stderr}\n${serve.stdout}`.trim();
    const enableUrl = raw.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
    const hint = enableUrl
      ? `Enable Tailscale Serve once at ${enableUrl}`
      : (raw.split('\n').find(Boolean) || 'Tailscale Serve could not start. Check that HTTPS certificates are enabled in Tailscale.');
    if (fallbackToQuick) return startCloudflareQuick(gen, `Tailscale Serve not enabled yet (${hint}). Using temporary Quick Tunnel for now.`);
    store.writeStatus({ mode:'tailscale', state:'error', url:'', permanent:true, detail:hint });
    return scheduleRetry(gen, 30000);
  }
  activeMode = 'tailscale';
  backoffMs = 2000;
  store.writeStatus({ mode:'tailscale', state:'connected', url:ts.url, permanent:true, detail:`Private permanent HTTPS via Tailscale (${ts.hostname}).` });
  healthTimer = setInterval(async () => {
    if (gen !== generation || stopping) return;
    const now = await probeTailscale({ fresh:true });
    if (gen !== generation) return;
    if (now.running && now.url) {
      store.writeStatus({ mode:'tailscale', state:'connected', url:now.url, permanent:true, detail:`Private permanent HTTPS via Tailscale (${now.hostname}).` });
    } else {
      store.writeStatus({ mode:'tailscale', state:'error', url:'', permanent:true, detail:now.detail });
    }
  }, 30000);
}

function startCloudflareNamed(gen, { hostname, token }) {
  const bin = findCloudflared();
  if (!bin) {
    store.writeStatus({ mode:'cloudflare', state:'error', url:'', permanent:true, detail:'cloudflared is not installed. Run: brew install cloudflared' });
    return scheduleRetry(gen, 30000);
  }
  activeMode = 'cloudflare';
  store.writeStatus({ mode:'cloudflare', state:'connecting', url:'', permanent:true, detail:`Connecting Cloudflare tunnel for ${hostname}…` });
  // Pass TUNNEL_TOKEN via environment, never argv, so it never appears in `ps`.
  const proc = spawn(bin, ['tunnel', '--no-autoupdate', 'run'], {
    cwd:root,
    env:{ ...process.env, TUNNEL_TOKEN:token },
    stdio:['ignore', 'pipe', 'pipe'],
  });
  child = proc;
  let lastError = '';
  const handle = chunk => {
    const value = chunk.toString();
    process.stdout.write(value);
    if (gen !== generation || child !== proc) return;
    if (/Registered tunnel connection/i.test(value)) {
      backoffMs = 2000;
      store.writeStatus({ mode:'cloudflare', state:'connected', url:`https://${hostname}`, permanent:true, detail:`Permanent HTTPS via your Cloudflare tunnel (${hostname}).` });
    }
    const errLine = value.split('\n').find(l => /\b(ERR|failed|invalid|unauthorized)\b/i.test(l) && !/stream \d+ canceled/i.test(l));
    if (errLine) lastError = errLine.trim().slice(0, 220);
  };
  proc.stdout.on('data', handle);
  proc.stderr.on('data', handle);
  proc.on('error', error => {
    if (gen !== generation || child !== proc) return;
    child = null;
    store.writeStatus({ mode:'cloudflare', state:'error', url:'', permanent:true, detail:`cloudflared failed: ${error.message}` });
    scheduleRetry(gen);
  });
  proc.on('close', code => {
    if (gen !== generation || child !== proc) return;
    child = null;
    if (stopping) return;
    store.writeStatus({ mode:'cloudflare', state:'connecting', url:'', permanent:true, detail:lastError || `Tunnel disconnected (exit ${code ?? 1}). Reconnecting…` });
    scheduleRetry(gen);
  });
}

function startCloudflareQuick(gen, note = '') {
  const bin = findCloudflared();
  if (!bin) {
    store.writeStatus({ mode:'quick', state:'error', url:'', permanent:false, detail:'cloudflared is not installed. Run: brew install cloudflared' });
    return scheduleRetry(gen, 30000);
  }
  activeMode = 'quick';
  store.writeStatus({ mode:'quick', state:'connecting', url:'', permanent:false, detail:note || 'Opening a temporary Cloudflare Quick Tunnel…' });
  const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
    cwd:root,
    stdio:['ignore', 'pipe', 'pipe'],
  });
  child = proc;
  let lastError = '';
  const handle = chunk => {
    const value = chunk.toString();
    process.stdout.write(value);
    if (gen !== generation || child !== proc) return;
    const matches = value.match(quickUrl);
    if (matches?.length) {
      const url = cleanHttpsUrl(matches.at(-1));
      if (url) {
        backoffMs = 2000;
        store.writeStatus({ mode:'quick', state:'connected', url, permanent:false, detail:note || 'Temporary HTTPS link (changes if the tunnel restarts). Use Tailscale or your own Cloudflare tunnel for a permanent link.' });
      }
    }
    const errLine = value.split('\n').find(l => /\b(ERR|failed|unable)\b/i.test(l) && !/stream \d+ canceled/i.test(l));
    if (errLine) lastError = errLine.trim().slice(0, 220);
  };
  proc.stdout.on('data', handle);
  proc.stderr.on('data', handle);
  proc.on('error', error => {
    if (gen !== generation || child !== proc) return;
    child = null;
    store.writeStatus({ mode:'quick', state:'error', url:'', permanent:false, detail:`cloudflared failed: ${error.message}` });
    scheduleRetry(gen);
  });
  proc.on('close', code => {
    if (gen !== generation || child !== proc) return;
    child = null;
    if (stopping) return;
    store.writeStatus({ mode:'quick', state:'connecting', url:'', permanent:false, detail:lastError || `Quick Tunnel disconnected (exit ${code ?? 1}). Reconnecting…` });
    scheduleRetry(gen);
  });
}

async function start(gen = ++generation) {
  const cfg = store.readConfig();
  configKey = keyOf(cfg);
  const ts = cfg.mode === 'auto' ? await probeTailscale({ fresh:true }) : null;
  if (gen !== generation || stopping) return;
  const target = effectiveMode(cfg, ts);
  await teardownPrevious(target);
  if (gen !== generation || stopping) return;

  if (target === 'off') {
    activeMode = 'off';
    store.writeStatus({ mode:'off', state:'off', url:'', permanent:false, detail:'Remote access is turned off.' });
    return;
  }
  if (target === 'custom') {
    activeMode = 'custom';
    store.writeStatus({ mode:'custom', state:'connected', url:cfg.customUrl, permanent:true, detail:`Using your custom HTTPS address (${cfg.customUrl}).` });
    return;
  }
  if (target === 'cloudflare') {
    if (!cfg.cloudflare.hostname || !cfg.cloudflare.token) {
      store.writeStatus({ mode:'cloudflare', state:'error', url:'', permanent:true, detail:'Add your domain name and Cloudflare tunnel token in Settings.' });
      return;
    }
    return startCloudflareNamed(gen, cfg.cloudflare);
  }
  if (target === 'tailscale') {
    return startTailscale(gen, cfg.mode === 'auto');
  }
  return startCloudflareQuick(gen);
}

// Re-apply whenever Settings → Remote access saves a new mode or triggers a reconnect.
fs.watchFile(store.configFile, { interval:1000 }, () => {
  const cfg = store.readConfig();
  if (keyOf(cfg) === configKey) return;
  backoffMs = 2000;
  start();
});

start();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    clearTimers();
    child?.kill(signal);
    if (!['off', 'custom'].includes(activeMode)) {
      store.writeStatus({ mode:activeMode || 'quick', state:'offline', url:'', permanent:false, detail:'Tunnel stopped.' });
    }
    process.exit(0);
  });
}
