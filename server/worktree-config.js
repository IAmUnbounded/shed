import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Per-repository worktree lifecycle hooks: .shed.json, .shed.yaml, .shed.yml, or shed.yaml.
// Supports copying untracked files (like .env), symlinking heavy dependency folders (like node_modules),
// and running bounded setup / teardown shell commands when Shed creates or removes a branch worktree.

const CONFIG_FILES = ['.shed.json', '.shed.yaml', '.shed.yml', 'shed.yaml'];
const DEFAULT_SETUP_TIMEOUT = 120000;
const DEFAULT_TEARDOWN_TIMEOUT = 30000;

function unquote(value) {
  const s = value.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

// Minimal, safe YAML subset parser for flat & 1-level nested objects with string, boolean, number, or string-list values.
// Handles both concise top-level keys and nested `hooks: { setup, teardown }` / `worktree: { copy, symlink }`.
export function parseSimpleYaml(text) {
  const root = {};
  let section = null; // current top-level key holding a nested map or list
  let subkey = null; // current nested key holding a list
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent === 0) {
      subkey = null;
      const m = trimmed.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const [, key, rest] = m;
      const val = rest.replace(/\s+#.*$/, '').trim();
      if (!val) {
        section = key;
        root[key] = null;
      } else if (val.startsWith('[') && val.endsWith(']')) {
        root[key] = val.slice(1, -1).split(',').map(v => unquote(v)).filter(Boolean);
        section = null;
      } else if (val === 'true' || val === 'false') {
        root[key] = val === 'true';
        section = null;
      } else if (/^\d+$/.test(val)) {
        root[key] = Number(val);
        section = null;
      } else {
        root[key] = unquote(val);
        section = null;
      }
      continue;
    }

    if (!section) continue;
    // List item under either top-level section or nested subkey
    const item = trimmed.match(/^-\s+(.+)$/);
    if (item) {
      const value = unquote(item[1].replace(/\s+#.*$/, ''));
      if (subkey && root[section] && typeof root[section] === 'object' && !Array.isArray(root[section])) {
        if (!Array.isArray(root[section][subkey])) root[section][subkey] = [];
        root[section][subkey].push(value);
      } else {
        if (!Array.isArray(root[section])) root[section] = [];
        root[section].push(value);
      }
      continue;
    }

    // Nested key: value under a top-level section (e.g. hooks:\n  setup: npm ci)
    const nested = trimmed.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (nested) {
      const [, key, rest] = nested;
      if (!root[section] || typeof root[section] !== 'object' || Array.isArray(root[section])) root[section] = {};
      const val = rest.replace(/\s+#.*$/, '').trim();
      if (!val) {
        subkey = key;
        root[section][key] = [];
      } else if (val.startsWith('[') && val.endsWith(']')) {
        root[section][key] = val.slice(1, -1).split(',').map(v => unquote(v)).filter(Boolean);
        subkey = null;
      } else if (val === 'true' || val === 'false') {
        root[section][key] = val === 'true';
        subkey = null;
      } else if (/^\d+$/.test(val)) {
        root[section][key] = Number(val);
        subkey = null;
      } else {
        root[section][key] = unquote(val);
        subkey = null;
      }
    }
  }
  return root;
}

const asList = value => Array.isArray(value) ? value.map(v => String(v || '').trim()).filter(Boolean)
  : typeof value === 'string' && value.trim() ? [value.trim()] : [];

export function normalizeWorktreeConfig(raw = {}, source = '') {
  const hooks = raw.hooks && typeof raw.hooks === 'object' ? raw.hooks : {};
  const scripts = raw.scripts && typeof raw.scripts === 'object' ? raw.scripts : {};
  const wt = raw.worktree && typeof raw.worktree === 'object' ? raw.worktree : {};
  const copy = [...new Set([...asList(raw.copy), ...asList(wt.copy)])].slice(0, 40);
  const symlink = [...new Set([...asList(raw.symlink), ...asList(wt.symlink)])].slice(0, 40);
  const setup = [...asList(raw.setup), ...asList(hooks.setup), ...asList(hooks.postCreate), ...asList(scripts.setup)].slice(0, 20);
  const teardown = [...asList(raw.teardown), ...asList(hooks.teardown), ...asList(hooks.preRemove), ...asList(scripts.teardown)].slice(0, 20);
  const namedScripts = {};
  for (const [k, v] of Object.entries(scripts)) {
    if (k === 'setup' || k === 'teardown') continue;
    if (typeof v === 'string' && v.trim()) namedScripts[k] = v.trim();
  }
  const autoSymlink = raw.autoSymlink !== false && wt.autoSymlink !== false;
  return { source, copy, symlink, setup, teardown, namedScripts, autoSymlink };
}

export function loadWorktreeConfig(repoRoot) {
  if (!repoRoot) return normalizeWorktreeConfig({}, '');
  for (const name of CONFIG_FILES) {
    const file = path.join(repoRoot, name);
    if (!fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, 'utf8');
      const parsed = name.endsWith('.json') ? JSON.parse(text) : parseSimpleYaml(text);
      return normalizeWorktreeConfig(parsed || {}, name);
    } catch {
      return normalizeWorktreeConfig({}, name);
    }
  }
  return normalizeWorktreeConfig({}, '');
}

// Ensures relative paths stay strictly inside the repository root and never touch .git.
export function safeRepoRel(repoRoot, rel) {
  const clean = String(rel || '').trim().replace(/^\/+/, '');
  if (!clean || clean.includes('\0')) return '';
  const resolved = path.resolve(repoRoot, clean);
  const base = path.resolve(repoRoot);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return '';
  const relOut = path.relative(base, resolved);
  if (!relOut || relOut === '.git' || relOut.startsWith(`.git${path.sep}`)) return '';
  return relOut;
}

function runShell(command, cwd, env, timeout) {
  return new Promise(resolve => {
    execFile('/bin/sh', ['-lc', command], { cwd, env, timeout, maxBuffer:2 * 1024 * 1024, encoding:'utf8' }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        error: error ? (error.killed ? `Timed out after ${Math.round(timeout / 1000)}s.` : (stderr || stdout || error.message).trim().slice(-600)) : '',
      });
    });
  });
}

function isIgnoredByGit(repoRoot, rel) {
  return new Promise(resolve => {
    execFile('git', ['check-ignore', '-q', '--', rel], { cwd:repoRoot, timeout:2000 }, error => resolve(!error));
  });
}

// Runs after `git worktree add`: copies configured untracked files, symlinks dependency directories,
// and executes configured setup commands. Never throws on hook errors; reports them clearly instead.
export async function applyWorktreeSetup(repoRoot, worktreePath, branch, { runSetupCommands = true, timeout = DEFAULT_SETUP_TIMEOUT } = {}) {
  const config = loadWorktreeConfig(repoRoot);
  const copied = [], symlinked = [], commands = [], warnings = [];

  for (const entry of config.copy) {
    const rel = safeRepoRel(repoRoot, entry);
    if (!rel) { warnings.push(`Skipped unsafe copy path: ${entry}`); continue; }
    const src = path.join(repoRoot, rel), dst = path.join(worktreePath, rel);
    if (!fs.existsSync(src)) continue;
    try {
      fs.mkdirSync(path.dirname(dst), { recursive:true });
      fs.cpSync(src, dst, { recursive:true, force:false, errorOnExist:false });
      copied.push(rel);
    } catch (error) { warnings.push(`Copy ${rel} failed: ${error.message}`); }
  }

  const toSymlink = [...config.symlink];
  // Zero-config convenience: if node_modules exists in the main checkout and is gitignored, link it so npm test/dev work immediately.
  if (config.autoSymlink && !toSymlink.includes('node_modules') && fs.existsSync(path.join(repoRoot, 'package.json')) && fs.existsSync(path.join(repoRoot, 'node_modules')) && !fs.existsSync(path.join(worktreePath, 'node_modules'))) {
    if (await isIgnoredByGit(repoRoot, 'node_modules')) toSymlink.push('node_modules');
  }

  for (const entry of toSymlink) {
    const rel = safeRepoRel(repoRoot, entry);
    if (!rel) { warnings.push(`Skipped unsafe symlink path: ${entry}`); continue; }
    const src = path.join(repoRoot, rel), dst = path.join(worktreePath, rel);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    try {
      fs.mkdirSync(path.dirname(dst), { recursive:true });
      fs.symlinkSync(src, dst);
      symlinked.push(rel);
    } catch (error) { warnings.push(`Symlink ${rel} failed: ${error.message}`); }
  }

  if (runSetupCommands && config.setup.length) {
    const env = { ...process.env, SHED_PROJECT:repoRoot, SHED_WORKTREE:worktreePath, SHED_BRANCH:branch || '' };
    for (const cmd of config.setup) {
      const result = await runShell(cmd, worktreePath, env, timeout);
      commands.push({ command:cmd, ok:result.ok, output:(result.stdout || result.stderr).slice(-800), error:result.error });
      if (!result.ok) { warnings.push(`Setup failed (${cmd}): ${result.error}`); break; }
    }
  }

  return { source:config.source, copied, symlinked, commands, warnings };
}

export async function runWorktreeTeardown(repoRoot, worktreePath, branch, { timeout = DEFAULT_TEARDOWN_TIMEOUT } = {}) {
  const config = loadWorktreeConfig(repoRoot);
  if (!config.teardown.length || !fs.existsSync(worktreePath)) return { ran:[], warnings:[] };
  const env = { ...process.env, SHED_PROJECT:repoRoot, SHED_WORKTREE:worktreePath, SHED_BRANCH:branch || '' };
  const ran = [], warnings = [];
  for (const cmd of config.teardown) {
    const result = await runShell(cmd, worktreePath, env, timeout);
    ran.push({ command:cmd, ok:result.ok, error:result.error });
    if (!result.ok) warnings.push(`Teardown failed (${cmd}): ${result.error}`);
  }
  return { ran, warnings };
}
