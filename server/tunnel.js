import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Gives Shed its https address: a Cloudflare Quick Tunnel, whose random URL changes when it restarts, or a named
// Cloudflare tunnel when relay.json holds its { hostname, token }, so the address (and phone push subscriptions) never
// change. This process restarts the tunnel when that file changes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.LAYA_DATA_DIR || process.env.JEV_DATA_DIR || path.join(root, '.jev-data');
const urlFile = path.join(dataDir, 'remote-url');
const relayFile = path.join(dataDir, 'relay.json');
const port = Number(process.env.PORT || 4378);
fs.mkdirSync(dataDir, { recursive:true, mode:0o700 });
fs.rmSync(urlFile, { force:true });

function findCloudflared() {
  if (process.env.CLOUDFLARED) return process.env.CLOUDFLARED;
  const found = spawnSync('which', ['cloudflared'], { encoding:'utf8' }).stdout?.trim();
  return found || ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'].find(file => fs.existsSync(file)) || 'cloudflared';
}
function readRelay() {
  try {
    const relay = JSON.parse(fs.readFileSync(relayFile, 'utf8'));
    return relay.token && /^[a-z0-9.-]+$/.test(relay.hostname || '') ? relay : null;
  } catch { return null; }
}
function writeUrl(url) {
  fs.writeFileSync(urlFile, url + '\n', { mode:0o600 });
  fs.chmodSync(urlFile, 0o600);
}

const cloudflared = findCloudflared();
const quickUrl = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
let child = null, relayKey = '', stopping = false;

function start() {
  const relay = readRelay();
  relayKey = relay ? `${relay.hostname}|${relay.token}` : '';
  fs.rmSync(urlFile, { force:true });
  // The relay token goes through the environment, not argv, so it does not show up in `ps`.
  child = relay
    ? spawn(cloudflared, ['tunnel', '--no-autoupdate', 'run'], { cwd:root, env:{ ...process.env, TUNNEL_TOKEN:relay.token }, stdio:['ignore', 'pipe', 'pipe'] })
    : spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { cwd:root, stdio:['ignore', 'pipe', 'pipe'] });
  const current = child;
  const readOutput = chunk => {
    const value = chunk.toString();
    process.stdout.write(value);
    if (relay && /Registered tunnel connection/i.test(value)) writeUrl(`https://${relay.hostname}`);
    const matches = !relay && value.match(quickUrl);
    if (matches?.length) writeUrl(matches.at(-1));
  };
  current.stdout.on('data', readOutput);
  current.stderr.on('data', readOutput);
  current.on('error', error => { process.stderr.write(`${error.message}\n`); fs.rmSync(urlFile, { force:true }); process.exitCode = 1; });
  current.on('close', code => {
    if (current !== child) return; // replaced by a restart
    fs.rmSync(urlFile, { force:true });
    if (!stopping) process.exit(code || 1); // launchd starts it again
  });
}
// Adding or removing relay.json swaps the tunnel without restarting the whole service.
fs.watchFile(relayFile, { interval:3000 }, () => {
  const relay = readRelay();
  if ((relay ? `${relay.hostname}|${relay.token}` : '') === relayKey) return;
  const old = child;
  child = null;
  old?.kill('SIGTERM');
  start();
});
start();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; child?.kill(signal); process.exit(0); });
