import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { loadWorktreeConfig } from './worktree-config.js';

// Per-project quick scripts runner (tests, lint, typecheck, build, or custom .shed.yaml scripts).
// Only executes named scripts discovered from the repo's own .shed.yaml / .shed.json / package.json —
// never accepts arbitrary shell strings over HTTP.

const LONG_RUNNING = /^(dev|start|serve|watch|preview|storybook|tunnel)$/i;
const PRIORITY = ['test', 'test:unit', 'lint', 'typecheck', 'check', 'build', 'format', 'test:latency'];
const DEFAULT_TIMEOUT = 90000;

export function discoverScripts(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return [];
  const scripts = [];
  const seen = new Set();

  // 1. Explicit scripts from .shed.yaml / .shed.json
  const cfg = loadWorktreeConfig(cwd);
  if (cfg.namedScripts && typeof cfg.namedScripts === 'object') {
    for (const [name, command] of Object.entries(cfg.namedScripts)) {
      if (!name || !command || seen.has(name)) continue;
      seen.add(name);
      scripts.push({ id: `cfg:${name}`, name, command, source: cfg.source || 'config' });
    }
  }

  // 2. package.json scripts (skipping long-running dev servers so mobile taps don't hang)
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const entries = Object.entries(pkg.scripts || {}).filter(([name, cmd]) => typeof cmd === 'string' && cmd.trim() && !LONG_RUNNING.test(name));
      entries.sort(([a], [b]) => {
        const ia = PRIORITY.indexOf(a), ib = PRIORITY.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
      });
      for (const [name, command] of entries) {
        if (seen.has(name)) continue;
        seen.add(name);
        scripts.push({ id: `npm:${name}`, name, command, source: 'package.json' });
      }
    } catch { /* ignore malformed package.json */ }
  }

  return scripts.slice(0, 16);
}

const lastRuns = new Map(); // key: `${cwd}\0${id}` -> result

export function scriptResultsFor(cwd) {
  const out = {};
  const prefix = `${cwd}\0`;
  for (const [key, val] of lastRuns) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = val;
  }
  return out;
}

export function runProjectScript(cwd, scriptId, { timeout = DEFAULT_TIMEOUT } = {}) {
  const found = discoverScripts(cwd).find(s => s.id === scriptId);
  if (!found) return Promise.reject(new Error('That script is not defined in this project.'));
  const started = Date.now();
  const key = `${cwd}\0${found.id}`;
  const nodeBin = path.dirname(process.execPath);
  const npmBin = fs.existsSync(path.join(nodeBin, 'npm')) ? path.join(nodeBin, 'npm') : 'npm';
  const scriptPath = process.env.PATH ? `${nodeBin}:${process.env.PATH}` : `${nodeBin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return new Promise(resolve => {
    const isNpm = found.id.startsWith('npm:');
    const cmd = isNpm ? npmBin : '/bin/sh';
    const args = isNpm ? ['run', found.name] : ['-lc', found.command];
    execFile(cmd, args, {
      cwd,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, PATH: scriptPath, NO_COLOR: '1', CI: '1' },
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - started;
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
      const result = {
        id: found.id,
        name: found.name,
        command: found.command,
        ok: !error,
        code,
        timedOut: Boolean(error?.killed),
        durationMs,
        output: combined.slice(-12000),
        ranAt: new Date().toISOString(),
      };
      lastRuns.set(key, result);
      resolve(result);
    });
  });
}
