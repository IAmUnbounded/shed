import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { repoRoot, parseNumstat, parseUnifiedDiff } from './git.js';

// Hidden Git checkpoints per turn.
// Snapshots the full workspace (tracked + untracked, respecting .gitignore and .shed/) using a temporary GIT_INDEX_FILE
// and stores it under refs/shed/checkpoints/<id> so git log, git branch, and git stash stay untouched.

const KEEP_TOTAL = 300;
const KEEP_PER_SESSION = 30;
const MAX_DIFF = 512 * 1024;

function runGit(cwd, args, { env = {}, timeout = 15000, okCodes = [0], maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      timeout,
      maxBuffer,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', NO_COLOR: '1', ...env },
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      if (okCodes.includes(code)) return resolve({ stdout, stderr, code });
      const detail = (stderr || stdout || error?.message || '').trim().split('\n').filter(Boolean).slice(-3).join(' ');
      reject(new Error(detail || 'git checkpoint command failed.'));
    });
  });
}

function makeTempIndex(gitDir) {
  const realIndex = path.join(gitDir, 'index');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-cp-idx-'));
  const tmpIndex = path.join(tmpDir, 'index');
  if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex);
  return { tmpDir, tmpIndex };
}

// Captures a full workspace snapshot (tracked + untracked, excluding .shed/) as a hidden commit ref.
export async function captureCheckpoint(cwd, { label = '', sessionId = '', taskId = '', kind = 'turn' } = {}) {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const [gitDirRes, headRes, branchRes] = await Promise.all([
    runGit(root, ['rev-parse', '--absolute-git-dir'], { timeout: 4000 }),
    runGit(root, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1], timeout: 4000 }),
    runGit(root, ['branch', '--show-current'], { okCodes: [0, 1], timeout: 4000 }),
  ]);
  const gitDir = gitDirRes.stdout.trim();
  const head = headRes.code === 0 ? headRes.stdout.trim() : '';
  const branch = branchRes.stdout.trim();
  const { tmpDir, tmpIndex } = makeTempIndex(gitDir);
  try {
    const idxEnv = { GIT_INDEX_FILE: tmpIndex };
    await runGit(root, ['add', '-A'], { env: idxEnv, timeout: 30000 });
    await runGit(root, ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', '.shed'], { env: idxEnv, okCodes: [0, 1], timeout: 10000 });
    const tree = (await runGit(root, ['write-tree'], { env: idxEnv })).stdout.trim();
    if (!tree) return null;
    const id = `cp-${crypto.randomBytes(6).toString('hex')}`;
    const msg = `shed checkpoint (${kind}): ${String(label || 'snapshot').slice(0, 120)}`;
    const commitArgs = ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', msg];
    const commit = (await runGit(root, commitArgs, {
      env: {
        GIT_AUTHOR_NAME: 'Shed',
        GIT_AUTHOR_EMAIL: 'shed@local',
        GIT_COMMITTER_NAME: 'Shed',
        GIT_COMMITTER_EMAIL: 'shed@local',
      },
    })).stdout.trim();
    const ref = `refs/shed/checkpoints/${id}`;
    await runGit(root, ['update-ref', ref, commit]);
    return {
      id,
      ref,
      commit,
      tree,
      head,
      branch,
      root,
      cwd: root,
      sessionId,
      taskId,
      kind,
      label: String(label || 'Checkpoint').slice(0, 120),
      createdAt: new Date().toISOString(),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Rewinds the working tree to match a checkpoint commit's exact file tree, without moving HEAD.
// Removes extra untracked files (never touching .shed/) and leaves HEAD intact so git history is never rewritten.
export async function revertToCheckpoint(cwd, commitSha) {
  const root = await repoRoot(cwd);
  if (!root) throw new Error('This folder is not a git repository.');
  if (!/^[0-9a-f]{7,40}$/i.test(String(commitSha || ''))) throw new Error('Invalid checkpoint reference.');
  const verify = await runGit(root, ['cat-file', '-t', commitSha], { okCodes: [0, 1] });
  if (verify.code !== 0 || verify.stdout.trim() !== 'commit') throw new Error('That checkpoint is no longer in this git repository.');

  // Remove currently untracked files (excluding .shed/) so files created after the checkpoint are cleaned up.
  const untracked = (await runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
  for (const rel of untracked) {
    if (rel === '.shed' || rel.startsWith('.shed/')) continue;
    const full = path.resolve(root, rel);
    if (full.startsWith(path.resolve(root) + path.sep)) fs.rmSync(full, { recursive: true, force: true });
  }

  // Materialize the checkpoint's tree into the index and working tree, then reset the index back to HEAD (mixed).
  await runGit(root, ['read-tree', '--reset', '-u', commitSha], { timeout: 60000 });
  const hasHead = (await runGit(root, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1] })).code === 0;
  if (hasHead) await runGit(root, ['reset', '-q', 'HEAD'], { timeout: 30000 });
  else await runGit(root, ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '.'], { okCodes: [0, 1] });

  return { reverted: true, commit: commitSha, root };
}

// Summarizes changed files between two checkpoint commits (or between a checkpoint commit and current HEAD / another commit).
export async function checkpointChanges(cwd, fromCommit, toCommit = '') {
  const root = await repoRoot(cwd);
  if (!root) throw new Error('This folder is not a git repository.');
  const validSha = s => /^[0-9a-f]{7,40}$/i.test(String(s || ''));
  if (!validSha(fromCommit)) throw new Error('Invalid base checkpoint.');
  const target = toCommit ? (validSha(toCommit) ? toCommit : '') : '';
  if (toCommit && !target) throw new Error('Invalid target checkpoint.');

  let compareTo = target;
  let tempRef = '';
  if (!compareTo) {
    // Compare against live working tree by taking an ephemeral tree snapshot
    const snap = await captureCheckpoint(root, { label: 'diff-tmp', kind: 'ephemeral' });
    compareTo = snap?.commit || fromCommit;
    tempRef = snap?.ref || '';
  }
  try {
    const [nameStatus, numstatRes] = await Promise.all([
      runGit(root, ['diff', '--name-status', '-z', '-M', fromCommit, compareTo]),
      runGit(root, ['diff', '--numstat', '-z', '-M', fromCommit, compareTo]),
    ]);
    const stats = parseNumstat(numstatRes.stdout);
    const parts = nameStatus.stdout.split('\0');
    const files = [];
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i];
      if (!code) continue;
      if (code.startsWith('R') || code.startsWith('C')) {
        const oldPath = parts[++i], newPath = parts[++i];
        if (!newPath) continue;
        files.push({ path: newPath, oldPath, status: 'R', ...(stats.get(newPath) || { binary: false, additions: 0, deletions: 0 }) });
      } else {
        const filePath = parts[++i];
        if (!filePath) continue;
        files.push({ path: filePath, status: code[0], ...(stats.get(filePath) || { binary: false, additions: 0, deletions: 0 }) });
      }
    }
    return {
      from: fromCommit,
      to: target || 'working-tree',
      files,
      additions: files.reduce((s, f) => s + f.additions, 0),
      deletions: files.reduce((s, f) => s + f.deletions, 0),
    };
  } finally {
    if (tempRef) await runGit(root, ['update-ref', '-d', tempRef], { okCodes: [0, 1] }).catch(() => {});
  }
}

export async function checkpointFileDiff(cwd, fromCommit, toCommit, file) {
  const root = await repoRoot(cwd);
  if (!root) throw new Error('This folder is not a git repository.');
  const validSha = s => /^[0-9a-f]{7,40}$/i.test(String(s || ''));
  if (!validSha(fromCommit)) throw new Error('Invalid base checkpoint.');
  const target = toCommit && validSha(toCommit) ? toCommit : '';
  const summary = await checkpointChanges(root, fromCommit, target);
  const entry = summary.files.find(f => f.path === file);
  if (!entry) throw new Error('That file did not change in this checkpoint.');
  if (entry.binary) return { path: file, status: entry.status, binary: true, hunks: [] };

  let compareTo = target, tempRef = '';
  if (!compareTo) {
    const snap = await captureCheckpoint(root, { label: 'diff-tmp', kind: 'ephemeral' });
    compareTo = snap?.commit || fromCommit;
    tempRef = snap?.ref || '';
  }
  try {
    const args = ['diff', '--no-color', '--no-ext-diff', '-M', '-U3', fromCommit, compareTo, '--', ...(entry.oldPath ? [entry.oldPath] : []), file];
    const { stdout } = await runGit(root, args, { maxBuffer: MAX_DIFF * 4 });
    const truncated = stdout.length > MAX_DIFF;
    return { path: file, oldPath: entry.oldPath, status: entry.status, binary: false, truncated, hunks: parseUnifiedDiff(truncated ? stdout.slice(0, MAX_DIFF) : stdout) };
  } finally {
    if (tempRef) await runGit(root, ['update-ref', '-d', tempRef], { okCodes: [0, 1] }).catch(() => {});
  }
}

export function checkpointStore(dataDir) {
  const file = path.join(dataDir, 'checkpoints.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = []; }
  const save = () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(list.slice(0, KEEP_TOTAL), null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  };
  return {
    all: () => list,
    get: id => list.find(c => c.id === id) || null,
    forSession(sessionId, cwd = '') {
      return list.filter(c => (sessionId && c.sessionId === sessionId) || (cwd && c.root === cwd && !c.sessionId)).slice(0, KEEP_PER_SESSION);
    },
    forCwd(cwd) {
      return list.filter(c => c.root === cwd || c.cwd === cwd).slice(0, KEEP_PER_SESSION);
    },
    add(record) {
      if (!record) return null;
      // Avoid duplicate adjacent checkpoints with the exact same tree SHA for the same session & kind
      const prev = list.find(c => c.root === record.root && c.sessionId === record.sessionId);
      if (prev && prev.tree === record.tree && prev.kind === record.kind && prev.label === record.label) return prev;
      list.unshift(record);
      // Cap per-session entries
      const counts = new Map();
      list = list.filter(c => {
        const key = c.sessionId || c.root;
        const n = (counts.get(key) || 0) + 1;
        counts.set(key, n);
        return n <= KEEP_PER_SESSION;
      }).slice(0, KEEP_TOTAL);
      save();
      return record;
    },
    attachSession(taskId, sessionId) {
      if (!taskId || !sessionId) return false;
      let changed = false;
      for (const c of list) if (c.taskId === taskId && !c.sessionId) { c.sessionId = sessionId; changed = true; }
      if (changed) save();
      return changed;
    },
  };
}
