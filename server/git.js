import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Git for the session drawer: what changed, the diff of one file, and commit / push / pull request.
// Every command is a child process with a time limit, never a shell, and paths only come from git's own file list.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_FILES = 500, MAX_DIFF = 512 * 1024;

function run(cmd, args, cwd, { timeout = 8000, okCodes = [0], maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer, encoding:'utf8', env:{ ...process.env, GIT_TERMINAL_PROMPT:'0', GIT_OPTIONAL_LOCKS:'0', NO_COLOR:'1', GH_PROMPT_DISABLED:'1' } }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      if (okCodes.includes(code)) return resolve({ stdout, stderr, code });
      const detail = (stderr || stdout || error?.message || '').trim().split('\n').filter(Boolean).slice(-3).join(' ');
      reject(Object.assign(new Error(error?.killed ? `${cmd} took too long.` : detail || `${cmd} failed.`), { code }));
    });
  });
}
const git = (cwd, args, options) => run('git', args, cwd, options);

// `git status --porcelain=v2 --branch -z`: branch headers, then one record per changed path.
export function parseStatus(text) {
  const out = { branch:'', upstream:'', ahead:0, behind:0, oid:'', files:[] };
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    if (entry.startsWith('# branch.head ')) out.branch = entry.slice(14);
    else if (entry.startsWith('# branch.oid ')) out.oid = entry.slice(13);
    else if (entry.startsWith('# branch.upstream ')) out.upstream = entry.slice(18);
    else if (entry.startsWith('# branch.ab ')) { const m = entry.match(/\+(\d+) -(\d+)/); if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); } }
    else if (entry[0] === '1') { const f = entry.split(' '); out.files.push({ path:f.slice(8).join(' '), status:statusOf(f[1]) }); }
    else if (entry[0] === '2') { const f = entry.split(' '); out.files.push({ path:f.slice(9).join(' '), oldPath:parts[++i], status:'R' }); }
    else if (entry[0] === 'u') { const f = entry.split(' '); out.files.push({ path:f.slice(10).join(' '), status:'U' }); }
    else if (entry[0] === '?') out.files.push({ path:entry.slice(2), status:'?' });
  }
  return out;
}
// XY: index and work-tree state. A deletion or addition on either side wins over a plain modification.
function statusOf(xy) {
  if (xy.includes('D')) return 'D';
  if (xy.includes('A')) return 'A';
  if (xy.includes('R') || xy.includes('C')) return 'R';
  return 'M';
}
// `git diff --numstat -z`: "added\tdeleted\tpath\0", or for a rename "added\tdeleted\t\0old\0new\0". Binary files show "-".
export function parseNumstat(text) {
  const stats = new Map(), parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!m) continue;
    let file = m[3];
    if (!file) { i += 2; file = parts[i]; }
    stats.set(file, m[1] === '-' ? { binary:true, additions:0, deletions:0 } : { binary:false, additions:Number(m[1]), deletions:Number(m[2]) });
  }
  return stats;
}

// Unified diff → hunks of lines with their old and new line numbers, ready to draw.
export function parseUnifiedDiff(text) {
  const hunks = [];
  let hunk = null, o = 0, n = 0;
  for (const line of text.split('\n')) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (header) { hunk = { header:line, context:header[3].trim(), lines:[] }; hunks.push(hunk); o = Number(header[1]); n = Number(header[2]); continue; }
    if (!hunk) continue;
    if (line.startsWith('+')) hunk.lines.push({ t:'+', n:n++, text:line.slice(1) });
    else if (line.startsWith('-')) hunk.lines.push({ t:'-', o:o++, text:line.slice(1) });
    else if (line.startsWith(' ')) hunk.lines.push({ t:' ', o:o++, n:n++, text:line.slice(1) });
    else if (line.startsWith('\\')) hunk.lines.push({ t:'\\', text:line.slice(2) });
  }
  return hunks;
}

const isBinary = buffer => buffer.subarray(0, 8000).includes(0);
function countLines(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return { binary:!stat.isFile(), additions:0, deletions:0 };
    const buffer = fs.readFileSync(file);
    if (isBinary(buffer)) return { binary:true, additions:0, deletions:0 };
    const text = buffer.toString('utf8');
    return { binary:false, additions:text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0, deletions:0 };
  } catch { return { binary:false, additions:0, deletions:0 }; }
}

// A folder's repository root doesn't change, so it is looked up once (and again after a minute, in case it became one).
const roots = new Map();
export async function repoRoot(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return '';
  const hit = roots.get(cwd);
  if (hit && (hit.root ? fs.existsSync(hit.root) : Date.now() - hit.at < 60000)) return hit.root;
  let root = '';
  try { root = (await git(cwd, ['rev-parse', '--show-toplevel'], { timeout:3000 })).stdout.trim(); } catch {}
  roots.set(cwd, { root, at:Date.now() });
  return root;
}

// What changed in the session's folder compared with its last commit: branch, upstream, and every file with +/- counts.
export async function changes(cwd) {
  const root = await repoRoot(cwd);
  if (!root) return { repo:false };
  // All three at once. With no commit yet, `diff HEAD` fails and the counts are taken against the empty tree instead.
  const [status, head, againstHead] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
    git(root, ['log', '-1', '--format=%h%x00%s%x00%cI'], { okCodes:[0, 128] }),
    git(root, ['diff', 'HEAD', '--numstat', '-z', '-M'], { okCodes:[0, 128] }),
  ]);
  const parsed = parseStatus(status.stdout);
  const numstat = parseNumstat((againstHead.code === 0 ? againstHead : await git(root, ['diff', EMPTY_TREE, '--numstat', '-z', '-M'])).stdout);
  const files = parsed.files.slice(0, MAX_FILES).map(f => ({ ...f, ...(f.status === '?' ? countLines(path.join(root, f.path)) : numstat.get(f.path) || { binary:false, additions:0, deletions:0 }) }));
  const [sha, subject, date] = head.code === 0 ? head.stdout.trim().split('\0') : [];
  const result = {
    repo:true, root, branch:parsed.branch === '(detached)' ? '' : parsed.branch, detached:parsed.branch === '(detached)',
    upstream:parsed.upstream, ahead:parsed.ahead, behind:parsed.behind,
    head:sha ? { sha, subject, date } : null,
    files, more:Math.max(0, parsed.files.length - MAX_FILES),
    additions:files.reduce((sum, f) => sum + f.additions, 0), deletions:files.reduce((sum, f) => sum + f.deletions, 0),
  };
  recent.set(root, { at:Date.now(), result });
  return result;
}
// The file list a diff was picked from is at most a few seconds old, so a diff reuses it instead of asking git again.
const recent = new Map();
async function recentChanges(cwd) {
  const root = await repoRoot(cwd), hit = root && recent.get(root);
  return hit && Date.now() - hit.at < 5000 ? hit.result : changes(cwd);
}

// The diff of one changed file. The path must be one git itself reported as changed, so nothing else can be read.
export async function fileDiff(cwd, file) {
  let state = await recentChanges(cwd);
  if (!state.repo) throw new Error('This folder is not a git repository.');
  if (!state.files.some(f => f.path === file)) state = await changes(cwd);
  const entry = state.files.find(f => f.path === file);
  if (!entry) throw new Error('That file has no changes.');
  if (entry.binary) return { path:file, status:entry.status, binary:true, hunks:[] };
  const args = entry.status === '?'
    ? ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', file]
    : ['diff', state.head ? 'HEAD' : EMPTY_TREE, '--no-color', '--no-ext-diff', '-M', '-U3', '--', ...(entry.oldPath ? [entry.oldPath] : []), file];
  const { stdout } = await git(state.root, args, { okCodes:[0, 1], maxBuffer:MAX_DIFF * 4 });
  const truncated = stdout.length > MAX_DIFF;
  return { path:file, oldPath:entry.oldPath, status:entry.status, binary:false, truncated, hunks:parseUnifiedDiff(truncated ? stdout.slice(0, MAX_DIFF) : stdout) };
}

// Uploads Shed placed in the project stay out of commits.
function excludeShedFolder(root) {
  try {
    const exclude = path.join(root, '.git', 'info', 'exclude');
    if (!fs.statSync(path.join(root, '.git')).isDirectory()) return;
    const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!/^\.shed\/$/m.test(text)) fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}.shed/\n`);
  } catch { /* A linked worktree's .git is a file; its exclude lives in the main repository. */ }
}

export async function commitAll(cwd, message) {
  const subject = String(message || '').trim();
  if (!subject) throw new Error('Write a commit message first.');
  if (subject.length > 5000) throw new Error('That commit message is too long.');
  const root = await repoRoot(cwd);
  if (!root) throw new Error('This folder is not a git repository.');
  excludeShedFolder(root);
  await git(root, ['add', '-A'], { timeout:30000 });
  const staged = await git(root, ['diff', '--cached', '--quiet'], { okCodes:[0, 1] });
  if (staged.code === 0) throw new Error('There is nothing to commit.');
  await git(root, ['commit', '-m', subject, '--no-verify'], { timeout:60000 });
  const { stdout } = await git(root, ['log', '-1', '--format=%h%x00%s']);
  const [sha, title] = stdout.trim().split('\0');
  return { sha, subject:title };
}

export async function push(cwd) {
  const state = await changes(cwd);
  if (!state.repo) throw new Error('This folder is not a git repository.');
  if (!state.branch) throw new Error('This checkout is not on a branch, so there is nothing to push.');
  const remotes = (await git(state.root, ['remote'])).stdout.split('\n').filter(Boolean);
  if (!remotes.length) throw new Error('This repository has no remote to push to.');
  const remote = state.upstream ? state.upstream.split('/')[0] : remotes.includes('origin') ? 'origin' : remotes[0];
  await git(state.root, ['push', '-u', remote, `HEAD:refs/heads/${state.branch}`], { timeout:120000 });
  return { branch:state.branch, remote };
}

// Pull requests go through the GitHub CLI with the user's own login. Answers are cached briefly per branch, since
// gh talks to GitHub (~0.5-1 s) and the drawer asks often.
const prCache = new Map();
const PR_FIELDS = 'number,url,state,title,isDraft,reviewDecision,headRefName,baseRefName,statusCheckRollup';
export function summarizeChecks(rollup = []) {
  const checks = rollup.map(c => {
    const state = String(c.conclusion || c.state || c.status || '').toUpperCase();
    const result = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state) ? 'passed' : ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(state) ? 'failed' : 'pending';
    return { name:c.name || c.context || 'check', result, url:c.detailsUrl || c.targetUrl || '' };
  });
  return { total:checks.length, passed:checks.filter(c => c.result === 'passed').length, failed:checks.filter(c => c.result === 'failed'), pending:checks.filter(c => c.result === 'pending').length };
}
export async function pullRequest(cwd, { fresh = false } = {}) {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const branch = (await git(root, ['branch', '--show-current'])).stdout.trim();
  if (!branch) return null;
  const key = `${root}\0${branch}`, hit = prCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 20000) return hit.value;
  let value = null;
  try {
    const { stdout, code } = await run('gh', ['pr', 'view', branch, '--json', PR_FIELDS], root, { timeout:15000, okCodes:[0, 1] });
    if (code === 0) { const pr = JSON.parse(stdout); value = { number:pr.number, url:pr.url, state:pr.state, title:pr.title, draft:pr.isDraft, review:pr.reviewDecision || '', base:pr.baseRefName, branch:pr.headRefName, checks:summarizeChecks(pr.statusCheckRollup) }; }
  } catch (error) { if (/ENOENT|not found/i.test(error.message) && !/no pull requests/i.test(error.message)) value = { error:'Install the GitHub CLI (gh) and sign in to see pull requests.' }; }
  prCache.set(key, { at:Date.now(), value });
  return value;
}

export async function createPullRequest(cwd, { title, body = '', draft = false } = {}) {
  const root = await repoRoot(cwd);
  if (!root) throw new Error('This folder is not a git repository.');
  const heading = String(title || '').trim().slice(0, 250);
  if (!heading) throw new Error('Give the pull request a title.');
  const branch = (await git(root, ['branch', '--show-current'])).stdout.trim();
  const { stdout } = await run('gh', ['pr', 'create', '--title', heading, '--body', String(body).slice(0, 60000), '--head', branch, ...(draft ? ['--draft'] : [])], root, { timeout:60000 });
  prCache.delete(`${root}\0${branch}`);
  const url = stdout.trim().split('\n').filter(line => /^https?:\/\//.test(line)).pop() || stdout.trim();
  return { url };
}

// The end of the logs of the checks that failed on this branch's pull request, for handing to the agent.
export async function failedCheckLogs(cwd, { maxLines = 120 } = {}) {
  const pr = await pullRequest(cwd, { fresh:true });
  if (!pr || pr.error) throw new Error(pr?.error || 'This branch has no pull request.');
  const failed = pr.checks.failed;
  if (!failed.length) throw new Error('No checks have failed.');
  const runIds = [...new Set(failed.map(c => c.url.match(/\/actions\/runs\/(\d+)/)?.[1]).filter(Boolean))].slice(0, 3);
  const root = await repoRoot(cwd), logs = [];
  for (const id of runIds) {
    try {
      const { stdout } = await run('gh', ['run', 'view', id, '--log-failed'], root, { timeout:30000, maxBuffer:32 * 1024 * 1024 });
      logs.push(stdout.trim().split('\n').slice(-maxLines).join('\n'));
    } catch (error) { logs.push(`(Could not read the log for run ${id}: ${error.message})`); }
  }
  return { pr, failed, logs };
}

// A new session in a git project gets a branch of its own in its own checkout (git worktree), so agents working on
// the same repository at the same time never change each other's files. Branched from the project's current commit.
export async function sessionWorktree(projectDir, label, { home = os.homedir() } = {}) {
  const root = await repoRoot(projectDir);
  if (!root) return null;
  const [gitDir, common, headOk] = await Promise.all([
    git(root, ['rev-parse', '--absolute-git-dir']).then(r => r.stdout.trim()),
    git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then(r => r.stdout.trim()),
    git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes:[0, 1] }).then(r => r.code === 0),
  ]);
  // Already a session's own checkout, or a repository with no commit yet to branch from: the session works in place.
  if (gitDir !== common || !headOk) return null;
  const words = String(label || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w.length > 1).slice(0, 5);
  const slug = words.join('-').slice(0, 40).replace(/-+$/, '') || 'session';
  const repo = path.basename(root).replace(/[^\w.-]/g, '-');
  const base = path.join(home, 'Shed Workspaces', 'branches');
  fs.mkdirSync(base, { recursive:true });
  let name = slug, folder;
  for (let n = 2; ; n++) {
    folder = path.join(base, `${repo}-${name}`);
    const taken = fs.existsSync(folder) || (await git(root, ['rev-parse', '--verify', '-q', `refs/heads/shed/${name}`], { okCodes:[0, 1] })).code === 0;
    if (!taken) break;
    name = `${slug}-${n}`;
  }
  const branch = `shed/${name}`;
  await git(root, ['worktree', 'add', '-b', branch, folder, 'HEAD'], { timeout:120000 });
  return { path:folder, branch, project:root };
}
