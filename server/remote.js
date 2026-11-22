import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';

// Remote access configuration & status (shared by server/index.js and server/tunnel.js).
// Supports free permanent HTTPS via Tailscale or your own Cloudflare Named Tunnel,
// instant zero-setup Cloudflare Quick Tunnels, custom reverse proxies, or local-only mode.
export const REMOTE_MODES = ['auto', 'tailscale', 'cloudflare', 'quick', 'custom', 'off'];
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function cleanHostname(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  return HOSTNAME_RE.test(host) ? host : '';
}

export function cleanHttpsUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) return '';
    if (!HOSTNAME_RE.test(parsed.hostname.toLowerCase())) return '';
    const portPart = parsed.port ? `:${parsed.port}` : '';
    return `https://${parsed.hostname.toLowerCase()}${portPart}`;
  } catch { return ''; }
}

export function cleanToken(value) {
  const token = String(value || '').trim();
  return token && token.length <= 4096 && !/\s/.test(token) ? token : '';
}

function findBinary(name, extraPaths = [], envVar = '') {
  if (envVar && process.env[envVar]) return process.env[envVar];
  const found = spawnSync('which', [name], { encoding:'utf8', timeout:2000 }).stdout?.trim();
  if (found) return found;
  return extraPaths.find(file => fs.existsSync(file)) || '';
}

export function findCloudflared() {
  return findBinary('cloudflared', ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'], 'CLOUDFLARED');
}

export function findTailscale() {
  return findBinary('tailscale', [
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ], 'TAILSCALE');
}

function execAsync(bin, args, timeout = 5000) {
  return new Promise(resolve => {
    execFile(bin, args, { encoding:'utf8', timeout, maxBuffer:2 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok:!error, code:error?.code ?? 0, stdout:stdout || '', stderr:stderr || '', error });
    });
  });
}

let tailscaleCache = { at:0, value:null };
export async function probeTailscale({ fresh = false, bin = findTailscale(), run = execAsync } = {}) {
  if (!fresh && tailscaleCache.value && Date.now() - tailscaleCache.at < 15000) return tailscaleCache.value;
  let value;
  if (!bin) {
    value = { installed:false, running:false, hostname:'', url:'', tailnet:'', detail:'Tailscale is not installed on this Mac.' };
  } else {
    const res = await run(bin, ['status', '--json'], 3500);
    if (!res.ok) {
      const msg = (res.stderr || res.stdout || res.error?.message || '').trim().split('\n')[0] || 'Tailscale is not running.';
      value = { installed:true, running:false, hostname:'', url:'', tailnet:'', detail:msg };
    } else {
      try {
        const data = JSON.parse(res.stdout);
        const running = data.BackendState === 'Running';
        const hostname = cleanHostname(data.Self?.DNSName || '');
        const tailnet = String(data.MagicDNSSuffix || '').trim();
        const url = running && hostname ? `https://${hostname}` : '';
        const detail = !running
          ? `Tailscale is ${String(data.BackendState || 'stopped').toLowerCase()}. Open Tailscale and sign in.`
          : !hostname
            ? 'Turn on MagicDNS and HTTPS Certificates in your Tailscale admin console.'
            : `Signed in to ${tailnet || 'Tailscale'} as ${hostname}.`;
        value = { installed:true, running:running && Boolean(hostname), hostname, url, tailnet, detail };
      } catch {
        value = { installed:true, running:false, hostname:'', url:'', tailnet:'', detail:'Could not read Tailscale status.' };
      }
    }
  }
  tailscaleCache = { at:Date.now(), value };
  return value;
}

export function resetTailscaleCache() {
  tailscaleCache = { at:0, value:null };
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function effectiveMode(config, tailscale) {
  if (config.mode !== 'auto') return config.mode;
  if (config.cloudflare?.hostname && config.cloudflare?.token) return 'cloudflare';
  if (tailscale?.running && tailscale?.hostname) return 'tailscale';
  return 'quick';
}

export function remoteStore(dataDir, { env = process.env } = {}) {
  const configFile = path.join(dataDir, 'remote.json');
  const statusFile = path.join(dataDir, 'remote-status.json');
  const urlFile = path.join(dataDir, 'remote-url');

  function readSaved() {
    try {
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      const mode = REMOTE_MODES.includes(raw.mode) ? raw.mode : 'auto';
      const hostname = cleanHostname(raw.cloudflare?.hostname || '');
      const token = cleanToken(raw.cloudflare?.token || '');
      const customUrl = cleanHttpsUrl(raw.customUrl || '');
      const restartAt = Number(raw.restartAt) || 0;
      return { mode, cloudflare:{ hostname, token }, customUrl, restartAt };
    } catch {
      return { mode:'auto', cloudflare:{ hostname:'', token:'' }, customUrl:'', restartAt:0 };
    }
  }

  function readConfig() {
    const saved = readSaved();
    const envMode = REMOTE_MODES.includes(env.SHED_REMOTE_MODE) ? env.SHED_REMOTE_MODE : '';
    const envHost = cleanHostname(env.SHED_TUNNEL_HOST || '');
    const envToken = cleanToken(env.SHED_TUNNEL_TOKEN || '');
    const envPublicUrl = cleanHttpsUrl(env.SHED_PUBLIC_URL || '');
    const cloudflare = {
      hostname: envHost || saved.cloudflare.hostname,
      token: envToken || saved.cloudflare.token,
    };
    const customUrl = envPublicUrl || saved.customUrl;
    const mode = envMode || (envPublicUrl ? 'custom' : envHost && envToken ? 'cloudflare' : saved.mode);
    return { mode, cloudflare, customUrl, restartAt:saved.restartAt };
  }

  function publicConfig() {
    const cfg = readConfig();
    const envOverride = Boolean(env.SHED_REMOTE_MODE || env.SHED_TUNNEL_HOST || env.SHED_TUNNEL_TOKEN || env.SHED_PUBLIC_URL);
    return {
      mode: cfg.mode,
      cloudflare: { hostname:cfg.cloudflare.hostname, hasToken:Boolean(cfg.cloudflare.token) },
      customUrl: cfg.customUrl,
      envOverride,
    };
  }

  function saveConfig(input = {}) {
    const current = readSaved();
    const mode = input.mode === undefined ? current.mode : String(input.mode);
    if (!REMOTE_MODES.includes(mode)) throw new Error('Choose a valid remote access mode.');

    let hostname = current.cloudflare.hostname;
    let token = current.cloudflare.token;
    if (input.cloudflare && typeof input.cloudflare === 'object') {
      if (input.cloudflare.hostname !== undefined) {
        const rawHost = String(input.cloudflare.hostname).trim();
        if (rawHost && !cleanHostname(rawHost)) throw new Error('Enter a valid domain name, like shed.example.com.');
        hostname = cleanHostname(rawHost);
      }
      if (input.cloudflare.clearToken) token = '';
      else if (typeof input.cloudflare.token === 'string' && input.cloudflare.token.trim()) {
        const parsed = cleanToken(input.cloudflare.token);
        if (!parsed) throw new Error('That Cloudflare tunnel token is not valid.');
        token = parsed;
      }
    }

    let customUrl = current.customUrl;
    if (input.customUrl !== undefined) {
      const rawUrl = String(input.customUrl).trim();
      if (rawUrl && !cleanHttpsUrl(rawUrl)) throw new Error('Enter an https:// address, like https://shed.example.com.');
      customUrl = cleanHttpsUrl(rawUrl);
    }

    if (mode === 'cloudflare' && (!hostname || !token)) {
      throw new Error('Enter both your domain name and Cloudflare tunnel token.');
    }
    if (mode === 'custom' && !customUrl) {
      throw new Error('Enter the https:// address where Shed is reachable.');
    }

    const next = {
      mode,
      cloudflare: { hostname, token },
      customUrl,
      restartAt: input.restart ? Date.now() : current.restartAt,
    };
    fs.mkdirSync(dataDir, { recursive:true, mode:0o700 });
    fs.writeFileSync(configFile, JSON.stringify(next, null, 2), { mode:0o600 });
    fs.chmodSync(configFile, 0o600);
    return publicConfig();
  }

  function readLegacyUrl() {
    try {
      return cleanHttpsUrl(fs.readFileSync(urlFile, 'utf8'));
    } catch { return ''; }
  }

  function writeStatus(status) {
    const url = cleanHttpsUrl(status.url || '');
    const record = {
      mode: status.mode || 'quick',
      state: status.state || 'offline',
      url,
      permanent: Boolean(status.permanent),
      detail: String(status.detail || '').slice(0, 300),
      updatedAt: new Date().toISOString(),
      pid: process.pid,
    };
    fs.mkdirSync(dataDir, { recursive:true, mode:0o700 });
    const tmp = `${statusFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), { mode:0o600 });
    fs.renameSync(tmp, statusFile);
    if (record.state === 'connected' && url) {
      fs.writeFileSync(urlFile, url + '\n', { mode:0o600 });
      fs.chmodSync(urlFile, 0o600);
    } else {
      fs.rmSync(urlFile, { force:true });
    }
    return record;
  }

  function readStatus() {
    const cfg = readConfig();
    if (cfg.mode === 'custom' && cfg.customUrl) {
      return { mode:'custom', state:'connected', url:cfg.customUrl, permanent:true, detail:'Using your custom HTTPS address.', updatedAt:null };
    }
    if (cfg.mode === 'off') {
      return { mode:'off', state:'off', url:'', permanent:false, detail:'Remote access is turned off. Shed only accepts connections on this Mac.', updatedAt:null };
    }
    try {
      const saved = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      const url = cleanHttpsUrl(saved.url || '');
      const stale = saved.pid && !processAlive(saved.pid) && ['connected', 'connecting'].includes(saved.state) && ['quick', 'cloudflare'].includes(saved.mode);
      if (stale) {
        return { mode:saved.mode || cfg.mode, state:'offline', url:'', permanent:Boolean(saved.permanent), detail:'The tunnel service is not running right now.', updatedAt:saved.updatedAt || null };
      }
      return {
        mode: saved.mode || cfg.mode,
        state: saved.state || (url ? 'connected' : 'offline'),
        url: saved.state === 'connected' ? url : '',
        permanent: Boolean(saved.permanent),
        detail: String(saved.detail || ''),
        updatedAt: saved.updatedAt || null,
      };
    } catch {
      const legacy = readLegacyUrl();
      if (legacy) {
        const permanent = !legacy.endsWith('.trycloudflare.com');
        return { mode:permanent ? 'cloudflare' : 'quick', state:'connected', url:legacy, permanent, detail:permanent ? 'Connected via permanent tunnel.' : 'Connected via temporary Cloudflare Quick Tunnel.', updatedAt:null };
      }
      return { mode:cfg.mode, state:'offline', url:'', permanent:false, detail:'Tunnel is starting or not running.', updatedAt:null };
    }
  }

  function url() {
    return readStatus().url;
  }

  return { configFile, statusFile, urlFile, readConfig, publicConfig, saveConfig, writeStatus, readStatus, url };
}
