import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { harnesses, cliCommand, parseAntigravityModels, setAntigravityCatalog } from './models.js';

export const harnessNames = harnesses;
const credentialEnv = {
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  opencode: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'],
  pi: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'],
};
let checkedAt = 0;
let pending;
let snapshot = Object.fromEntries(harnessNames.map(name => [name, { installed:false, state:'checking', detail:'Checking the CLI', checkedAt:null }]));

function run(command, args, timeoutMs = 5000) {
  return new Promise(resolve => {
    let output = '', stdout = '';
    let settled = false;
    let child;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    try { child = spawn(command, args, { env:{ ...process.env, NO_COLOR:'1', CI:'1' }, stdio:['ignore','pipe','pipe'] }); }
    catch (error) { return resolve({ ok:false, output:error.message, stdout:'' }); }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok:false, output:'The CLI did not respond in time.', stdout:stdout.trim() }); }, timeoutMs);
    child.stdout.on('data', chunk => { const s = chunk.toString(); stdout = (stdout + s).slice(-8000); output = (output + s).slice(-8000); });
    child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-8000); });
    child.on('error', error => finish({ ok:false, output:error.message, stdout:'' }));
    child.on('close', code => finish({ ok:code === 0, output:output.trim(), stdout:stdout.trim() }));
  });
}

// A CLI that crashes on start can print pages of loader output (a Homebrew update that removed a library prints every
// path it tried). The sidebar shows one line, so this keeps what is useful and says how to fix it when that is known.
export function startFailure(output) {
  const text = String(output || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  const missing = text.match(/Library not loaded: (\S+)/);
  if (missing) {
    const library = path.basename(missing[1]);
    const binary = text.match(/Referenced from: (?:<[^>]*> )?(\S+)/)?.[1] || '';
    const formula = binary.match(/\/Cellar\/([^/]+)\//)?.[1];
    if (formula) return `Can't start: ${formula} is missing ${library} after a Homebrew update. Fix it with: brew upgrade ${formula}`;
    return `Can't start: ${binary ? path.basename(binary) : 'the CLI'} is missing ${library}. Reinstalling it usually fixes this.`;
  }
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const line = lines.find(l => /^(\w*Error\b|error:)/i.test(l)) || lines[0] || 'CLI did not respond';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function result(installed, state, detail) {
  return { installed, state, detail, checkedAt:new Date().toISOString() };
}

async function probe(name) {
  const command = cliCommand(name);
  const installed = spawnSync('which', [command], { encoding:'utf8', timeout:2000 }).status === 0;
  if (!installed) {
    if (name === 'antigravity' && (fs.existsSync('/Applications/Antigravity.app') || fs.existsSync(path.join(os.homedir(), '.gemini', 'antigravity')))) {
      return result(false, 'offline', 'View only: install agy CLI to send messages (brew install --cask antigravity-cli)');
    }
    return result(false, 'offline', 'CLI is not installed');
  }
  const version = await run(command, ['--version'], 12000);
  if (!version.ok) return result(true, 'offline', startFailure(version.output));
  if (name === 'codex') {
    const auth = await run(command, ['login', 'status']);
    return auth.ok && /logged in/i.test(auth.output) ? result(true, 'ready', 'CLI responds; Codex login is active') : result(true, 'needs_auth', 'Sign in with codex login');
  }
  if (name === 'gemini') {
    if (credentialEnv.gemini.some(key => Boolean(process.env[key]))) return result(true, 'ready', 'CLI responds; Gemini API key is configured');
    try {
      const home = os.homedir();
      const settings = JSON.parse(fs.readFileSync(path.join(home, '.gemini/settings.json'), 'utf8'));
      const selected = settings.security?.auth?.selectedType;
      const credentials = JSON.parse(fs.readFileSync(path.join(home, '.gemini/oauth_creds.json'), 'utf8'));
      if (selected === 'oauth-personal' && credentials.access_token && Number(credentials.expiry_date) > Date.now() + 60000) return result(true, 'ready', 'CLI responds; Gemini OAuth token is current');
      return result(true, 'needs_auth', 'Login expired; sign in from the Mac');
    } catch { return result(true, 'needs_auth', 'Sign in to Gemini from the Mac'); }
  }
  if (name === 'opencode') {
    if (credentialEnv.opencode.some(key => Boolean(process.env[key]))) return result(true, 'ready', 'CLI responds; a provider key is configured');
    const auth = await run(command, ['auth', 'list']);
    const output = auth.output.replace(/\x1b\[[0-9;]*m/g, '');
    return auth.ok && /\b[1-9]\d* credentials?\b/i.test(output) ? result(true, 'ready', 'CLI responds; provider credentials are configured') : result(true, 'needs_auth', 'Connect a provider on the Mac');
  }
  if (name === 'claude') {
    const auth = await run(command, ['auth', 'status']);
    let loggedIn = false;
    try { loggedIn = JSON.parse(auth.output).loggedIn === true; } catch { loggedIn = /logged in/i.test(auth.output); }
    return auth.ok && loggedIn ? result(true, 'ready', 'CLI responds; Claude login is active') : result(true, 'needs_auth', 'Sign in to Claude Code from the Mac');
  }
  if (name === 'pi') {
    if (credentialEnv.pi.some(key => Boolean(process.env[key]))) return result(true, 'ready', 'CLI responds; a provider key is configured');
    try {
      const file = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), 'auth.json');
      const credentials = JSON.parse(fs.readFileSync(file, 'utf8'));
      const usable = Object.values(credentials).some(entry => entry && typeof entry === 'object' && (entry.type === 'api_key' && Boolean(entry.key) || entry.type === 'oauth' && Boolean(entry.access) && Number(entry.expires) > Date.now() + 60000));
      return usable ? result(true, 'ready', 'CLI responds; Pi provider credentials are configured') : result(true, 'needs_auth', 'Connect a Pi provider on the Mac');
    } catch { return result(true, 'needs_auth', 'Connect a Pi provider on the Mac'); }
  }
  if (name === 'antigravity') {
    const home = os.homedir();
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
      if (settings.modelProvider === 'gemini') {
        return process.env.GEMINI_API_KEY
          ? result(true, 'ready', 'CLI responds; Gemini API key is configured')
          : result(true, 'needs_auth', 'GEMINI_API_KEY is not set for Antigravity CLI');
      }
    } catch {}
    let adcEnabled = process.env.AGY_ADC_AUTH === 'true';
    if (!adcEnabled) {
      try { adcEnabled = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'config', 'config.json'), 'utf8')).userSettings?.enableAdc === true; } catch {}
    }
    const adcFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(home, '.config', 'gcloud', 'application_default_credentials.json');
    const models = await run(command, ['models'], 20000);
    const parsed = parseAntigravityModels(models.stdout || models.output);
    if (models.ok) {
      if (parsed.length) setAntigravityCatalog(parsed);
      if (!parsed.length && /auth(?:entication)?\s+required|not\s+authenticated|sign\s+in|log\s+in/i.test(models.output)) {
        return result(true, 'needs_auth', 'Sign in to Antigravity from the Mac');
      }
      return result(true, 'ready', adcEnabled ? 'CLI responds; Google Cloud ADC is configured' : 'CLI responds; Antigravity login is active');
    }
    if (adcEnabled && fs.existsSync(adcFile)) return result(true, 'ready', 'CLI responds; Google Cloud ADC is configured');
    if (/auth|login|sign.?in|credential|token|keyring|unauthenticated/i.test(models.output)) {
      return result(true, 'needs_auth', 'Sign in to Antigravity from the Mac');
    }
    return result(true, 'offline', startFailure(models.output));
  }
  return result(true, 'unknown', 'CLI responds; provider login could not be checked');
}

export function harnessHealth() { return snapshot; }
export async function refreshHarnessHealth(force = false) {
  if (pending) return pending;
  if (!force && Date.now() - checkedAt < 30000) return snapshot;
  pending = Promise.all(harnessNames.map(async name => [name, await probe(name)])).then(rows => {
    snapshot = Object.fromEntries(rows);
    checkedAt = Date.now();
    return snapshot;
  }).finally(() => { pending = undefined; });
  return pending;
}
