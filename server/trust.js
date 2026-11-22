import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code and Codex ask whether to trust a folder the first time they open in it, and wait there until someone answers
// at the Mac, so a session started from the phone (or shared from Instagram) sat unstarted. Shed creates the folders under
// Shed Workspaces itself, so before opening an agent there it records the folder as trusted, exactly as answering Yes would.
// Folders anywhere else are left to the person.
export function shedWorkspace(dir, home = os.homedir()) {
  const root = path.join(home, 'Shed Workspaces');
  const resolved = path.resolve(dir || '');
  return resolved.startsWith(root + path.sep);
}

// Writes go to a temporary file that replaces the original in one step, so a reader never sees half a file. The agents
// rewrite these files too; reading right before writing keeps what they saved.
function replaceFile(file, text) {
  const temp = `${file}.shed-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, text, { mode:0o600 });
  fs.renameSync(temp, file);
}

export function trustForClaude(dir, { home = os.homedir() } = {}) {
  const file = path.join(home, '.claude.json');
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') return false; // Mid-write or unreadable: leave it, and Claude asks as usual.
    config = {};
  }
  const key = path.resolve(dir);
  if (config.projects?.[key]?.hasTrustDialogAccepted) return false;
  config.projects = { ...(config.projects || {}), [key]:{ ...(config.projects?.[key] || {}), hasTrustDialogAccepted:true } };
  replaceFile(file, JSON.stringify(config, null, 2));
  return true;
}

export function trustForCodex(dir, { home = os.homedir() } = {}) {
  const file = path.join(home, '.codex', 'config.toml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') return false; }
  const header = `[projects.${JSON.stringify(path.resolve(dir))}]`;
  if (text.includes(header)) return false;
  fs.mkdirSync(path.dirname(file), { recursive:true });
  replaceFile(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n${header}\ntrust_level = "trusted"\n`);
  return true;
}

export function trustForAntigravity(dir, { home = os.homedir() } = {}) {
  const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') return false;
    config = {};
  }
  const key = path.resolve(dir);
  const trusted = Array.isArray(config.trustedWorkspaces) ? config.trustedWorkspaces : [];
  if (trusted.includes(key)) return false;
  fs.mkdirSync(path.dirname(file), { recursive:true });
  replaceFile(file, JSON.stringify({ ...config, trustedWorkspaces:[...trusted, key] }, null, 2));
  return true;
}

export function trustShedWorkspace(harness, dir, options = {}) {
  if (!dir || !shedWorkspace(dir, options.home)) return false;
  try { return harness === 'claude' ? trustForClaude(dir, options) : harness === 'codex' ? trustForCodex(dir, options) : harness === 'antigravity' ? trustForAntigravity(dir, options) : false; }
  catch { return false; } // Never block a session over this; at worst the agent asks.
}
