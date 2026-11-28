import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseStatus, parseNumstat, parseUnifiedDiff, summarizeChecks, changes, fileDiff, commitAll, discardFile, sessionWorktree, listWorktrees, mergeWorktree, removeWorktree } from '../server/git.js';

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shed-git-')));
  const g = (...args) => execFileSync('git', args, { cwd:dir, encoding:'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'test@example.com'); g('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'app.js'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(dir, 'old name.txt'), 'kept\n');
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'bye\n');
  g('add', '-A'); g('commit', '-q', '-m', 'first');
  return { dir, g };
}

test('reads git status records, including renames and paths with spaces', () => {
  const text = ['# branch.oid abc123', '# branch.head shed/fix-login', '# branch.upstream origin/shed/fix-login', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/app.js', '2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt', 'old name.txt',
    '1 D. N... 100644 000000 000000 aaa 000 gone.txt', '? notes/todo list.md', ''].join('\0');
  const s = parseStatus(text);
  assert.equal(s.branch, 'shed/fix-login'); assert.equal(s.upstream, 'origin/shed/fix-login');
  assert.deepEqual([s.ahead, s.behind], [2, 1]);
  assert.deepEqual(s.files, [{ path:'src/app.js', status:'M' }, { path:'new name.txt', oldPath:'old name.txt', status:'R' }, { path:'gone.txt', status:'D' }, { path:'notes/todo list.md', status:'?' }]);
});

test('reads numstat counts, binary files and renames', () => {
  const stats = parseNumstat(['3\t1\tsrc/app.js', '-\t-\tlogo.png', '0\t0\t', 'old.txt', 'new.txt', ''].join('\0'));
  assert.deepEqual(stats.get('src/app.js'), { binary:false, additions:3, deletions:1 });
  assert.equal(stats.get('logo.png').binary, true);
  assert.deepEqual(stats.get('new.txt'), { binary:false, additions:0, deletions:0 });
});

test('turns a unified diff into numbered lines', () => {
  const hunks = parseUnifiedDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@ function main()\n one\n-two\n+TWO\n three\n\\ No newline at end of file\n');
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].context, 'function main()');
  assert.deepEqual(hunks[0].lines.slice(0, 4), [{ t:' ', o:1, n:1, text:'one' }, { t:'-', o:2, text:'two' }, { t:'+', n:2, text:'TWO' }, { t:' ', o:3, n:3, text:'three' }]);
});

test('sums up pull request checks', () => {
  const s = summarizeChecks([{ name:'test', conclusion:'FAILURE', detailsUrl:'https://github.com/o/r/actions/runs/42/job/7' }, { name:'lint', conclusion:'SUCCESS' }, { context:'deploy', state:'PENDING' }]);
  assert.equal(s.total, 3); assert.equal(s.passed, 1); assert.equal(s.pending, 1);
  assert.deepEqual(s.failed.map(c => c.name), ['test']);
});

test('lists changes with counts, shows a file diff, commits, and never reads a file git did not report', async () => {
  const { dir, g } = repo();
  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'one\nTWO\nthree\nfour\n');
    fs.rmSync(path.join(dir, 'gone.txt'));
    fs.writeFileSync(path.join(dir, 'new file.md'), 'a\nb\n');
    fs.writeFileSync(path.join(dir, 'image.bin'), Buffer.from([0, 1, 2, 3]));
    g('mv', 'old name.txt', 'renamed.txt');
    const state = await changes(dir);
    assert.equal(state.repo, true); assert.equal(state.branch, 'main'); assert.equal(state.head.subject, 'first');
    const by = Object.fromEntries(state.files.map(f => [f.path, f]));
    assert.deepEqual([by['app.js'].status, by['app.js'].additions, by['app.js'].deletions], ['M', 2, 1]);
    assert.equal(by['gone.txt'].status, 'D');
    assert.deepEqual([by['new file.md'].status, by['new file.md'].additions], ['?', 2]);
    assert.equal(by['image.bin'].binary, true);
    assert.deepEqual([by['renamed.txt'].status, by['renamed.txt'].oldPath], ['R', 'old name.txt']);

    const diff = await fileDiff(dir, 'app.js');
    assert.deepEqual(diff.hunks[0].lines.filter(l => l.t !== ' ').map(l => `${l.t}${l.text}`), ['-two', '+TWO', '+four']);
    const untracked = await fileDiff(dir, 'new file.md');
    assert.deepEqual(untracked.hunks[0].lines.map(l => `${l.t}${l.text}`), ['+a', '+b']);
    await assert.rejects(fileDiff(dir, '../../etc/hosts'), /no changes/);

    fs.mkdirSync(path.join(dir, '.shed', 'uploads'), { recursive:true });
    fs.writeFileSync(path.join(dir, '.shed', 'uploads', 'clip.mp4'), 'x');
    const commit = await commitAll(dir, 'Fix the login form');
    assert.equal(commit.subject, 'Fix the login form');
    assert.equal((await changes(dir)).files.length, 0, 'everything but .shed/ was committed');
    assert.doesNotMatch(g('show', '--name-only', '--format='), /\.shed/);
    await assert.rejects(commitAll(dir, 'again'), /nothing to commit/);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('a new session gets its own branch and checkout, and a second one does not reuse it', async () => {
  const { dir, g } = repo();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shed-home-')));
  try {
    const first = await sessionWorktree(dir, 'Fix the flaky login test', { home });
    assert.equal(first.branch, 'shed/fix-the-flaky-login-test');
    assert.equal(first.path, path.join(home, 'Shed Workspaces', 'branches', `${path.basename(dir)}-fix-the-flaky-login-test`));
    assert.equal(fs.readFileSync(path.join(first.path, 'app.js'), 'utf8'), 'one\ntwo\nthree\n');
    const second = await sessionWorktree(dir, 'Fix the flaky login test', { home });
    assert.equal(second.branch, 'shed/fix-the-flaky-login-test-2');
    assert.equal(await sessionWorktree(first.path, 'nested', { home }), null, 'a session checkout is not branched again');
    assert.match(g('worktree', 'list'), /shed\/fix-the-flaky-login-test-2/);
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shed-plain-')));
    assert.equal(await sessionWorktree(empty, 'not a repo', { home }), null);
    fs.rmSync(empty, { recursive:true, force:true });
  } finally { fs.rmSync(dir, { recursive:true, force:true }); fs.rmSync(home, { recursive:true, force:true }); }
});

test('discardFile restores modified/deleted files and removes untracked files, rejecting non-changed paths', async () => {
  const { dir } = repo();
  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'changed\n');
    fs.rmSync(path.join(dir, 'gone.txt'));
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'temp\n');

    await discardFile(dir, 'app.js');
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), 'one\ntwo\nthree\n');

    await discardFile(dir, 'gone.txt');
    assert.equal(fs.readFileSync(path.join(dir, 'gone.txt'), 'utf8'), 'bye\n');

    await discardFile(dir, 'scratch.txt');
    assert.equal(fs.existsSync(path.join(dir, 'scratch.txt')), false);

    assert.equal((await changes(dir)).files.length, 0);
    await assert.rejects(discardFile(dir, 'app.js'), /no changes/);
    await assert.rejects(discardFile(dir, '../../etc/hosts'), /no changes/);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('worktrees support suffix, listing, local merge, dirty protection, conflict abort, and removal', async () => {
  const { dir, g } = repo();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shed-wt-ops-')));
  try {
    const wt = await sessionWorktree(dir, 'Add feature', { home, suffix:'claude' });
    assert.equal(wt.branch, 'shed/add-feature-claude');
    assert.equal((await changes(wt.path)).worktree, true);
    assert.equal((await changes(dir)).worktree, false);

    // Dirty worktree cannot be removed without force or merged before commit
    fs.writeFileSync(path.join(wt.path, 'feature.js'), 'export const ok = true;\n');
    await assert.rejects(removeWorktree(wt.path, { home }), /uncommitted change/);
    await assert.rejects(mergeWorktree(wt.path, { home }), /uncommitted changes/);

    const listedDirty = await listWorktrees({ home });
    assert.equal(listedDirty.length, 1);
    assert.equal(listedDirty[0].dirty, true);
    assert.equal(listedDirty[0].merged, false);

    await commitAll(wt.path, 'Add feature module');
    const merged = await mergeWorktree(wt.path, { home, removeAfter:true });
    assert.equal(merged.merged, true);
    assert.equal(merged.target, 'main');
    assert.equal(fs.existsSync(path.join(dir, 'feature.js')), true);
    assert.equal(fs.existsSync(wt.path), false, 'worktree removed after merge');
    assert.equal((await listWorktrees({ home })).length, 0);

    // Conflicting merge aborts cleanly and leaves main repo untouched
    const wt2 = await sessionWorktree(dir, 'Conflict test', { home, suffix:'codex' });
    fs.writeFileSync(path.join(wt2.path, 'app.js'), 'branch change\n');
    await commitAll(wt2.path, 'Branch edit');
    fs.writeFileSync(path.join(dir, 'app.js'), 'main change\n');
    g('add', '-A'); g('commit', '-q', '-m', 'Main edit');
    await assert.rejects(mergeWorktree(wt2.path, { home }), /Merge conflicts in: app\.js/);
    assert.equal((await changes(dir)).files.length, 0, 'main repo stays clean after conflict abort');

    // Force-remove works and refuses paths outside Shed Workspaces/branches
    await assert.rejects(removeWorktree(dir, { home, force:true }), /Only Shed branch worktrees/);
    const rm = await removeWorktree(wt2.path, { home, force:true, deleteBranch:true });
    assert.equal(rm.branchDeleted, true);
    assert.equal(fs.existsSync(wt2.path), false);
  } finally {
    fs.rmSync(dir, { recursive:true, force:true });
    fs.rmSync(home, { recursive:true, force:true });
  }
});
